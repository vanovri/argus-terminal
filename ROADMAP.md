# ARGUS TERMINAL — Institutional Engineering Master Roadmap (Waves 1–4)

> **Status**: **ALL WAVES 100% GREEN (`64 / 64` Automated QA Assertions Passing Across 6 Test Suites)**  
> **Last Updated**: `2026-10-24`

---

## Master Wave Status Matrix

| Wave | Pillar / Subsystem | Core Modules & Workstations | Verification Suite | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Wave 1** | **Core Bloomberg L2 Workstation, Price-Time Priority (FIFO) Matching Engine, SQLite WAL Analytics & 5-Layer White-Box Security** | `src/engine/orderbook.js`, `src/engine/marketSim.js`, `src/db/database.js`, `src/server/routes.js`, `public/index.html` | `tests/e2e.test.js` (`13/13 PASS`)<br>`tests/devtools_audit.test.js` (`8/8 PASS`)<br>`tests/security_pentest_poc.js` (`5/5 PASS`) | **GREEN (100%)** |
| **Wave 2** | **Zero-Allocation TypedArray/WASM Slab L3 Orderbook (`4.28M+ ops/sec`), Avellaneda-Stoikov/TWAP/VWAP/Iceberg Algos, 10k-Path Monte Carlo VaR/CVaR, VPIN & 10-Slide Executive Deck** | `src/engine/slabOrderbook.js`, `src/engine/algoEngine.js`, `src/engine/quantRisk.js`, `public/deck.html`, `benchmarks/matching_bench.js` | `tests/wave2_quant.test.js` (`12/12 PASS`) | **GREEN (100%)** |
| **Wave 3** | **Black-Scholes-Merton 1st/2nd-Order Greeks, 3D Gatheral SVI Volatility Surface, Newton-Raphson IV Solver, FIX 4.4 / 40-Byte Binary SBE Codec & Multi-Venue Smart Order Router (SOR)** | `src/engine/optionsGreeks.js`, `src/engine/fixProtocol.js`, `src/engine/smartOrderRouter.js`, `public/options.html` | `tests/wave3_derivatives_fix.test.js` (`13/13 PASS`) | **GREEN (100%)** |
| **Wave 4** | **Macro Yield Curve (Nelson-Siegel-Svensson) & Fixed Income Bond Desk + Limit Order Book Replay Time-Machine + Institutional Dark Pool Crossing Network (`ARGUS-DARK-ATS`)** | `src/engine/yieldCurveFixedIncome.js`, `src/engine/lobTimeMachine.js`, `src/engine/darkPoolEngine.js`, `public/macro.html` | `tests/wave4_macro_replay_darkpool.test.js` (`13/13 PASS`) | **GREEN (100%)** |

---

## Detailed Checklist by Wave

### Wave 1 — Foundation, L2 Matching & White-Box Security
- [x] Price-Time Priority (FIFO) L2 Orderbook & Market Simulator (`src/engine/orderbook.js`, `src/engine/marketSim.js`)
- [x] SQLite `node:sqlite` WAL Persistence, Accounts, Positions, Candles & Audit Logs (`src/db/database.js`)
- [x] SEC Rule 15c3-5 Synchronous 5x Buying-Power Pre-Trade Risk Gate (`CONTROL-05`)
- [x] White-Box API Hardening: Parameterized SQL (`CONTROL-01`), Read-Only SQL AST Guard (`CONTROL-02`), SSRF CIDR Filter (`CONTROL-03`), Tiered RBAC (`CONTROL-04`)
- [x] WCAG 2.1 AAA Hardware-Enclosure Terminal UI, `<dialog closedby="any">`, CSS Containment & Zero Heap Leaks (`public/index.html`, `public/css/terminal.css`)

### Wave 2 — HFT WASM Slab Arena, Quantitative Risk & Algorithmic Execution
- [x] Pre-Allocated Struct-of-Arrays (`TypedArray`) Slab Orderbook + Embedded Hand-Assembled WebAssembly Kernel (`src/engine/slabOrderbook.js`)
- [x] Institutional Algorithmic Execution Engine: Avellaneda-Stoikov Market Making, TWAP, VWAP, Iceberg (`src/engine/algoEngine.js`)
- [x] Historical OHLCV Strategy Backtester with Sharpe, Sortino & Max Drawdown (`src/engine/algoEngine.js`, `src/engine/quantRisk.js`)
- [x] 10,000-Path Correlated Monte Carlo VaR (95%/99%), CVaR Expected Shortfall, Easley-López de Prado-O'Hara VPIN & Stoikov Micro-Price (`src/engine/quantRisk.js`)
- [x] 10-Slide Interactive Executive Architecture & Pitch Deck (`public/deck.html`)

### Wave 3 — Derivatives Surface, FIX 4.4 / SBE Wire Protocol & Smart Order Router
- [x] Black-Scholes-Merton Analytical Pricing, Put-Call Parity Proof ($|C - P - (Se^{-qT} - Ke^{-rT})| < 10^{-8}$) & 1st/2nd-Order Greeks ($\Delta, \Gamma, \mathcal{V}, \Theta, \rho, \text{Vanna}, \text{Volga}$) (`src/engine/optionsGreeks.js`)
- [x] Hybrid Newton-Raphson / Halley / Bisection Implied Volatility Solver & 5-Tenor Gatheral SVI Volatility Smile Surface (`src/engine/optionsGreeks.js`)
- [x] FIX 4.4 Tag-Value Protocol Parser/Builder (`35=D`, `35=8`, Modulo-256 `Tag 10` Checksum) & Zero-Copy 40-Byte Binary SBE Codec (`src/engine/fixProtocol.js`)
- [x] Multi-Venue Smart Order Router (`ARGUS-LIT`, `CME-GLOBEX`, `BINANCE-INST`, `LMAX-LD4`) & Spatial/Cash-and-Carry Basis Arbitrage Scanner (`src/engine/smartOrderRouter.js`)
- [x] Interactive 3D Isometric Volatility Surface, Straddle Chain, FIX/SBE Hex Inspector & SOR Workstation (`public/options.html`)

### Wave 4 — Macro Yield Curve (NSS), Fixed Income Bond Desk, LOB Replay Time-Machine & Dark Pool ATS
- [x] 6-Parameter Nelson-Siegel-Svensson (NSS) Sovereign Yield Curve, Instantaneous Forward Rate $f(\tau)$, Discount Factor $D(\tau)$ & Ridge/OLS Calibration (`src/engine/yieldCurveFixedIncome.js`)
- [x] Institutional Fixed Income Bond Desk: Clean/Dirty Price, Accrued Interest, Newton-Raphson YTM Solver, Newton-Raphson Z-Spread Solver, Macaulay/Modified Duration, DV01, Convexity & 2nd-Order Taylor Shock Proof (`src/engine/yieldCurveFixedIncome.js`)
- [x] Deterministic Event-Sourced Limit Order Book (LOB) Replay Time-Machine with Periodic Keyframes, O(K) Sequence/Timestamp Seeking & Cryptographic SHA-256 State Hash Verification (`src/engine/lobTimeMachine.js`)
- [x] Institutional Dark Pool Crossing Network (`ARGUS-DARK-ATS`): `MIDPOINT_PEG`, `VWAP_PEG`, `LIMIT_DARK`, Minimum Acceptable Quantity (`minQty` / MAQ) Anti-Pinging Guard, VPIN Flow Toxicity Shield & Price Improvement Analytics (`src/engine/darkPoolEngine.js`)
- [x] Dedicated Wave 4 Macro, Fixed Income, Time-Machine & Dark Pool Workstation (`public/macro.html`) + `<GO>` Command Routing (`YIELD <GO>`, `BOND <GO>`, `REPLAY <GO>`, `DARK <GO>`)
