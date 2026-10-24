# Graph Report - argus-terminal  (2026-10-24)

## Corpus Check
- Corpus is ~24,109 words - fits in a single context window. You may not need a graph.

## Summary
- 209 nodes · 479 edges · 9 communities
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 35 edges (avg confidence: 0.89)
- Token cost: 4,820 input · 1,940 output

## Community Hubs (Navigation)
- SQLite Persistence & Schema
- Terminal UI & Blotter
- L2 Matching Engine
- High-DPI Canvas Charts
- REST & Security Guardrails
- WebSocket Stream & Components
- E2E & Security Verification
- Package Manifest & Scripts

## God Nodes (most connected - your core abstractions)
1. `ArgusChartEngine` - 22 edges
2. `MarketSimulator` - 19 edges
3. `createApiRouter()` - 18 edges
4. `init()` - 13 edges
5. `roundToTick()` - 13 edges
6. `Orderbook` - 13 edges
7. `fetchJson()` - 12 edges
8. `loadPortfolio()` - 11 edges
9. `MatchingEngine` - 11 edges
10. `loadSymbolMarketData()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `Mean-Reverting Geometric Brownian Motion Simulator` --semantically_similar_to--> `seedDatabase()`  [INFERRED] [semantically similar]
  ARCHITECTURE.md → src/db/database.js
- `VULN-01: SQL Injection in Order Search (CVSS 9.8)` --references--> `searchOrders()`  [INFERRED]
  SECURITY_AUDIT_REPORT.md → public/js/app.js
- `VULN-02: Unrestricted SQL Console & Secret Exposure (CVSS 9.6)` --references--> `executeSqlQuery()`  [INFERRED]
  SECURITY_AUDIT_REPORT.md → public/js/app.js
- `VULN-03: Webhook Test SSRF to Loopback/Metadata (CVSS 8.6)` --references--> `triggerWebhookTest()`  [INFERRED]
  SECURITY_AUDIT_REPORT.md → public/js/app.js
- `Direct Market Access (DMA) Order Entry Ticket` --shares_data_with--> `createApiRouter()`  [INFERRED]
  public/index.html → src/server/routes.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **End-to-End Institutional Order Execution & Settlement Pipeline** — public_index_dma_order_ticket, public_js_app_submitorderticket, src_server_routes_createapirouter, src_server_routes_verifyaccountaccess, src_engine_orderbook_orderbook_submitorder, src_engine_orderbook_orderbook_persistexecution, architecture_ws_event_orderbook [EXTRACTED 1.00]
- **Five-Layer White-Box API & Pre-Trade Security Hardening** — security_audit_report_vuln_01_sqli_search, security_audit_report_vuln_02_unrestricted_sql, security_audit_report_vuln_03_webhook_ssrf, security_audit_report_vuln_04_restricted_idor, security_audit_report_vuln_05_pretrade_risk_cap, tests_security_pentest_poc_verify [EXTRACTED 1.00]
- **Real-Time Stochastic Market Data & High-DPI Visual Loop** — architecture_gbm_mean_reversion, src_engine_marketsim_marketsimulator_step, src_server_index_createargusserver_broadcast, public_js_app_handlewebsocketmessage, public_js_charts_arguschartengine_updatelivecandle, public_js_components_renderorderbook [EXTRACTED 1.00]

## Communities (9 total, 0 thin omitted)

### Community 0 - "SQLite Persistence & Schema"
Cohesion: 0.06
Nodes (38): Argus Terminal Institutional System, In-Process node:sqlite WAL Persistence Engine, createPrng(), DATA_DIR, { DatabaseSync }, DEFAULT_DB_PATH, fs, getDb() (+30 more)

### Community 1 - "Terminal UI & Blotter"
Cohesion: 0.16
Nodes (39): Bloomberg <GO> Command Bar & Dialog Palette, Light-Dismiss <dialog> Command Palette Modal, Direct Market Access (DMA) Order Entry Ticket, bindBlotterEvents(), bindChartToolbarEvents(), bindGlobalKeyboardShortcuts(), bindHeaderAndCommandEvents(), bindOrderTicketEvents() (+31 more)

### Community 2 - "L2 Matching Engine"
Cohesion: 0.16
Nodes (9): Price-Time Priority (FIFO) L2 Matching Algorithm, Mean-Reverting Geometric Brownian Motion Simulator, SEC Rule 15c3-5 Pre-Trade Market Access Risk Gate, VULN-05: Missing 5x Pre-Trade Buying Power & 64KB Cap (CVSS 8.0), roundToTick(), formatClock(), MarketSimulator, nextId() (+1 more)

### Community 3 - "High-DPI Canvas Charts"
Cohesion: 0.20
Nodes (3): High-DPI Canvas 2D OHLCV & L2 Market Depth Engine, Multi-Pane Institutional Tiling Grid Workspace, ArgusChartEngine

### Community 4 - "REST & Security Guardrails"
Cohesion: 0.15
Nodes (15): VULN-01: SQL Injection in Order Search (CVSS 9.8), VULN-02: Unrestricted SQL Console & Secret Exposure (CVSS 9.6), VULN-03: Webhook Test SSRF to Loopback/Metadata (CVSS 8.6), VULN-04: Broken Access Control on RESTRICTED Tier (CVSS 8.2), MatchingEngine, buildPortfolioPayload(), createApiRouter(), { performance } (+7 more)

### Community 5 - "WebSocket Stream & Components"
Cohesion: 0.20
Nodes (21): WS Event: CANDLE & NEWS Wire Broadcast, WS Event: ORDERBOOK & TRADE Broadcast, WS Event: SNAPSHOT & TICK Stream, WebSocket Real-Time Market Multiplexer (/ws), escapeHtml(), formatCurrency(), formatPrice(), formatSize() (+13 more)

### Community 6 - "E2E & Security Verification"
Cohesion: 0.21
Nodes (5): httpRequest(), isServerHealthy(), runTest(), startArgusTestServer(), waitForHealth()

### Community 7 - "Package Manifest & Scripts"
Cohesion: 0.18
Nodes (10): dependencies, ws, description, ws, main, name, scripts, start (+2 more)

## Knowledge Gaps
- **35 isolated node(s):** `name`, `version`, `description`, `main`, `start` (+30 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 47 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `MarketSimulator` connect `L2 Matching Engine` to `SQLite Persistence & Schema`?**
  _High betweenness centrality (0.153) - this node is a cross-community bridge._
- **Why does `createApiRouter()` connect `REST & Security Guardrails` to `SQLite Persistence & Schema`, `Terminal UI & Blotter`, `L2 Matching Engine`?**
  _High betweenness centrality (0.143) - this node is a cross-community bridge._
- **Why does `createArgusServer()` connect `SQLite Persistence & Schema` to `L2 Matching Engine`, `REST & Security Guardrails`, `WebSocket Stream & Components`, `E2E & Security Verification`?**
  _High betweenness centrality (0.117) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _35 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `SQLite Persistence & Schema` be split into smaller, more focused modules?**
  _Cohesion score 0.06161616161616162 - nodes in this community are weakly interconnected._