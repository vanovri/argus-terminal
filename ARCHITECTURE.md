# Argus Terminal — Architecture

## 1. Overview

**Argus Terminal** is an educational, local-only simulation of a Bloomberg-style multi-pane trading and quantitative analysis terminal: a `<GO>` command bar, a simulated limit order book with price-time priority (FIFO) matching, Canvas 2D candlestick and depth charts, a trades tape, a simulated news wire, options volatility surfaces, FIX 4.4 / binary SBE wire codecs, Nelson-Siegel-Svensson yield curves, deterministic order-book replay, and a read-only SQL console over a local SQLite database.

- All market data, news, venues, and accounts are **simulated**. Nothing connects to a real exchange or broker. It is not financial software and is not affiliated with any exchange, data vendor, or firm.
- Single Node.js process, no build step. Runtime dependencies: Node's built-in `node:sqlite` (`DatabaseSync`) and one npm package, `ws`.
- The HTTP server binds to `127.0.0.1` (port `3400` by default, or `PORT`).

## 2. Directory structure

```text
argus-terminal/
├── package.json, LICENSE, README.md, ROADMAP.md
├── ARCHITECTURE.md, BENCHMARK_REPORT.md, SECURITY_AUDIT_REPORT.md, DEVTOOLS_AUDIT_REPORT.md
├── data/
│   └── argus.sqlite                  # Auto-created SQLite database (git-ignored)
├── src/
│   ├── db/
│   │   └── database.js               # Schema, deterministic seed data (instruments, demo accounts, positions, candles)
│   ├── engine/
│   │   ├── orderbook.js              # Orderbook + MatchingEngine: FIFO limit/market matching, SQLite persistence, 5x buying-power check
│   │   ├── slabOrderbook.js          # TypedArray "slab" order book with a tiny hand-written WASM helper (benchmark / telemetry)
│   │   ├── marketSim.js              # Simulated price path, synthetic liquidity and trades, news wire
│   │   ├── quantRisk.js              # Monte Carlo VaR/CVaR, order-flow heuristics (OBI, VPIN-style proxy), backtester, rule-based copilot
│   │   ├── algoEngine.js             # Simulated execution algos: TWAP, VWAP, ICEBERG, and an Avellaneda-Stoikov-style quoting schedule
│   │   ├── optionsGreeks.js          # Black-Scholes-Merton pricing, Greeks, implied-vol solver, SVI-style vol surface
│   │   ├── fixProtocol.js            # FIX 4.4 tag=value encode/parse (BodyLength, CheckSum) + a 40-byte binary codec inspired by SBE
│   │   ├── smartOrderRouter.js       # Order routing and arbitrage scan across 4 simulated venues
│   │   ├── yieldCurveFixedIncome.js  # Nelson-Siegel-Svensson (NSS) yield curve, bond dirty/clean pricing, YTM, DV01, convexity, Z-spread
│   │   ├── lobTimeMachine.js         # Keyframe + delta event-sourced LOB replay scrubber with SHA-256 state verification
│   │   └── darkPoolEngine.js         # Simulated midpoint-peg dark pool (ARGUS-DARK-ATS) with minimum acceptable quantity & VPIN check
│   └── server/
│       ├── routes.js                 # REST API handlers + input validation / security guards
│       └── index.js                  # Static file server + REST + WebSocket broadcaster
├── public/
│   ├── index.html                    # Main terminal workspace (/)
│   ├── options.html                  # Options chain, 3D vol surface, FIX inspector, SOR/arbitrage panes (/options.html)
│   ├── macro.html                    # NSS yield curve, bond desk, LOB replay time-machine, dark pool ATS (/macro.html)
│   ├── deck.html                     # 10-slide project overview deck (/deck.html)
│   ├── css/terminal.css
│   └── js/                           # app.js (orchestration, WebSocket client), charts.js (Canvas 2D), components.js (DOM renderers)
├── benchmarks/
│   ├── matching_bench.js             # Matching-engine 5-mode ablation microbenchmark (see BENCHMARK_REPORT.md)
│   └── results/latest.json           # Recorded benchmark output
├── research/                         # AI-assisted study notes (background theory vs. what is implemented)
└── tests/                            # 6 plain-Node test suites (64 assertions total, no external test framework)
```

Simulated venue names in `smartOrderRouter.js` borrow the shape of real venue names for flavour; the fees and latencies attached to them are made-up demo parameters.

## 3. Instruments (seeded in SQLite `instruments`, simulated prices)

- `BTC-USD` (base price `94500.00`, tick `0.50`)
- `ETH-USD` (base price `3180.00`, tick `0.10`)
- `SOL-USD` (base price `212.50`, tick `0.05`)
- `NVDA-EQ` (base price `148.20`, tick `0.01`)
- `XAU-USD` (base price `2745.00`, tick `0.10`)
- `IDR-USD` (base price `15680.00`, tick `1.00`)

## 4. REST API (`http://127.0.0.1:3400`)

Core (Wave 1):
- `GET /api/health` → `{ status: "ok", uptime, engineTickCount, activeSymbolCount }`
- `GET /api/tickers`
- `GET /api/candles?symbol=BTC-USD&limit=120`
- `GET /api/orderbook?symbol=BTC-USD&depth=15`
- `GET /api/trades?symbol=BTC-USD&limit=50`
- `GET /api/portfolio?accountId=ACC-INST-01`
- `POST /api/orders` — body `{ accountId, symbol, side, type, price, size }`; runs the `Orderbook` matching engine, persists `orders`/`trades`/`positions`/`accounts` in one transaction, broadcasts over WebSocket, returns `{ order, fills }`.
- `DELETE /api/orders/:orderId`
- `GET /api/orders/search?q=...` (parameterized)
- `POST /api/sql` — body `{ query }`; single read-only `SELECT`, `accounts`/`api_secret` blocked.
- `POST /api/webhooks/test` — body `{ targetUrl, eventType }`; loopback/private targets blocked.
- `GET /api/news`

Quant & engine (Wave 2):
- `GET /api/quant/risk`, `GET /api/algos`, `POST /api/algos`, `POST /api/backtest`, `GET /api/slab-metrics`

Derivatives, FIX & routing (Wave 3):
- `GET /api/options/chain`, `POST /api/options/solve-iv`, `POST /api/fix`, `POST /api/sor/route`, `GET /api/arbitrage`

Macro rates, LOB replay & dark pool (Wave 4):
- `GET /api/macro/yield-curve`, `POST /api/macro/bond-price`, `POST /api/macro/calibrate-nss`
- `GET /api/replay/timeline`, `GET /api/replay/state`, `POST /api/replay/seek`, `POST /api/replay/record`
- `GET /api/darkpool/status`, `POST /api/darkpool/orders`

Requests for the `RESTRICTED` demo account (`ACC-VAULT-99`) require an `X-API-Key` header. JSON bodies are capped at 64 KB. See `SECURITY_AUDIT_REPORT.md`.

## 5. WebSocket protocol (`ws://localhost:3400/ws`)

Server broadcasts JSON messages:
- `{ type: "SNAPSHOT", tickers, news }` (on connect)
- `{ type: "TICK", tickers, timestamp }` (every 400 ms)
- `{ type: "ORDERBOOK", symbol, orderbook }` (on tick / order event)
- `{ type: "TRADE", trade }` (on simulated or user fill)
- `{ type: "DARK_TRADE", trade }` (on dark-pool midpoint fill)
- `{ type: "CANDLE", symbol, candle }` (live bar update)
- `{ type: "NEWS", item }` (simulated news item)
- `{ type: "PORTFOLIO_UPDATE", accountId }` (when a user order fills)

Client can send:
- `{ type: "SUBSCRIBE", symbol: "BTC-USD" }`
- `{ type: "COMMAND", command: "BTC-USD <GO>" }`

## 6. Two order books

- `Orderbook` (`orderbook.js`) is the engine the server uses. It keeps resting orders in plain JS arrays, re-sorts on insert, produces a full fill record per match, and persists to SQLite. Simple and easy to inspect, not fast.
- `SlabOrderbook` (`slabOrderbook.js`) stores orders in preallocated typed arrays with an intrusive doubly linked list per side and an `orderId → slot` index for O(1) cancel. It is used for the `/api/slab-metrics` telemetry and the benchmark; it is not wired into order entry. Its three WASM helpers (`priceCrosses`, `minInt`, `calcNotionalCents`) are a few instructions each and make no measurable difference to throughput (see `BENCHMARK_REPORT.md`).
