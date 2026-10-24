# Argus Terminal — Matching Engine Ablation Benchmark Report

> **Benchmark Metadata**
> - **Script**: `benchmarks/matching_bench.js` (`npm run bench` / `node --expose-gc benchmarks/matching_bench.js`)
> - **Recorded Output**: `benchmarks/results/latest.json`
> - **Workload**: `250,000` deterministic limit-order operations on `BTC-USD` (`seed = 20261024`, `205,208` limit submissions + `44,792` cancel attempts)
> - **Machine & Runtime**: Intel Core i5-10300H @ 2.50 GHz (8 logical cores, 15.8 GB RAM), Windows 10 x64, Node.js `v24.20.0`
> - **Timing**: `process.hrtime.bigint()` (measured timer call overhead on this machine: `100 ns` median / `140 ns` mean)

---

## 1. Five-Mode Ablation Summary (`250,000` Operations)

To isolate where time is actually spent between the server's default `Orderbook` (`src/engine/orderbook.js`) and the preallocated `SlabOrderbook` (`src/engine/slabOrderbook.js`), the benchmark runs the exact same 250,000-operation sequence across five configurations:

| Mode | Configuration | Median Elapsed (`ms`) | Median Throughput (`ops/sec`) | `p50` (`µs`) | `p99` (`µs`) | `p99.9` (`µs`) | Fills / Cancels |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| **1. `orderbook-sqlite`** | `Orderbook` + in-memory SQLite (`BEGIN/COMMIT` + `INSERT` per fill) | `24,983.91 ms` | `10,006 ops/s` | `30.4 µs` | `524.4 µs` | `2,392.8 µs` | `187,880 / 10,496` |
| **2. `orderbook-memory`** | `Orderbook` in memory (V8 object arrays, `Array.sort` on insert, per-fill objects, `crypto.randomBytes(2)`) | `9,667.80 ms` | `25,859 ops/s` | `17.4 µs` | `97.7 µs` | `312.3 µs` | `187,880 / 10,496` |
| **3. `orderbook-cheap-ids`** | `Orderbook` in memory with `crypto.randomBytes(2)` replaced by a counter | `6,576.41 ms` | `38,015 ops/s` | `12.3 µs` | `76.3 µs` | `336.5 µs` | `187,880 / 10,496` |
| **4. `slab-js-kernel`** | `SlabOrderbook` (`TypedArray` arena + intrusive DLL + `O(1)` cancel) with plain JS helper functions | `76.79 ms` | **`3,255,450 ops/s`** | `0.3 µs` | `2.0 µs` | `5.0 µs` | `187,880 / 10,496` |
| **5. `slab-wasm`** | `SlabOrderbook` as shipped (`TypedArray` arena + 3 tiny WASM helper calls) | `88.29 ms` | **`2,831,629 ops/s`** | `0.3 µs` | `2.1 µs` | `21.7 µs` | `187,880 / 10,496` |

All five modes produce identical deterministic state at completion (`187,880` fills, `10,496` cancels, `14,259.37` filled volume, `20` final resting orders; `outcomeCrossCheck = true`).

---

## 2. What Drives the Speedup (and What Does Not)

1. **SQLite synchronous persistence (`2.58x` slowdown vs. in-memory `Orderbook`)**:
   In `orderbook-sqlite`, each crossing order wraps its fills in a SQLite transaction and inserts trade rows, bringing throughput to ~`10.0k ops/sec`.
2. **CSPRNG per fill (`1.47x` slowdown in `orderbook-memory`)**:
   Calling `crypto.randomBytes(2)` on every fill in `Orderbook` accounts for ~`3.1 seconds` across `187,880` fills (`25.9k` → `38.0k ops/sec` when replaced with a counter).
3. **Data structure & allocation layout (`85.6x` speedup from `orderbook-cheap-ids` to `slab-js-kernel`, `109.5x` vs `orderbook-memory`)**:
   The jump from ~`38k ops/sec` to ~`2.8M–3.3M ops/sec` comes from:
   - Replacing per-order V8 object allocations, per-fill result arrays, and `getSnapshot(5)` calls on every submit with preallocated `TypedArray` columns (`Int32Array`, `Float64Array`, `Uint8Array`, `capacity = 262,144`) and a 64-slot ring result pool.
   - Replacing `Array.prototype.sort` on resting insert and `Array.findIndex` + `Array.splice` on cancel with an intrusive doubly-linked list and direct `idToSlot` array lookup for `O(1)` cancellation.
4. **JS-to-WASM call boundary (`0.87x` — slightly slower than pure JS for 3-instruction helpers)**:
   Replacing the three tiny WebAssembly functions (`priceCrosses`, `minInt`, `calcNotionalCents`) with equivalent inline JavaScript functions (`slab-js-kernel`) is ~`13%` faster (`3.26M` vs `2.83M ops/sec`) because V8 TurboFan inlines trivial arithmetic directly, whereas calling across the JS→WASM boundary for a 3-instruction `select` incurs boundary overhead. The embedded WASM module is kept as an inspectable binary WebAssembly example, not as the source of the speedup.
5. **Sub-microsecond per-op timings**:
   Because `process.hrtime.bigint()` itself takes ~`100–140 ns` per pair of calls on Windows, per-operation latency numbers around `300 ns` (`0.3 µs`) on `SlabOrderbook` include significant timer instrumentation overhead. Batch elapsed time (`76.8 ms`–`88.3 ms` for `250,000` ops, or `307–353 ns/op` mean) is the more reliable metric.
