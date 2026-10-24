# Argus Terminal — Local Page-Load, Heap & Accessibility Checks

**Suite**: `tests/devtools_audit.test.js` — `8 PASSED | 0 FAILED`
**Related**: `tests/e2e.test.js` — `13 PASSED | 0 FAILED`

> All numbers below come from **one local run** on the development laptop
> (Intel Core i5-10300H, Windows, Node.js v24.20.0) against a server on `127.0.0.1`
> with an in-memory database. They are not field measurements, they will vary between runs
> and machines, and there is no network latency involved. The test's pass/fail thresholds
> are listed next to each number; the thresholds, not the exact numbers, are what the suite
> asserts.

---

## 1. Front-end changes checked by the suite

| Change | Where | How it is checked |
| :--- | :--- | :--- |
| Inner highlight on panes (`box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07)`) | `public/css/terminal.css` | String presence in CSS |
| `cubic-bezier(0.32, 0.72, 0, 1)` transitions instead of generic `ease`/`all` on interactive controls | `public/css/terminal.css` | String presence in CSS |
| Skip link to `#main-workspace` and global `:focus-visible` outline | `public/index.html`, `terminal.css` | Regex on HTML/CSS |
| `contain: layout style` on `.orderbook-ladder`, the trades tape, and the news list | `public/css/terminal.css` | String presence in CSS |

These are static checks of the source files, not rendering measurements.

---

## 2. Page-load timings (local server, no network)

| Asset | Status | TTFB | Total | Size (uncompressed) |
| :--- | :--- | :--- | :--- | :--- |
| `GET /` (`public/index.html`) | `200` | 19.97 ms | 21.98 ms | 34.77 KB |
| `GET /css/terminal.css` | `200` | 3.77 ms | 5.38 ms | 42.78 KB |
| `GET /js/charts.js` | `200` | 2.32 ms | 3.03 ms | 27.99 KB |
| `GET /js/components.js` | `200` | 3.79 ms | 4.90 ms | 35.01 KB |
| `GET /js/app.js` | `200` | 4.77 ms | 6.21 ms | 54.43 KB |
| **Critical-path total** | — | — | — | **194.97 KB** |

- Thresholds asserted: TTFB of `/` and `terminal.css` < 50 ms; critical-path total < 250 KB.
- `<head>` contains no external stylesheets/fonts and no synchronous `<script>` tags (regex check).
- This is not an LCP measurement: no browser was involved, so paint timing was not measured.

---

## 3. Accessibility checks

### Contrast of four design-token colours

Only these four foreground/background pairs were measured (WCAG 2.1 relative-luminance
formula). Other colours used in the UI (muted text, borders, crimson, chart colours) were
**not** measured, so this does **not** establish WCAG AA or AAA conformance for the app.

| Token | Foreground | Background | Ratio | ≥ 4.5:1 (AA normal text) | ≥ 7:1 (AAA normal text) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Primary text (`--text-primary`) | `#e6edf7` | `#06080c` | 17.01 : 1 | yes | yes |
| Emerald (`--emerald`) | `#00e676` | `#06080c` | 12.01 : 1 | yes | yes |
| Cyan (`--cyan`) | `#00d2ff` | `#06080c` | 11.13 : 1 | yes | yes |
| Amber (`--amber`) | `#ff9e00` | `#06080c` | 9.68 : 1 | yes | yes |

### Structure checks (static regex checks on `public/index.html`)

- [x] `<html lang="en">`.
- [x] Skip link to `#main-workspace` at the top of `<body>`.
- [x] `<header role="banner">` and a labelled function-key `<nav>`.
- [x] `<main id="main-workspace">` with labelled `<section class="pane">` regions.
- [x] All 4 scrollable `.table-wrapper` containers have `tabindex="0" role="region"` and a label.
- [x] Native `<dialog>` command bar with `aria-labelledby`.
- [x] `aria-live="polite"` toast container.
- [x] 9 form controls and 59 `<button>` elements found, each with a `<label for>` or
  `aria-label` (0 unlabelled). The test asserts at least 7 labelled controls.

No screen-reader testing or automated axe/Lighthouse audit was performed.

---

## 4. Heap and collection-size stress check

The test runs 300 market-simulation ticks plus 100 order submit/cancel cycles while a
WebSocket client is connected, then checks that heap growth and in-memory collections stay
bounded.

| Metric | Measured (this run) | Asserted threshold |
| :--- | :--- | :--- |
| `heapUsed` before | 9.45 MB | — |
| `heapUsed` after | 14.88 MB | — |
| Delta | +5.43 MB | < 25 MB |
| Duration | 983.6 ms | — |
| WebSocket frames received | 3,368 | ≥ 300 |
| Bid/ask array length per book | (asserted) | ≤ 30 |
| `marketSim.trades` length | (asserted) | ≤ 100 |
| `marketSim.news` length | (asserted) | ≤ 40 |

`global.gc()` is only called when Node runs with `--expose-gc`; the default `node
tests/devtools_audit.test.js` run does not force GC, so the heap delta includes garbage that
has not been collected yet. A bounded delta over one short run is a sanity check, not proof
that there are no memory leaks.
