# Argus Terminal technical debt ledger

Crosschecked 2026-11-08 WIB. All code diffs below are proposal-only and have not changed production source. Source references and removed patch lines were checked against this working tree. Runtime speedups remain unmeasured unless evidence is explicitly cited.

Crosschecked 2026-11-08 WIB against this working tree. Every diff is a proposal only. Prior findings were removed after checking the production fixes.

## Resolved findings

| Earlier finding | Current source evidence |
| --- | --- |
| Whole-array sorting on insertion | `src/engine/orderbook.js:80-92` binary-searches the insertion position; `_insertResting` at 187-194 calls it. Array insertion still shifts elements in O(N). |
| Malformed static URL throws outside decode handling | `src/server/index.js:34-64` catches decoding errors, rejects NUL and checks containment. |
| Webhook redirect escape and unbounded body | `src/server/routes.js:739-786` uses manual redirects, blocks redirect responses and bounds response bytes. |
| Invalid replay retention options and inconsistent retained anchors | `src/engine/lobTimeMachine.js:276-292` validates options; 482-505 rebuilds the retained head anchor before pruning. Fractional options still need a contract decision below. |

## 1. Optional append fast path for already ordered arrivals

Location: `src/engine/orderbook.js:187-194`. Insertion already uses O(log N) comparisons plus O(N) worst-case array movement. When an order belongs at the tail, a final-priority comparison can avoid the binary search and use amortized O(1) push. Other insertion positions retain current costs. No throughput improvement was measured in this crosscheck.

```diff
diff --git a/src/engine/orderbook.js b/src/engine/orderbook.js
--- a/src/engine/orderbook.js
+++ b/src/engine/orderbook.js
@@ -189,6 +189,10 @@
     order._seq = this._seq;
     const isBuy = order.side === 'BUY';
     const targetBook = isBuy ? this.bids : this.asks;
+    if (!targetBook.length || compareFifoPriority(targetBook[targetBook.length - 1], order, isBuy) <= 0) {
+      targetBook.push(order);
+      return;
+    }
     const insertIdx = findBinaryInsertIndex(targetBook, order, isBuy);
     targetBook.splice(insertIdx, 0, order);
   }
```

Validate both sides, equal price/time FIFO, empty books and interior insertions against the existing unit and matching suites. Benchmark realistic arrival distributions before adopting the extra branch.

## 2. Integer option messages accept fractional values by flooring

Location: `src/engine/lobTimeMachine.js:276-289`. Constructor messages promise integer retention and keyframe counts, but inputs such as maxEvents=2.9 and keyframeInterval=1.9 pass finite/range checks and are silently floored. The proposal rejects fractional values while preserving existing integer numeric-string coercion. This is stricter API behavior and should be documented.

```diff
diff --git a/src/engine/lobTimeMachine.js b/src/engine/lobTimeMachine.js
--- a/src/engine/lobTimeMachine.js
+++ b/src/engine/lobTimeMachine.js
@@ -274,7 +274,7 @@
     this.engine = matchingEngine;
 
     if (options.keyframeInterval !== undefined) {
-      if (typeof options.keyframeInterval === 'boolean' || !isFiniteNumber(options.keyframeInterval) || Number(options.keyframeInterval) < 1) {
+      if (typeof options.keyframeInterval === 'boolean' || !isFiniteNumber(options.keyframeInterval) || !Number.isInteger(Number(options.keyframeInterval)) || Number(options.keyframeInterval) < 1) {
         throw new RangeError('Invalid keyframeInterval: must be a positive integer');
       }
       this.keyframeInterval = Math.floor(Number(options.keyframeInterval));
@@ -283,7 +283,7 @@
     }
 
     if (options.maxEvents !== undefined) {
-      if (typeof options.maxEvents === 'boolean' || !isFiniteNumber(options.maxEvents) || Number(options.maxEvents) < 2) {
+      if (typeof options.maxEvents === 'boolean' || !isFiniteNumber(options.maxEvents) || !Number.isInteger(Number(options.maxEvents)) || Number(options.maxEvents) < 2) {
         throw new RangeError('Invalid maxEvents: must be a finite integer >= 2');
       }
       this.maxEvents = Math.floor(Number(options.maxEvents));
```

Validate fractional numbers, integer strings, booleans, NaN, infinity and existing defaults. Retention anchor, timestamp seeking and replay hash tests must retain their behavior.

## 3. Coercing finite check promises an unsound type predicate

Location: `src/engine/validation.js:8-18`. The JSDoc return type is `value is number`, but `isFiniteNumber('12')` and `isFiniteNumber([])` both return true while the original arguments remain a string and an array. TypeScript can therefore narrow callers to an incorrect runtime type. This proposal makes the existing coercion contract explicit and returns a boolean type without changing runtime acceptance. `assertFiniteNumber` is a separate conversion function that returns the converted number. Rejecting whitespace, arrays or custom conversion objects would require a separate API contract decision.

```diff
diff --git a/src/engine/validation.js b/src/engine/validation.js
--- a/src/engine/validation.js
+++ b/src/engine/validation.js
@@ -6,9 +6,10 @@
  */
 
 /**
- * Checks whether a value is a finite number and explicitly NOT a boolean.
+ * Checks whether a value is finite after Number conversion, excluding booleans, null, undefined and empty strings.
+ * A true result does not change or narrow the original value to number.
  * @param {unknown} value
- * @returns {value is number}
+ * @returns {boolean}
  */
 function isFiniteNumber(value) {
   if (typeof value === 'boolean' || value === null || value === undefined || value === '') {
```

Run `npm run typecheck` and the existing validation/engine tests. Add a compile-time negative case showing that a successful `isFiniteNumber` check alone cannot justify number-only methods on an unknown original value. The current checkJs setup uses non-strict settings and broad ambient types, so a passing check does not prove all boundary values are sound.

## 4. Missing slab telemetry displays an invented benchmark and GC claim

Location: `public/js/components.js:817-824`. An absent or zero throughput falls back to 1,845,000 operations/second because the code uses logical OR. Every value also receives a zero-GC label without a GC measurement. The proposal keeps valid numeric zero, reports missing/non-finite telemetry as unavailable and removes the unmeasured GC claim. Numeric strings become unavailable under this explicit numeric response contract.

```diff
diff --git a/public/js/components.js b/public/js/components.js
--- a/public/js/components.js
+++ b/public/js/components.js
@@ -818,9 +818,11 @@
       if (slabPayload) {
         const slabEl = document.getElementById('quant-slab-pill');
         if (slabEl) {
-          const ops = Number(slabPayload.benchmark?.matchOpsPerSec || slabPayload.matchOpsPerSec || 1845000);
-          const opsM = (ops / 1e6).toFixed(2);
-          slabEl.textContent = `SLAB L3: ${opsM}M OPS/S (0 GC)`;
+          const rawOps = slabPayload.benchmark?.matchOpsPerSec ?? slabPayload.matchOpsPerSec;
+          const ops = typeof rawOps === 'number' ? rawOps : NaN;
+          slabEl.textContent = Number.isFinite(ops) && ops >= 0
+            ? `SLAB L3: ${(ops / 1e6).toFixed(2)}M OPS/S`
+            : 'SLAB L3: BENCHMARK UNAVAILABLE';
         }
       }
 
```

Validate payloads with no benchmark, zero, a positive finite number, NaN, infinity and numeric strings using a DOM fixture for quant-slab-pill. Risk and backtest example fallbacks at `public/js/components.js:742-751` and `796-801` need a separate missing-data policy. Their literals must not be presented as measured results.
