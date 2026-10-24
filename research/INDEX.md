---
title: "Argus Terminal — Research Notes Index"
captured_at: "2026-10-24T07:56:00Z"
author: "Argus Terminal project notes (AI-assisted draft, checked against the code)"
---

# Argus Terminal — Research Notes (`research/`)

These are study notes written with AI assistance while building Argus Terminal, an
educational, local-only simulation of a Bloomberg-style trading terminal. Each note has two
kinds of content:

- **Background** — textbook / literature concepts (market microstructure, stochastic price
  models, pre-trade risk rules). These describe the real-world ideas, not what Argus does.
- **What Argus implements** — statements about the code, which were checked against the
  source at the time of writing. Where Argus uses a simplified heuristic instead of the
  textbook model, the note says so.

The literature references were not independently audited; treat them as pointers for
further reading.

| Note | File | Topic | Related code |
|---|---|---|---|
| 01 | [`01_LOB_MICROSTRUCTURE_AND_FIFO_MATCHING.md`](./01_LOB_MICROSTRUCTURE_AND_FIFO_MATCHING.md) | Limit order books, price-time priority (FIFO) matching, order book data structures | `src/engine/orderbook.js`, `src/engine/slabOrderbook.js` |
| 02 | [`02_STOCHASTIC_PRICE_DYNAMICS_AND_VPIN.md`](./02_STOCHASTIC_PRICE_DYNAMICS_AND_VPIN.md) | Simulated price dynamics, order-flow toxicity proxies, VWAP/EMA indicators | `src/engine/marketSim.js`, `src/engine/quantRisk.js`, `src/db/database.js`, `public/js/charts.js` |
| 03 | [`03_INSTITUTIONAL_OMS_RISK_AND_SECURITY.md`](./03_INSTITUTIONAL_OMS_RISK_AND_SECURITY.md) | A simple 5x buying-power check (inspired by, not compliant with, SEC Rule 15c3-5) and the five seeded API weaknesses that were fixed | `src/server/routes.js`, `src/engine/orderbook.js`, `tests/security_pentest_poc.js` |

Related reports in the repository root:

- [`../BENCHMARK_REPORT.md`](../BENCHMARK_REPORT.md) — matching-engine microbenchmark with an
  ablation of where the time goes, and its caveats.
- [`../SECURITY_AUDIT_REPORT.md`](../SECURITY_AUDIT_REPORT.md) — the five seeded weaknesses,
  their fixes, and the regression tests.
- [`../DEVTOOLS_AUDIT_REPORT.md`](../DEVTOOLS_AUDIT_REPORT.md) — local page-load, heap, and
  accessibility checks.

A code knowledge graph was generated with `graphify` during development (`graphify-out/`);
it is a navigation aid, not evidence for any claim in these notes.
