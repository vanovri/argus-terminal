---
title: "Note 01: Limit Order Book Microstructure, Price-Time Priority (FIFO) Matching & Market Impact"
note_id: "NOTE-01"
captured_at: "2026-10-24T07:56:00Z"
author: "Argus Terminal project notes (AI-assisted draft, checked against the code)"
source_files:
  - "src/engine/orderbook.js"
  - "src/engine/marketSim.js"
  - "src/engine/slabOrderbook.js"
  - "src/engine/quantRisk.js"
  - "src/db/database.js"
  - "public/js/charts.js"
---

# Note 01: Limit Order Book Microstructure, Price-Time Priority (FIFO) Matching & Market Impact

> Study notes written with AI assistance. Statements about Argus code were checked against the source at the time of writing; the literature sections are background, not a description of what is implemented.

Argus Terminal is an educational, local-only simulation. All prices, quotes and trades are simulated. Each section below is split into **Background theory** (textbook / literature material) and **What Argus implements** (checked against the source). Line numbers refer to the source at the time of writing and may drift.

---

## 1. Limit Order Book (LOB) State

### Background theory
In a continuous double auction (e.g. NASDAQ, CME Globex), the limit order book at time $t$ is the set of resting limit orders, split into bids $\mathcal{B}_t$ and asks $\mathcal{A}_t$. An order can be written as
$$o_i = \bigl(\text{id}_i, \text{acc}_i, s_i, p_i, q_i^{\text{orig}}, q_i^{\text{rem}}, \tau_i, \nu_i\bigr)$$
with side $s_i$, limit price $p_i$ on a tick grid $\delta$, original and remaining quantity, arrival time $\tau_i$ and a sequence number $\nu_i$ used to break timestamp ties.

Top-of-book quantities:
$$p_t^B = \max_{o_i \in \mathcal{B}_t} p_i, \qquad p_t^A = \min_{o_j \in \mathcal{A}_t} p_j, \qquad S_t = p_t^A - p_t^B, \qquad M_t = \frac{p_t^B + p_t^A}{2}$$
In a real matching engine the resting book is uncrossed ($p_t^B < p_t^A$): any incoming order that crosses is executed before its remainder rests.

### What Argus implements
- `Orderbook` (`src/engine/orderbook.js:13-31`) stores every resting order as a JS object in two arrays, `this.bids` and `this.asks` (order-level / L3 data). Fields used: `id`, `accountId`, `side`, `price`, `size`, `filledSize`, `remainingSize`, `createdAt` (ms), `_seq` (per-book counter), `isSynthetic`.
- Prices are snapped to the tick grid with `roundToTick` (`src/db/database.js:57-60`): `Math.round(price * (1/tickSize)) / (1/tickSize)`, i.e.
  $$\text{roundToTick}(p, \delta) = \frac{\lfloor p \cdot \delta^{-1} + 0.5 \rfloor}{\delta^{-1}}$$
  Sizes are **not** snapped to `lotSize`; they are rounded to 4–6 decimal places with `toFixed`.
- `getSnapshot(depth)` (`src/engine/orderbook.js:469-509`) aggregates orders into price levels and returns `spread = max(0, bestAsk - bestBid)` and `midPrice = roundToTick((bestBid + bestAsk)/2, tickSize/2)`. If a side is empty it falls back to `lastPrice ± tickSize`. The spread is clamped at 0, not guaranteed to be ≥ one tick.
- Incoming orders in `submitOrder` are matched before resting, so the submit path itself does not leave a crossed book. However, the simulator inserts synthetic quotes directly via `_insertResting` without matching (see §4), so a user limit order resting through the simulator's target mid can leave the book temporarily crossed. Uncrossedness is not enforced as an invariant.

---

## 2. Price-Time Priority (FIFO) vs. Pro-Rata

### 2.1 What Argus implements: price-time priority
`Orderbook._insertResting` (`src/engine/orderbook.js:88-106`) assigns `_seq`, pushes the order, then **re-sorts the whole side array** with this comparator:
1. Price: bids descending (`b.price - a.price`), asks ascending (`a.price - b.price`).
2. Time: earlier `createdAt` first (`a.createdAt - b.createdAt`).
3. Tie-break: lower `_seq` first.

Note that `createdAt` can be supplied by the caller (`params.createdAt` in `submitOrder`, line 170) and seeded quotes use back-dated timestamps, so "time" priority is by the stored `createdAt`, not strictly by arrival order.

`submitOrder` (`src/engine/orderbook.js:108-262`; matching loop at lines 174-224) walks the opposite array from the best order:
- A LIMIT order matches while it crosses (`incoming.price >= resting.price` for a buy, `<=` for a sell). A MARKET order matches unconditionally (`type === 'MARKET'`).
- Fill size: $\Delta q_j = \min\bigl(Q_{\text{in}}^{\text{rem}}, q_{(j)}^{\text{rem}}\bigr)$.
- Fill price is the resting (maker) order's price, `matchPrice = resting.price`. An aggressive limit order priced through the book therefore receives the better resting price.
- Fully filled resting orders are removed with `splice`.
- A LIMIT remainder is rested via `_insertResting`. A MARKET remainder is discarded (IOC-like); a partially filled MARKET order is still reported with status `FILLED` (line 232), and an unfilled one as `CANCELLED`.
- For non-synthetic orders there is a simple pre-trade check: notional ≤ 5 × `cash_balance` (lines 141-156).
- No self-trade prevention is implemented.

### 2.2 Background theory: pro-rata allocation (not implemented in Argus)
Some interest-rate futures and options venues allocate an incoming quantity $Q_{\text{in}}$ across the $m$ orders at the best price in proportion to displayed size, often combined with a top-order or FIFO component:
$$\Delta q_j^{\text{ProRata}} = \left\lfloor Q_{\text{in}} \cdot \frac{q_j^{\text{rem}}}{\sum_{k=1}^m q_k^{\text{rem}}} \right\rfloor_{\ell}$$
with the rounding remainder allocated by a secondary rule. Argus has no pro-rata mode.

### 2.3 Comparison (background, plus Argus complexity)

| Dimension | Price-time priority (FIFO) | Pro-rata |
|---|---|---|
| Queue incentive | Rewards being early at a price level. | Rewards posting larger size (encourages over-quoting). |
| Adverse selection | Orders at the back of a queue are filled mainly when a large order sweeps the whole level. | All orders at the best price share small and large fills proportionally. |
| Typical tick regime | Common where the tick is small relative to price. | Used on some large-tick contracts where the spread is usually one tick. |

**Complexity in Argus (as written):**

| Operation | `Orderbook` (`orderbook.js`, used by the live server) | `SlabOrderbook` (`slabOrderbook.js`, benchmark/metrics only) |
|---|---|---|
| Insert resting order | `push` + full `Array.prototype.sort` → $O(N \log N)$ per insert (often faster on nearly sorted input, but not guaranteed) | Walk a single doubly linked list of orders from head or tail (O(1) fast paths when the price is a new best or worst) → $O(N)$ worst case |
| Match $K$ orders | $O(K)$ walk, plus $O(N)$ per `splice` of a filled order | $O(K)$ unlinks from the list head |
| Cancel | `findIndex` + `splice` → $O(N)$ (`orderbook.js:447-467`) | $O(1)$ via `idToSlot` lookup + list unlink (`slabOrderbook.js:493-537`) |

Neither implementation uses a price-level tree (e.g. red-black tree + per-level FIFO lists); `SlabOrderbook` is a single price-ordered linked list of orders. `SlabOrderbook` is not wired into the live matching path; it is used by `benchmarks/matching_bench.js` and to produce metrics for an API endpoint. For measured performance see [`../BENCHMARK_REPORT.md`](../BENCHMARK_REPORT.md); no speedup figures are claimed in this note.

---

## 3. L1 / L2 / L3 Market Data

### Background theory
- **L1 (top of book):** best bid/ask and last trade.
- **L2 (market-by-price):** aggregated size per price level $Q(p_L) = \sum_{o_i : p_i = p_L} q_i^{\text{rem}}$ and cumulative depth $C(p_L) = \sum_{m=1}^L Q(p_m)$.
- **L3 (market-by-order):** every individual resting order.

### What Argus implements
- Internally `Orderbook` keeps order-level (L3) arrays, so user orders (`ACC-INST-01`, `isSynthetic: false`) queue alongside synthetic market-maker quotes (`ACC-INST-02`, `isSynthetic: true`) under the same comparator.
- `getSnapshot(depth = 15)` projects this into up to 15 aggregated levels per side with a running cumulative `total` per level. The server broadcasts it as WebSocket `ORDERBOOK` messages; tickers (last, bid, ask, spread, 24h stats) are served by `GET /api/tickers` and broadcast as `TICK` messages.
- `ArgusChartEngine._renderDepthPane` (`public/js/charts.js:596+`) draws the cumulative depth from `total` (or recomputes it). Levels are spaced **evenly by level index** on the x-axis (`ratio = (i + 1) / bidPoints.length`), not proportionally to price.
- `cancelOrder(orderId)` removes exactly one resting order ($O(N)$ search, see table above); other orders at the same price are unaffected.

---

## 4. Cont–Stoikov–Talreja (2010) Order Book Model

### Background theory
Cont, Stoikov and Talreja (2010) model the book on a price grid as a continuous-time Markov chain over queue sizes. At distance $i$ ticks from the opposite best quote:
1. Limit orders arrive at rate $\lambda(i)$; the paper fits a power law $\lambda(i) = k / i^{\alpha}$.
2. Market orders arrive at rate $\mu$ and consume the best queue.
3. Each resting order at distance $i$ cancels at rate $\theta(i)$, so a queue of size $x$ cancels at rate $\theta(i)\,x$.

### What Argus implements (not a CST model)
Argus does **not** implement the Cont–Stoikov–Talreja Markov chain: there are no Poisson arrival/cancel rates and no power-law placement. The book is maintained by three deterministic-plus-uniform-noise rules:
1. **Initial depth (`Orderbook.seedRestingBook`, `src/engine/orderbook.js:37-86`).** 18 levels per side at `center ± level·tick`. Size per level is `lotSize · max(1, round(baseMultiple · m(L)))` with
   $$m(L) = 1 + 0.45 \sin(1.7 L) + 0.6 \cdot \mathbb{I}_{\{L > 8\}}$$
   (asks use $m(L) + 0.12$; `baseMultiple` is 35 for BTC-USD, 45 for ETH-USD, 150 for IDR-USD, 60 otherwise).
2. **Re-centering every simulator tick (`MarketSimulator._maintainBookAroundMid`, `src/engine/marketSim.js:400-459`).** On each tick (default 400 ms) synthetic quotes are removed if they are on the wrong side of the target mid $M^*$ or more than 28 ticks away (bids kept if $M^* - 28\delta \le p < M^*$; asks if $M^* < p \le M^* + 28\delta$). User orders are never pruned (`if (!o.isSynthetic) return true;`, lines 403 and 407). Any of the 18 price levels on each side with no order is refilled with size `lotSize · max(1, round(baseMult · U(0.6, 1.5)))` (`baseMult` 28 for BTC-USD, 120 for IDR-USD, 45 otherwise). Quotes are inserted with `_insertResting`, i.e. without a matching pass.
3. **Low-depth backstop (`Orderbook._replenishBookLiquidity`, `src/engine/orderbook.js:264-311`, triggered at lines 240-242).** After any `submitOrder`, if either side has fewer than 6 orders, missing price levels within 18 ticks of `lastPrice` are added (tag `MM-AUTO-REPLENISH`, size `lotSize · (15 + 3·level)`) while that side has fewer than 18 orders.

Pruning far-away quotes can loosely be thought of as "cancellation when the mid moves", but it is a rule, not a rate-based cancellation process.

---

## 5. Market Impact: Kyle's λ and Walking the Book

### 5.1 Background theory: Kyle (1985)
In Kyle's single-period model, an insider knows $v \sim \mathcal{N}(p_0, \Sigma_0)$, noise traders submit $u \sim \mathcal{N}(0, \sigma_u^2)$, and market makers see total flow $y = x + u$. The linear equilibrium price is
$$P(y) = p_0 + \lambda y, \qquad \lambda = \frac{\sqrt{\Sigma_0}}{2 \sigma_u}$$
$\lambda$ is price change per unit of signed order flow (illiquidity); $1/\lambda$ is a depth measure. Glosten and Milgrom (1985) show how a bid-ask spread arises from adverse selection against informed traders.

### 5.2 What Argus implements: walk-the-book execution
A buy of size $Q$ larger than the best ask level consumes successive ask levels in `submitOrder` (`src/engine/orderbook.js:177-224`). The average execution price and cost relative to the pre-trade mid $M_0$ are
$$\bar{P}_{\text{exec}}(Q) = \frac{1}{Q} \sum_{j=1}^k p_j^A \Delta q_j, \qquad \Delta P_{\text{impact}}(Q) = \bar{P}_{\text{exec}}(Q) - M_0$$
These are definitions that hold for any fill set. A common illustrative decomposition is $\Delta P_{\text{impact}}(Q) \approx S_0/2 + \hat{\lambda}(Q)\, Q$ (half-spread plus a depth-dependent slope); Argus does not compute this decomposition.

### 5.3 What Argus implements: "Kyle's λ" figures
- `computeMicrostructureAlpha` (`src/engine/quantRisk.js:350`, λ at lines 456-474) computes a **simplified proxy**, not a Kyle-model estimate: $\hat\lambda = \sum |\Delta p_i|\, q_i / \sum q_i^2$ over consecutive trades, using **absolute** price changes and **unsigned** trade sizes (so it is not a regression on signed order flow). The trades come from `SELECT ... FROM trades WHERE symbol = ? ORDER BY timestamp ASC LIMIT 120`, i.e. the **oldest** 120 trades for the symbol, not the most recent. With fewer than 3 trades it falls back to `spread / (bestBidSize + bestAskSize)`. The result is converted to bps per \$100k notional and clamped to [0.1, 250].
- The smart order router (`src/engine/smartOrderRouter.js`) uses hard-coded per-venue `kyleLambdaBaseBps` constants for simulated venues, not estimated values.

---

## 6. References

1. Cont, R., Stoikov, S., & Talreja, R. (2010). *A Stochastic Model for Order Book Dynamics.* Operations Research, 58(3), 549–563. https://doi.org/10.1287/opre.1090.0780
2. Kyle, A. S. (1985). *Continuous Auctions and Insider Trading.* Econometrica, 53(6), 1315–1335. https://doi.org/10.2307/1913210
3. Glosten, L. R., & Milgrom, P. R. (1985). *Bid, Ask and Transaction Prices in a Specialist Market with Heterogeneously Informed Traders.* Journal of Financial Economics, 14(1), 71–100. https://doi.org/10.1016/0304-405X(85)90044-3
4. Gould, M. D., Porter, M. A., Williams, S., McDonald, M., Fenn, D. J., & Howison, S. D. (2013). *Limit Order Books.* Quantitative Finance, 13(11), 1709–1742.
5. Harris, L. (2003). *Trading and Exchanges: Market Microstructure for Practitioners.* Oxford University Press.
