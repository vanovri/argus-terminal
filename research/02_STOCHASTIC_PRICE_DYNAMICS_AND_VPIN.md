---
title: "Note 02: Simulated Price Dynamics, Order-Arrival Models, VPIN-Style Toxicity & Chart Indicators"
note_id: "NOTE-02"
captured_at: "2026-10-24T07:56:00Z"
author: "Argus Terminal project notes (AI-assisted draft, checked against the code)"
source_files:
  - "src/engine/marketSim.js"
  - "src/engine/orderbook.js"
  - "src/engine/quantRisk.js"
  - "src/db/database.js"
  - "public/js/charts.js"
---

# Note 02: Simulated Price Dynamics, Order-Arrival Models, VPIN-Style Toxicity & Chart Indicators

> Study notes written with AI assistance. Statements about Argus code were checked against the source at the time of writing; the literature sections are background, not a description of what is implemented.

Argus Terminal is an educational, local-only simulation; all market data is simulated. Each section separates **Background theory** from **What Argus implements**. Line numbers refer to the source at the time of writing and may drift.

---

## 1. Price Process

### 1.1 Background theory: GBM and Ornstein–Uhlenbeck mean reversion
Geometric Brownian motion, $dS_t = \mu S_t\,dt + \sigma S_t\,dW_t$, has $\text{Var}(\ln S_t) = \sigma^2 t$, which grows without bound. A mean-reverting alternative is an Ornstein–Uhlenbeck-type drift toward a level $\theta$ (as in Vasicek, 1977, for interest rates), e.g.
$$\frac{dS_t}{S_t} = \kappa \left(\frac{\theta - S_t}{\theta}\right) dt + \sigma \, dW_t$$
with reversion speed $\kappa$, volatility $\sigma$ and Wiener process $W_t$.

### 1.2 What Argus implements: a tick-grid random walk with a weak pull toward the base price
Argus does **not** discretize the SDE above (there is no Gaussian noise, no proportional volatility, and no Euler–Maruyama step). In `MarketSimulator.step()` (`src/engine/marketSim.js:298-398`; price logic at lines 312-319), for every symbol on every simulator tick (default 400 ms, `src/server/index.js:68`):

```javascript
const reversionPull = (state.basePrice - state.lastPrice) / state.basePrice;
const shock = (Math.random() - 0.498 + reversionPull * 0.15) * 2.2;
const tickDelta = Math.round(shock) * state.tickSize;
const targetMid = Math.max(
  state.tickSize * 5,
  roundToTick(state.lastPrice + tickDelta, state.tickSize)
);
```

With $U_t \sim \text{Uniform}(0,1)$ and $r_t = (\theta - S_t)/\theta$, where $\theta$ = `basePrice` and $S_t$ = `lastPrice`:
$$\xi_t = 2.2\bigl((U_t - 0.498) + 0.15\, r_t\bigr), \qquad \Delta N_t = \text{Math.round}(\xi_t)$$
- Near the base price ($r_t \approx 0$), $\xi_t \in [-1.096, 1.104)$, so $\Delta N_t \in \{-1, 0, +1\}$ with probabilities ≈ 0.271 / 0.455 / 0.275. (A −2 step needs the price to be more than ≈ 2.2× base; +2 is not reachable since $r_t < 1$.)
- The `- 0.498` offset gives a small upward bias (≈ +0.004 ticks per step); the reversion term shifts the mean by ≈ $0.3\, r_t$ ticks per step. These balance at about $r_t \approx -0.013$, i.e. the walk drifts toward ≈ 1.3% **above** `basePrice`, not exactly to it. The pull is measured in ticks, so it is very weak relative to the price: e.g. for BTC-USD (tick 0.50 on 94,500) a 1% deviation produces only ≈ 0.003 ticks of drift per step.
- `targetMid` does not set the price directly. It only re-centers the synthetic quotes (`_maintainBookAroundMid`, lines 400-459). The displayed price is the **last trade price**, which only changes when an order fills.

**Synthetic trades.** On each tick, only two symbol indices trade: `activeIdx1 = tickCount % n` and `activeIdx2 = (tickCount * 3 + 1) % n` (lines 304-305). With 6 symbols, `activeIdx2` alternates between indices 1 and 4, so those two symbols trade much more often than the others; when the two indices coincide only one trade occurs. The taker side is `shock >= 0 ? 'BUY' : 'SELL'`, and size is `lotSize × (1 + floor(U·8))`, i.e. 1–8 lots, sent as a synthetic MARKET order (lines 325-338). Because a BUY lifts the ask at about `targetMid + tick` and a SELL hits the bid at about `targetMid − tick`, the last-trade price typically moves by ±1 or ±2 ticks per synthetic trade (a bid–ask bounce in the direction of the shock), with a mean of roughly $0.008 + 0.6\, r_t$ ticks per trade. These numbers are derived from the code, not measured.

### 1.3 What Argus implements: seeded history with a linear end-point correction (`seedDatabase`)
On a fresh database (`seedDatabase` returns early if instruments already exist), 120 one-minute candles per instrument are generated (`src/db/database.js:199-238`) using a deterministic LCG (`createPrng`, lines 62-68):
$$X_{n+1} = (1664525 \cdot X_n + 1013904223) \bmod 2^{32}, \qquad u_{n+1} = \frac{X_{n+1}}{2^{32}} \in [0, 1)$$
seeded with `9001 + idx * 7919`.
1. A forward walk starts at $0.992 \cdot S_{\text{base}}$ with uniform increments `(u - 0.492) * 0.0028 * base_price` per bar (close floored at 10 ticks).
2. With $\Delta_{\text{end}} = S_{\text{base}} - C_{119}^{\text{raw}}$, a linear correction is added:
$$O_i = \text{roundToTick}\!\left(O_i^{\text{raw}} + \tfrac{i}{120}\Delta_{\text{end}}\right), \qquad C_i = \text{roundToTick}\!\left(C_i^{\text{raw}} + \tfrac{i+1}{120}\Delta_{\text{end}}\right)$$
   and the last close is set explicitly to `base_price` (`i === 119 ? inst.base_price : ...`).
3. Highs/lows add random wicks of 0.05%–0.23% of the base price; volumes are random.

This is the same linear "pinning" step used to turn a random walk into a discrete bridge, but the increments are uniform rather than Gaussian, so it is a bridge-like construction rather than a Brownian bridge.

---

## 2. Order-Arrival Models

### 2.1 Background theory: Hawkes (1971) self-exciting processes
Trade arrivals in real markets cluster in time. A univariate Hawkes process with exponential kernel has conditional intensity
$$\lambda^*(t) = \mu_0 + \sum_{t_k < t} \alpha e^{-\beta (t - t_k)}$$
with baseline $\mu_0 > 0$, jump size $\alpha \ge 0$ and decay $\beta$. If the branching ratio $n^* = \alpha/\beta < 1$, the process is stationary with mean intensity $\mu_0 / (1 - \alpha/\beta)$. See Bacry, Mastromatteo & Muzy (2015) for a survey of financial applications.

### 2.2 What Argus implements: no Hawkes process
Argus has **no** Hawkes or Poisson arrival model. Synthetic order flow is:
- **Clock-driven and deterministic in timing:** one `setInterval` tick (default 400 ms), with the active symbols chosen by the fixed rotation described in §1.2.
- **No self-excitation:** the taker side depends on the current tick's `shock`, which is drawn independently each tick (apart from the weak reversion term), so trade signs are not autocorrelated.
- **Uniform sizes:** 1–8 lots.
- **News wire:** every 25 ticks (≈ 10 s at 400 ms) a headline from `BREAKING_TEMPLATES` (`src/engine/marketSim.js:118-167`) is emitted in rotation (lines 375-397). Headlines are display-only and do not affect prices, arrival rates or order flow.

---

## 3. Order-Flow Toxicity: PIN, VPIN and the Argus Proxy

### 3.1 Background theory: PIN (Easley et al., 1996) and VPIN (Easley, López de Prado & O'Hara, 2012)
The Probability of Informed Trading is
$$\text{PIN} = \frac{\alpha \mu}{\alpha \mu + 2\epsilon}$$
with $\alpha$ the probability of an information event, $\mu$ the informed arrival rate and $\epsilon$ the uninformed arrival rate per side, estimated by maximum likelihood.

VPIN works in volume time:
1. Split the trade stream into buckets of equal volume $V$ (the original paper sizes buckets as a fraction of average daily volume).
2. In each bucket $\tau$, classify volume as buy ($V_\tau^B$) or sell ($V_\tau^S$); the original uses bulk volume classification from price changes.
3. Average the absolute imbalance over a rolling window of $n$ buckets:
$$\text{VPIN} = \frac{\sum_{\tau=1}^n \bigl| V_\tau^B - V_\tau^S \bigr|}{n \cdot V}$$

### 3.2 What Argus implements: a simplified VPIN-style proxy
`computeMicrostructureAlpha` (`src/engine/quantRisk.js:350`; toxicity at lines 380-454) computes **a simplified proxy inspired by VPIN; it is not the Easley–López de Prado–O'Hara bucketed estimator**:
- **Sample:** `SELECT price, size, side, timestamp FROM trades WHERE symbol = ? ORDER BY timestamp ASC LIMIT 120`. This selects the **oldest** 120 trades for the symbol (seed trades plus the earliest simulated fills, since synthetic fills are persisted). Once a symbol has more than 120 trades, the value no longer reflects recent flow.
- **Classification:** the stored aggressor `side` from `Orderbook.submitOrder` is used directly (no tick rule or bulk classification).
- **Buckets:** bucket size is `totalVolume / 10` of that sample, so the sample is cut into 10 equal-volume buckets. There is no fixed bucket size and no rolling window. The value is $\sum |V^B_\tau - V^S_\tau| / (\text{completed} \cdot V)$.
- **Fallbacks:** if no bucket completes, it uses $|V^B - V^S| / V_{\text{total}}$; with fewer than 4 trades it uses the heuristic `min(0.85, max(0.12, |OBI| * 0.65 + 0.18))`, where OBI is a blended order-book imbalance from the current snapshot. The initial default is `0.28`.
- **Regime labels:** `< 0.25` LOW, `< 0.45` NORMAL, `< 0.65` ELEVATED, otherwise TOXIC. These thresholds are arbitrary, not calibrated.

### 3.3 A simple imbalance query in the SQL console
The `trades` table (`id, symbol, price, size, side, maker_order_id, taker_order_id, timestamp`) can be queried through the read-only SQL console (`POST /api/sql`, single `SELECT` statements only). The query below gives the **whole-sample absolute imbalance ratio** per symbol. It is a single-bucket statistic, not VPIN:

```sql
SELECT
  symbol,
  ROUND(SUM(CASE WHEN side = 'BUY' THEN size ELSE 0 END), 4) AS buy_vol,
  ROUND(SUM(CASE WHEN side = 'SELL' THEN size ELSE 0 END), 4) AS sell_vol,
  ROUND(ABS(SUM(CASE WHEN side = 'BUY' THEN size ELSE -size END)) / NULLIF(SUM(size), 0), 4) AS abs_imbalance_ratio
FROM trades
GROUP BY symbol
ORDER BY abs_imbalance_ratio DESC
```

---

## 4. VWAP and EMA

### 4.1 What Argus implements: running ticker VWAP (`MarketSimulator._recordTradeMetrics`)
In `src/engine/marketSim.js:461-468`, each simulated or externally recorded fill $(p_k, q_k)$ updates running totals in $O(1)$:
$$V_k = V_{k-1} + q_k, \qquad N_k = N_{k-1} + p_k q_k, \qquad \text{VWAP}_k = \text{roundToTick}\!\left(\frac{N_k}{V_k}\right)$$
The totals start from hard-coded baseline values (`baseVolumes` and a notional derived from the base and open prices, lines 219-249) and are never expired. Despite the `volume24h` / `notional24h` names, this is a cumulative-since-start figure, not a rolling 24-hour window.

### 4.2 What Argus implements: chart overlays (`ArgusChartEngine._computeIndicators`)
`public/js/charts.js:250-278` computes three series over the loaded candle array. **The full series is recomputed from scratch, $O(n)$, on every update** (`setCandles`, `updateLiveCandle` and `updateLiveTickPrice` all call it; the live array is capped at 240 candles). It is not an incremental $O(1)$ update.

1. **EMA(9) and EMA(21).** $\alpha_m = 2/(m+1)$ (0.2 and ≈ 0.0909), seeded with the first close, then
   $$\text{EMA}_m(i) = \alpha_m C_i + (1 - \alpha_m)\,\text{EMA}_m(i - 1)$$
2. **Cumulative VWAP over the loaded candles (`this.vwapSeries`).** Typical price $P_i^{\text{typ}} = (H_i + L_i + C_i)/3$, volume floored at $10^{-4}$:
   $$\text{VWAP}(i) = \frac{\sum_{j \le i} P_j^{\text{typ}} \tilde{V}_j}{\sum_{j \le i} \tilde{V}_j}, \qquad \tilde{V}_j = \max(10^{-4}, V_j)$$
   It is anchored at the first loaded candle, not at a trading-session open.

---

## 5. References

1. Vasicek, O. (1977). *An Equilibrium Characterization of the Term Structure.* Journal of Financial Economics, 5(2), 177–188. https://doi.org/10.1016/0304-405X(77)90016-2
2. Hawkes, A. G. (1971). *Spectra of Some Self-Exciting and Mutually Exciting Point Processes.* Biometrika, 58(1), 83–90. https://doi.org/10.1093/biomet/58.1.83
3. Bacry, E., Mastromatteo, I., & Muzy, J.-F. (2015). *Hawkes Processes in Finance.* Market Microstructure and Liquidity, 1(1), 1550005.
4. Easley, D., Kiefer, N. M., O'Hara, M., & Paperman, J. B. (1996). *Liquidity, Information, and Infrequently Traded Stocks.* The Journal of Finance, 51(4), 1405–1436.
5. Easley, D., López de Prado, M. M., & O'Hara, M. (2012). *Flow Toxicity and Liquidity in a High-Frequency World.* The Review of Financial Studies, 25(5), 1457–1493. https://doi.org/10.1093/rfs/hhs053
