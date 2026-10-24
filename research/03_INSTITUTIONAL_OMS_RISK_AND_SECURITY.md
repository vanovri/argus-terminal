---
title: "Note 03: Pre-Trade Buying-Power Check & API Hardening in Argus Terminal"
note_id: "NOTE-03"
captured_at: "2026-10-24T07:56:00Z"
author: "Argus Terminal project notes (AI-assisted draft, checked against the code)"
source_files:
  - "src/server/routes.js"
  - "src/engine/orderbook.js"
  - "src/db/database.js"
  - "SECURITY_AUDIT_REPORT.md"
  - "tests/security_pentest_poc.js"
---

# Note 03: Pre-Trade Buying-Power Check & API Hardening in Argus Terminal

> Study notes written with AI assistance. Statements about Argus code were checked against
> the source at the time of writing; the regulatory section is background, not a description
> of what is implemented. Argus is an educational simulation and is not compliant with any
> regulation.

## 1. Background: SEC Rule 15c3-5 (Market Access Rule)

SEC Rule 15c3-5 (17 CFR § 240.15c3-5, adopted in 2010, Release No. 34-63241) requires
U.S. broker-dealers with market access to maintain pre-trade risk controls. In broad terms it
covers:

1. **Financial controls** — preventing orders that exceed pre-set credit or capital thresholds.
2. **Erroneous-order controls** — rejecting orders that exceed price or size parameters.
3. **Regulatory controls** — restricting access to authorized persons and accounts.

Argus borrows only the *idea* of a pre-trade credit check (section 2). It does not implement
the rule, has no aggregate limits, no price collars, no post-trade surveillance, and no
supervisory review — none of which a real implementation could omit.

---

## 2. What Argus implements

### 2.1 A simple 5x buying-power check (`VULN-05` fix)

In `Orderbook.submitOrder` (`src/engine/orderbook.js`, lines ~141–156), every non-synthetic
order (`!isSynthetic`) is checked against the account's cash before matching:

$$\text{Notional} = P_{\text{ref}} \cdot Q, \qquad \text{BP}_{\max} = 5 \cdot C_{\text{cash}}$$

- $P_{\text{ref}}$ is the tick-rounded limit price for `LIMIT` orders, or the opposite
  top-of-book price for `MARKET` orders.
- $C_{\text{cash}}$ is `accounts.cash_balance`.
- The multiplier 5 is an arbitrary demo choice. It does not model Reg T or portfolio margin,
  existing positions, open orders, or `margin_used`.

The order is admitted only if $C_{\text{cash}} > 0$ and $P_{\text{ref}} \cdot Q \le 5 \cdot C_{\text{cash}}$.
Otherwise `submitOrder` throws and the REST layer returns `400 Bad Request`
(`Insufficient buying power / margin limit exceeded`). `CONTROL-05` in
`tests/security_pentest_poc.js` checks this with a 5,000 BTC-USD market order on
`ACC-INST-01`.

### 2.2 Transactional settlement and average-cost accounting

When fills occur, `Orderbook._persistExecution` (`src/engine/orderbook.js`, lines ~313–385)
wraps the writes in `BEGIN ... COMMIT` (with `ROLLBACK` on error). For each fill
$(p_{\text{fill}}, q_{\text{fill}})$ with signed quantity $\Delta q$ (positive for `BUY`),
`_applyAccountAndPositionUpdate` (lines ~387–445) updates cash, position quantity, average
entry price, and realized PnL:

1. **Open or add** ($Q_{\text{old}} = 0$ or same sign as $\Delta q$):
   $$\bar{P}_{\text{new}} = \frac{|Q_{\text{old}}| \bar{P}_{\text{old}} + |\Delta q| p_{\text{fill}}}{|Q_{\text{old}}| + |\Delta q|}, \qquad \Delta \Pi_{\text{real}} = 0$$
2. **Reduce** (opposite sign, $|\Delta q| < |Q_{\text{old}}|$):
   $$\bar{P}_{\text{new}} = \bar{P}_{\text{old}}, \qquad \Delta \Pi_{\text{real}} = |\Delta q| \cdot \text{sign}(Q_{\text{old}}) \cdot (p_{\text{fill}} - \bar{P}_{\text{old}})$$
3. **Flatten or flip** (opposite sign, $|\Delta q| \ge |Q_{\text{old}}|$): realized PnL on the
   closed $|Q_{\text{old}}|$; the new average is $0$ if flat, else $p_{\text{fill}}$.

Synthetic (simulated market-maker) orders skip account updates; a synthetic order with no
fills skips SQLite entirely.

---

## 3. Seeded API weaknesses and their fixes (`VULN-01` .. `VULN-05`)

The five issues below were **intentionally seeded** during development and then fixed; see
`SECURITY_AUDIT_REPORT.md` for diffs. `tests/security_pentest_poc.js` is a regression suite
that checks the defensive controls respond correctly. It does not run exploits. CWE labels
are given for orientation; severities are not formally scored.

| ID | CWE (orientation) | Seeded weakness | Fix | Regression test |
|---|---|---|---|---|
| VULN-01 | CWE-89 SQL Injection | String-interpolated `q` in `GET /api/orders/search` | Bound `?` parameters | `CONTROL-01` |
| VULN-02 | CWE-89 / CWE-284 | `POST /api/sql` ran any statement on any table | `validateReadOnlySql(rawQuery)` | `CONTROL-02` |
| VULN-03 | CWE-918 SSRF | `POST /api/webhooks/test` fetched any URL | `validateWebhookTargetUrl(targetUrl)` hostname filter | `CONTROL-03` |
| VULN-04 | CWE-306 / CWE-639 | `RESTRICTED` account `ACC-VAULT-99` usable without credentials | `verifyAccountAccess` requires `X-API-Key` | `CONTROL-04` |
| VULN-05 | CWE-400 and missing business check | No buying-power check; 1 MB body limit | 5x cash check; `MAX_JSON_BODY_BYTES = 64 * 1024` | `CONTROL-05` |

---

## 4. `validateReadOnlySql` (`src/server/routes.js`)

`node:sqlite` (`DatabaseSync`) does not expose SQLite's `sqlite3_set_authorizer()` hook to
JavaScript, so the console uses a lexical guard before `db.prepare()`:

- **Rule 1 — single statement**: strips trailing semicolons and rejects internal `;`, `--`,
  or `/*` (`403`).
- **Rule 2 — `SELECT` prefix**: `/^SELECT\b/i`.
- **Rule 3 — keyword denylist**:
  `/\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REPLACE|CREATE)\b/i`.
- **Rule 4 — table/column block**: `/\b(accounts|api_secret)\b/i`.

This is weaker than an authorizer callback or a separate read-only connection (e.g.
`SELECT` can still call expensive functions or recursive CTEs). It is adequate for a local
demo console only.

---

## 5. `validateWebhookTargetUrl` (`src/server/routes.js`)

Parses the URL with the WHATWG `new URL()` parser, then:

1. **Scheme allowlist**: only `http:` and `https:`.
2. **Hostname blocklist**: `localhost`, `0.0.0.0`, `::1`, `::`, `::ffff:127.*`, and
   `*.local`, `*.internal`, `*.localhost`.
3. **IPv4 prefixes**: `127.`, `10.`, `172.16–31.`, `192.168.`, `169.254.` (includes the
   common cloud metadata address `169.254.169.254`).
4. **IPv6 prefixes**: `fc**:`/`fd**:` (unique local) and `fe80:` (link-local; note the regex
   only matches the `fe80:` prefix, not all of `fe80::/10`).

Limitations: no DNS resolution (DNS rebinding is not handled), no re-validation of
redirects, and decimal/hex-encoded IPv4 forms rely on the URL parser's normalization.

---

## 6. References

1. U.S. Securities and Exchange Commission (2010). *Risk Management Controls for Brokers or
   Dealers with Market Access* (17 CFR § 240.15c3-5), Release No. 34-63241.
   `https://www.ecfr.gov/current/title-17/chapter-II/part-240/section-240.15c3-5`
2. OWASP Foundation (2023). *OWASP API Security Top 10 — 2023* (API1 Broken Object Level
   Authorization, API4 Unrestricted Resource Consumption, API7 Server Side Request Forgery).
   `https://owasp.org/API-Security/`
3. Rekhter, Y., et al. (1996). *RFC 1918: Address Allocation for Private Internets.* IETF.
4. Cheshire, S., Aboba, B., & Guttman, E. (2005). *RFC 3927: Dynamic Configuration of IPv4
   Link-Local Addresses.* IETF.
5. Hinden, R., & Haberman, B. (2005). *RFC 4193: Unique Local IPv6 Unicast Addresses.* IETF.
