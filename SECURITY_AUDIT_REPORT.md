# Argus Terminal — Seeded Vulnerabilities: Fixes & Regression Tests

## Summary

Argus Terminal is an educational, local-only simulation. As a learning exercise, five
security weaknesses were **intentionally seeded** into the REST API and matching engine
during development, then fixed at the root cause. Each fix is covered by a regression
test in `tests/security_pentest_poc.js`.

What this document is, and is not:

- It is a record of **five known, seeded issues**, the code that fixes them, and the tests
  that check the fixes stay in place.
- It is **not** an independent security audit, a penetration test, or a guarantee that the
  application is secure. No live exploitation was performed against any system and no data
  was exfiltrated; the test suite only verifies that the defensive controls respond as
  expected (e.g. `403` / `400` status codes).
- Severity labels below are **self-assessed** rough estimates to rank the issues, not
  official CVSS scores.
- Despite its file name, `tests/security_pentest_poc.js` contains no exploit code. It sends
  requests that *should* be rejected and asserts that they are.

| ID | Seeded weakness | Self-assessed severity | Location | Status | Regression test |
|---|---|---|---|---|---|
| VULN-01 | SQL injection via string-interpolated search query | Critical | `src/server/routes.js` (`GET /api/orders/search`) | Fixed | `CONTROL-01` |
| VULN-02 | Unrestricted SQL console (any statement, any table) | Critical | `src/server/routes.js` (`POST /api/sql`) | Fixed | `CONTROL-02` |
| VULN-03 | Server-side request forgery (SSRF) via webhook test URL | High | `src/server/routes.js` (`POST /api/webhooks/test`) | Fixed | `CONTROL-03` |
| VULN-04 | Missing authentication on the `RESTRICTED` account | High | `src/server/routes.js` (`GET /api/portfolio`, `POST /api/orders`, others via `verifyAccountAccess`) | Fixed | `CONTROL-04` |
| VULN-05 | No pre-trade buying-power check; 1 MB JSON body limit | High | `src/engine/orderbook.js` (`submitOrder`), `src/server/routes.js` (`readJsonBody`) | Fixed | `CONTROL-05` |

---

## VULN-01: SQL injection in `GET /api/orders/search`

- **Seeded weakness**: the `q` parameter was interpolated into the SQL string
  (`... WHERE symbol LIKE '%${q}%' ...`), so a crafted `q` could change the query
  (e.g. append a `UNION SELECT` against `accounts`).
- **Fix** (`src/server/routes.js`): parameterized query.
```diff
- const sql = `SELECT * FROM orders WHERE symbol LIKE '%${q}%' OR client_tag LIKE '%${q}%'`;
- const rows = db.prepare(sql).all();
+ const pattern = `%${q}%`;
+ const rows = db.prepare(
+   'SELECT * FROM orders WHERE symbol LIKE ? OR client_tag LIKE ? ORDER BY created_at DESC'
+ ).all(pattern, pattern);
```
- **Regression test**: `CONTROL-01` sends `q='; --` and asserts `200 OK` with an empty
  array, i.e. the metacharacters are treated as a literal search string.

---

## VULN-02: Unrestricted SQL console in `POST /api/sql`

- **Seeded weakness**: `body.query` was passed straight to `db.prepare(query).all()`, so the
  console could read `accounts.api_secret` or run `PRAGMA`/DDL/DML.
- **Fix** (`src/server/routes.js`): `validateReadOnlySql(rawQuery)` enforces
  1. a single statement (a trailing `;` is stripped; embedded `;`, `--`, `/*` are rejected),
  2. a `SELECT` prefix,
  3. a denylist of mutating/administrative keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`,
     `ALTER`, `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, `REPLACE`, `CREATE`),
  4. a block on references to `accounts` / `api_secret`.
- **Limitation**: this is a denylist-style guard for a demo console, not a SQL sandbox.
- **Regression test**: `CONTROL-02` asserts `403` for `SELECT id, tier FROM accounts` and
  for `PRAGMA table_info(orders)`; E2E test 5.1 confirms a normal query on `instruments`
  still works.

---

## VULN-03: SSRF in `POST /api/webhooks/test`

- **Seeded weakness**: `targetUrl` was passed directly to `fetch()`, letting the server
  call loopback, private-network, or cloud-metadata addresses.
- **Fix** (`src/server/routes.js`): `validateWebhookTargetUrl(targetUrl)` parses with
  `new URL()`, allows only `http:`/`https:`, and returns `403` for `localhost`, `0.0.0.0`,
  `::1`, `::`, `::ffff:127.*`, `127.*`, `10.*`, `192.168.*`, `172.16–31.*`, `169.254.*`,
  `fc00::/7`, `fe80::`, and `*.local` / `*.internal` / `*.localhost` hostnames.
- **Limitation**: the check is on the literal hostname. It does not resolve DNS, so a public
  hostname that resolves to a private IP (DNS rebinding) is not blocked. Redirects are not
  re-validated.
- **Regression test**: `CONTROL-03` asserts `403` for `http://127.0.0.1:3498/api/health` and
  `http://169.254.169.254/latest/meta-data/`.

---

## VULN-04: Missing authentication on the `RESTRICTED` account

- **Seeded weakness**: endpoints accepted any `accountId`, including the demo `RESTRICTED`
  account `ACC-VAULT-99`, without credentials.
- **Fix** (`src/server/routes.js`): `verifyAccountAccess(db, req, accountId)` requires an
  `x-api-key` header equal to `accounts.api_secret` when the account's tier is `RESTRICTED`;
  otherwise it returns `403`. The two standard demo accounts stay open so the local UI works
  without login.
- **Limitation**: this is a single shared demo key compared in plain text, not a real
  authentication system. The seeded key is a fake placeholder (`demo_key_vault_0001x`).
- **Regression test**: `CONTROL-04` asserts `403` for unauthenticated portfolio reads and
  order submission on `ACC-VAULT-99`, and `200` when the correct header is sent.

---

## VULN-05: No buying-power check; oversized request bodies

- **Seeded weakness**:
  1. `Orderbook.submitOrder` did not compare order notional with the account's cash, so an
     order for 5,000 BTC-USD (~$472.5M simulated notional) could execute.
  2. `readJsonBody` accepted bodies up to 1 MB.
- **Fix**:
  1. `src/engine/orderbook.js`: for non-synthetic orders, reject if `cash_balance <= 0` or
     `price * size > 5 × cash_balance`. This is a deliberately simple check, loosely inspired
     by the idea of pre-trade credit limits (as in SEC Rule 15c3-5). It is **not** a
     compliance implementation of that rule or of any regulation.
  2. `src/server/routes.js`: `MAX_JSON_BODY_BYTES = 64 * 1024`.
```diff
+ if (!isSynthetic) {
+   const db = this._getDb();
+   if (db) {
+     const accountRow = db.prepare('SELECT cash_balance, margin_used FROM accounts WHERE id = ?').get(accountId);
+     if (!accountRow) {
+       throw new Error(`Unknown account: ${accountId}`);
+     }
+     const orderNotional = price * size;
+     const maxBuyingPower = Number(accountRow.cash_balance) * 5;
+     if (accountRow.cash_balance <= 0 || orderNotional > maxBuyingPower) {
+       throw new Error(
+         `Insufficient buying power / margin limit exceeded: notional $${orderNotional.toFixed(2)} exceeds 5x buying power limit ($${Math.max(0, maxBuyingPower).toFixed(2)})`
+       );
+     }
+   }
+ }
```
- **Regression test**: `CONTROL-05` asserts `400` ("Insufficient buying power") for a
  5,000 BTC-USD market order on `ACC-INST-01`, and `400` ("Payload too large") for a ~70 KB
  JSON body.

---

## How to verify

```bash
node tests/security_pentest_poc.js   # SECURITY CONTROLS SUMMARY: 5 PASSED | 0 FAILED
node tests/e2e.test.js               # E2E SUMMARY: 13 PASSED | 0 FAILED
```

## Known gaps (not addressed)

- No real user authentication or sessions; the server binds to `127.0.0.1` and is intended
  for local use only.
- No rate limiting, CSRF protection, or TLS.
- The SQL console guard and SSRF filter are denylist/hostname-based (see limitations above).
