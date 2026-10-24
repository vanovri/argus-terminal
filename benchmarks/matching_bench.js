'use strict';

/**
 * Argus Terminal — matching-engine microbenchmark (ablation ladder)
 *
 * Replays one deterministic workload (250,000 operations, seed 20261024) through
 * several engine variants so that each difference in timing can be attributed to
 * one concrete change, instead of comparing two engines that do different work:
 *
 *   A. orderbook-sqlite     `Orderbook` (src/engine/orderbook.js) with an in-memory
 *                           (`:memory:`) SQLite DB attached. Orders are flagged
 *                           synthetic, so persistence = one transaction + one
 *                           `INSERT INTO trades` per fill (no account updates).
 *   B. orderbook-memory     `Orderbook` with persistence disabled (`_getDb() -> null`).
 *                           Still builds full fill records (string trade IDs that call
 *                           `crypto.randomBytes`, `Date.now()` timestamps), runs
 *                           `getSnapshot(5)` per order and re-sorts the side array on
 *                           every resting insert.
 *   C. orderbook-cheap-ids  Same as B, but the `crypto.randomBytes(2)` suffix in
 *                           `nextId()` is replaced by a constant string (source
 *                           substitution, see `loadVariant`). Isolates ID-generation cost.
 *   D. slab-js-kernel       `SlabOrderbook` (src/engine/slabOrderbook.js) with the three
 *                           WebAssembly kernel calls replaced by equivalent plain JS
 *                           functions (source substitution). Isolates the WASM effect.
 *   E. slab-wasm            `SlabOrderbook` exactly as shipped (TypedArray slab +
 *                           WASM kernel). Returns a pooled summary object per order,
 *                           not per-fill records.
 *
 * Fairness rules applied to every variant:
 *   - identical pre-generated workload, fresh instance per timed pass, empty starting
 *     book (the Orderbook's 36 seeded market-maker orders are cleared and its
 *     auto-replenish is disabled, because the slab book has neither);
 *   - one untimed full warm-up pass per variant before any timing;
 *   - throughput passes contain no per-op timers; variants are interleaved
 *     round-robin across repeats; median / min / max are reported;
 *   - latency percentiles come from a separate pass with `process.hrtime.bigint()`
 *     around each op (the timer's own overhead is measured and reported);
 *   - fills / cancels / filled volume are cross-checked between variants.
 *
 * Limitations: single machine, single process, microbenchmark of the matching core
 * only (no network, no WebSocket fan-out, no risk checks). Numbers vary run to run.
 *
 * Usage:  node --expose-gc benchmarks/matching_bench.js        (gc flag optional)
 * Output: JSON on stdout + benchmarks/results/latest.json
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const { Orderbook } = require('../src/engine/orderbook');
const { SlabOrderbook, SIDE_BUY, SIDE_SELL } = require('../src/engine/slabOrderbook');
const { initDatabase } = require('../src/db/database');

const TOTAL_OPERATIONS = Number(process.env.BENCH_OPS || 250000);
const REPEATS = Number(process.env.BENCH_REPEATS || 5);
const SQLITE_REPEATS = Number(process.env.BENCH_SQLITE_REPEATS || 3);

const OP_SUBMIT = 0;
const OP_CANCEL = 1;

const INSTRUMENT = {
  symbol: 'BTC-USD',
  name: 'Bitcoin Spot (simulated)',
  asset_class: 'CRYPTO',
  base_price: 94500.0,
  tick_size: 0.50,
  lot_size: 0.01
};

// ---------------------------------------------------------------------------
// Variant loading by explicit source substitution (engine files stay untouched)
// ---------------------------------------------------------------------------

/**
 * Compile a copy of an engine module with exact string replacements applied.
 * Throws if any replacement target is not found exactly once, so an ablation can
 * never silently degrade into "no change".
 */
function loadVariant(relPath, replacements) {
  const filename = path.resolve(__dirname, relPath);
  let src = fs.readFileSync(filename, 'utf8');
  for (const [target, replacement] of replacements) {
    const count = src.split(target).length - 1;
    if (count !== 1) {
      throw new Error(`loadVariant(${relPath}): expected exactly 1 match for ${JSON.stringify(target)}, found ${count}`);
    }
    src = src.replace(target, replacement);
  }
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(src, filename);
  return m.exports;
}

const { Orderbook: OrderbookCheapIds } = loadVariant('../src/engine/orderbook.js', [
  ["const rand = crypto.randomBytes(2).toString('hex').toUpperCase();", "const rand = '0000';"]
]);

const { SlabOrderbook: SlabOrderbookJsKernel } = loadVariant('../src/engine/slabOrderbook.js', [
  ['const wasmPriceCrosses = wasmExports.priceCrosses;',
    'const wasmPriceCrosses = (s, a, b) => ((s === 0 ? a >= b : a <= b) ? 1 : 0);'],
  ['const wasmMinInt = wasmExports.minInt;',
    'const wasmMinInt = (a, b) => (a < b ? a : b);'],
  ['const wasmCalcNotionalCents = wasmExports.calcNotionalCents;',
    'const wasmCalcNotionalCents = (p, l, s) => Math.imul(Math.imul(p, l), s);']
]);

// ---------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------

function createPrng(seed) {
  let state = seed >>> 0;
  return function nextRand() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Pre-generate the workload into flat TypedArrays so the harness does not allocate
 * while timing. Mix: ~18% cancels of a recently submitted order; remaining submits
 * are 62% aggressive (cross mid by 1..12 ticks) / 38% passive (1..8 ticks away).
 */
function generateWorkload(numOps) {
  const rand = createPrng(20261024);
  const opTypes = new Uint8Array(numOps);
  const opSides = new Uint8Array(numOps);
  const opPrices = new Float64Array(numOps);
  const opSizes = new Float64Array(numOps);
  const opOrderIds = new Int32Array(numOps);
  const opCancelTargets = new Int32Array(numOps);
  const opIdStrings = new Array(numOps);
  const opCancelStrings = new Array(numOps);

  const centerPrice = INSTRUMENT.base_price;
  const tickSize = INSTRUMENT.tick_size;
  const lotSize = INSTRUMENT.lot_size;

  for (let i = 0; i < numOps; i++) {
    const u = rand();
    const orderId = i + 1;
    opOrderIds[i] = orderId;
    opIdStrings[i] = String(orderId);

    if (u < 0.18 && i > 32) {
      opTypes[i] = OP_CANCEL;
      const lookback = 1 + ((rand() * 24) | 0);
      opCancelTargets[i] = Math.max(1, orderId - lookback);
      opCancelStrings[i] = String(opCancelTargets[i]);
      continue;
    }

    opTypes[i] = OP_SUBMIT;
    const side = rand() < 0.5 ? SIDE_BUY : SIDE_SELL;
    opSides[i] = side;

    const isAggressive = rand() < 0.62;
    let tickOffset;
    if (isAggressive) {
      tickOffset = side === SIDE_BUY ? 1 + ((rand() * 12) | 0) : -(1 + ((rand() * 12) | 0));
    } else {
      tickOffset = side === SIDE_BUY ? -(1 + ((rand() * 8) | 0)) : 1 + ((rand() * 8) | 0);
    }

    opPrices[i] = centerPrice + tickOffset * tickSize;
    const baseLots = isAggressive ? 4 + ((rand() * 28) | 0) : 1 + ((rand() * 18) | 0);
    opSizes[i] = Number((baseLots * lotSize).toFixed(4));
  }

  return { numOps, opTypes, opSides, opPrices, opSizes, opOrderIds, opCancelTargets, opIdStrings, opCancelStrings };
}

// ---------------------------------------------------------------------------
// Engine adapters: each returns { submit(i) -> fills, cancel(i) -> bool, depth() }
// ---------------------------------------------------------------------------

function makeOrderbookAdapter(BookClass, w, db) {
  const book = new BookClass(INSTRUMENT, db || null);
  if (!db) {
    book._getDb = () => null;
  }
  book._replenishBookLiquidity = () => {};
  book.bids = [];
  book.asks = [];
  const order = {
    id: '', accountId: 'ACC-BENCH-01', symbol: 'BTC-USD', side: 'BUY',
    type: 'LIMIT', price: 0, size: 0, isSynthetic: true
  };
  return {
    submit(i) {
      order.id = w.opIdStrings[i];
      order.side = w.opSides[i] === SIDE_BUY ? 'BUY' : 'SELL';
      order.price = w.opPrices[i];
      order.size = w.opSizes[i];
      const res = book.submitOrder(order);
      let vol = 0;
      for (let k = 0; k < res.fills.length; k++) vol += res.fills[k].size;
      lastVolume = vol;
      return res.fills.length;
    },
    cancel(i) {
      return book.cancelOrder(w.opCancelStrings[i]) !== null;
    },
    depth() {
      return book.bids.length + book.asks.length;
    }
  };
}

function makeSlabAdapter(SlabClass, w) {
  const book = new SlabClass(262144, INSTRUMENT.tick_size, INSTRUMENT.lot_size);
  return {
    submit(i) {
      const res = book.submitSlabOrder(w.opSides[i], w.opPrices[i], w.opSizes[i], w.opOrderIds[i]);
      lastVolume = res.filledSize;
      return res.matchCount;
    },
    cancel(i) {
      return book.cancelSlabOrder(w.opCancelTargets[i]);
    },
    depth() {
      return book.activeOrders;
    }
  };
}

let lastVolume = 0;

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

function runPass(adapter, w) {
  const { numOps, opTypes } = w;
  let fills = 0;
  let cancels = 0;
  let volume = 0;
  let maxDepth = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < numOps; i++) {
    if (opTypes[i] === OP_SUBMIT) {
      fills += adapter.submit(i);
      volume += lastVolume;
    } else if (adapter.cancel(i)) {
      cancels += 1;
    }
  }
  const t1 = process.hrtime.bigint();
  // depth sampled once after the pass (outside timing)
  maxDepth = adapter.depth();
  return { elapsedMs: Number(t1 - t0) / 1e6, fills, cancels, volume, finalDepth: maxDepth };
}

function runLatencyPass(adapter, w) {
  const { numOps, opTypes } = w;
  const lat = new Float64Array(numOps);
  for (let i = 0; i < numOps; i++) {
    const t0 = process.hrtime.bigint();
    if (opTypes[i] === OP_SUBMIT) {
      adapter.submit(i);
    } else {
      adapter.cancel(i);
    }
    lat[i] = Number(process.hrtime.bigint() - t0);
  }
  return percentiles(lat);
}

function measureTimerOverheadNs(n = 200000) {
  const lat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    lat[i] = Number(process.hrtime.bigint() - t0);
  }
  return percentiles(lat);
}

function percentiles(arr) {
  const sorted = Float64Array.from(arr).sort();
  const n = sorted.length;
  const pick = (p) => sorted[Math.min(n - 1, Math.floor((p / 100) * n))];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  return {
    meanNs: Math.round(sum / n),
    p50Ns: pick(50),
    p95Ns: pick(95),
    p99Ns: pick(99),
    p999Ns: pick(99.9),
    maxNs: sorted[n - 1]
  };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function heapDeltaOfPass(makeAdapter, w) {
  const adapter = makeAdapter();
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  runPass(adapter, w);
  const after = process.memoryUsage().heapUsed;
  return after - before; // signed; GC may run mid-pass, so this is indicative only
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function runMatchingBenchmark(numOps = TOTAL_OPERATIONS) {
  const w = generateWorkload(numOps);
  let sqliteDb = null;

  const variants = [
    {
      key: 'orderbook-sqlite',
      description: 'Orderbook + in-memory SQLite (1 transaction and 1 trade INSERT per fill)',
      repeats: SQLITE_REPEATS,
      make: () => {
        sqliteDb = initDatabase({ memory: true });
        return makeOrderbookAdapter(Orderbook, w, sqliteDb);
      }
    },
    {
      key: 'orderbook-memory',
      description: 'Orderbook, persistence disabled (object arrays, sort on insert, per-fill records)',
      repeats: REPEATS,
      make: () => makeOrderbookAdapter(Orderbook, w, null)
    },
    {
      key: 'orderbook-cheap-ids',
      description: 'Orderbook, persistence disabled, crypto.randomBytes trade-ID suffix replaced by a constant',
      repeats: REPEATS,
      make: () => makeOrderbookAdapter(OrderbookCheapIds, w, null)
    },
    {
      key: 'slab-js-kernel',
      description: 'SlabOrderbook with the 3 WASM kernel calls replaced by equivalent JS functions',
      repeats: REPEATS,
      make: () => makeSlabAdapter(SlabOrderbookJsKernel, w)
    },
    {
      key: 'slab-wasm',
      description: 'SlabOrderbook as shipped (TypedArray slab + WASM kernel)',
      repeats: REPEATS,
      make: () => makeSlabAdapter(SlabOrderbook, w)
    }
  ];

  // Warm-up: one untimed full pass per variant
  for (const v of variants) {
    v.passes = [];
    v.warmup = runPass(v.make(), w);
  }

  // Timed throughput passes, interleaved round-robin
  const maxRepeats = Math.max(...variants.map((v) => v.repeats));
  for (let r = 0; r < maxRepeats; r++) {
    for (const v of variants) {
      if (r < v.repeats) v.passes.push(runPass(v.make(), w));
    }
  }

  const timerOverhead = measureTimerOverheadNs();

  const results = {};
  for (const v of variants) {
    const elapsed = v.passes.map((p) => p.elapsedMs);
    const medMs = median(elapsed);
    const ref = v.passes[0];
    results[v.key] = {
      description: v.description,
      timedPasses: v.passes.length,
      elapsedMs: {
        median: Number(medMs.toFixed(2)),
        min: Number(Math.min(...elapsed).toFixed(2)),
        max: Number(Math.max(...elapsed).toFixed(2))
      },
      opsPerSecMedian: Math.round(numOps / (medMs / 1000)),
      meanNsPerOpMedian: Math.round((medMs * 1e6) / numOps),
      fills: ref.fills,
      cancels: ref.cancels,
      filledVolume: Number(ref.volume.toFixed(4)),
      finalRestingOrders: ref.finalDepth,
      latency: runLatencyPass(v.make(), w),
      heapUsedDeltaBytes: heapDeltaOfPass(v.make, w)
    };
  }

  const ratio = (a, b) => Number((results[a].elapsedMs.median / results[b].elapsedMs.median).toFixed(2));
  const sameOutcome = (a, b) =>
    results[a].fills === results[b].fills &&
    results[a].cancels === results[b].cancels &&
    Math.abs(results[a].filledVolume - results[b].filledVolume) < 1e-6;

  const cpus = os.cpus();
  return {
    timestamp: new Date().toISOString(),
    machine: {
      cpu: cpus[0] ? cpus[0].model.trim() : 'unknown',
      logicalCores: cpus.length,
      totalMemGB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      os: `${os.type()} ${os.release()} (${process.arch})`,
      node: process.version,
      gcExposed: Boolean(global.gc)
    },
    workload: {
      operations: numOps,
      seed: 20261024,
      submits: numOps - w.opTypes.reduce((s, t) => s + t, 0),
      cancelAttempts: w.opTypes.reduce((s, t) => s + t, 0)
    },
    timerOverheadNs: timerOverhead,
    results,
    // "X is N times slower than Y" = median elapsed(X) / median elapsed(Y)
    slowdownRatios: {
      orderbookSqlite_vs_orderbookMemory: ratio('orderbook-sqlite', 'orderbook-memory'),
      orderbookMemory_vs_orderbookCheapIds: ratio('orderbook-memory', 'orderbook-cheap-ids'),
      orderbookCheapIds_vs_slabJsKernel: ratio('orderbook-cheap-ids', 'slab-js-kernel'),
      slabJsKernel_vs_slabWasm: ratio('slab-js-kernel', 'slab-wasm'),
      orderbookMemory_vs_slabWasm: ratio('orderbook-memory', 'slab-wasm')
    },
    outcomeCrossCheck: {
      orderbookMemory_equals_slabWasm: sameOutcome('orderbook-memory', 'slab-wasm'),
      slabJsKernel_equals_slabWasm: sameOutcome('slab-js-kernel', 'slab-wasm'),
      orderbookSqlite_equals_orderbookMemory: sameOutcome('orderbook-sqlite', 'orderbook-memory')
    }
  };
}

if (require.main === module) {
  const report = runMatchingBenchmark(TOTAL_OPERATIONS);
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'latest.json'), json + '\n');
}

module.exports = {
  runMatchingBenchmark,
  generateWorkload,
  TOTAL_OPERATIONS
};
