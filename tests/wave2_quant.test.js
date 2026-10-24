/**
 * ARGUS TERMINAL — Wave 2 Quantitative, Algorithmic, WASM Slab & Strategic Deck QA Suite
 * Covers:
 *   1. SlabOrderbook (`src/engine/slabOrderbook.js`): WASM helper instantiation, TypedArray
 *      order insertion, strict Price-Time Priority (FIFO) matching, O(1) cancel, and throughput.
 *   2. AlgoExecutionEngine (`src/engine/algoEngine.js`): Avellaneda-Stoikov reservation price math,
 *      TWAP, VWAP, ICEBERG, and AVELLANEDA_STOIKOV execution + historical OHLCV `runBacktest`.
 *   3. QuantRisk (`src/engine/quantRisk.js` & `GET /api/quant/risk`): 10,000-path Monte Carlo
 *      VaR 95%/99%, CVaR Expected Shortfall, VPIN, OBI, Micro-Price, and Quant Copilot briefing.
 *   4. Wave 2 REST Endpoints & Strategic Deck (`GET /api/algos`, `POST /api/algos`,
 *      `POST /api/backtest`, `GET /api/slab-metrics`, and `GET /deck.html` 10-slide verification).
 */

'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { performance } = require('node:perf_hooks');

const { initDatabase } = require('../src/db/database');
const { MatchingEngine } = require('../src/engine/orderbook');
const { MarketSimulator } = require('../src/engine/marketSim');
const {
  SlabOrderbook,
  WASM_BYTES,
  wasmInstance,
  wasmExports,
  SIDE_BUY,
  SIDE_SELL
} = require('../src/engine/slabOrderbook');
const {
  AlgoExecutionEngine,
  computeAvellanedaStoikovQuotes
} = require('../src/engine/algoEngine');
const quantRisk = require('../src/engine/quantRisk');
const { createArgusServer } = require('../src/server/index');

let passCount = 0;
let failCount = 0;

async function runTest(name, fn) {
  try {
    await fn();
    passCount += 1;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failCount += 1;
    console.error(`[FAIL] ${name}`);
    console.error(`       ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : err}`);
  }
}

function httpRequest(baseUrl, method, urlPath, body = null, customHeaders = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlPath, baseUrl);
    const payload = body !== null ? JSON.stringify(body) : null;
    const headers = {
      Accept: 'application/json, text/html, */*',
      ...customHeaders
    };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers,
        timeout: 6000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            // HTML or plain text
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`HTTP timeout: ${method} ${urlPath}`)));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('========================================================================');
  console.log(' ARGUS TERMINAL — WAVE 2 QUANT, ALGO, WASM SLAB & DECK QA SUITE');
  console.log('========================================================================');

  const db = initDatabase({ memory: true });
  const matchingEngine = new MatchingEngine(db);
  const marketSim = new MarketSimulator(matchingEngine, db);

  // ===========================================================================
  // 1. SLAB ORDERBOOK (`src/engine/slabOrderbook.js`)
  // ===========================================================================
  await runTest('1.1 SlabOrderbook: Embedded WebAssembly kernel instantiates and exports priceCrosses, minInt, calcNotionalCents', async () => {
    assert.ok(WASM_BYTES instanceof Uint8Array && WASM_BYTES.byteLength > 40, 'Expected valid WASM_BYTES binary');
    assert.ok(wasmInstance instanceof WebAssembly.Instance, 'Expected valid WebAssembly.Instance');
    assert.equal(typeof wasmExports.priceCrosses, 'function', 'Expected wasmExports.priceCrosses function');
    assert.equal(typeof wasmExports.minInt, 'function', 'Expected wasmExports.minInt function');
    assert.equal(typeof wasmExports.calcNotionalCents, 'function', 'Expected wasmExports.calcNotionalCents function');

    // Verify branchless WASM priceCrosses semantics
    assert.equal(wasmExports.priceCrosses(SIDE_BUY, 1000, 995), 1, 'BUY at 1000 crosses resting ASK at 995');
    assert.equal(wasmExports.priceCrosses(SIDE_BUY, 990, 995), 0, 'BUY at 990 does not cross resting ASK at 995');
    assert.equal(wasmExports.priceCrosses(SIDE_SELL, 990, 995), 1, 'SELL at 990 crosses resting BID at 995');
    assert.equal(wasmExports.priceCrosses(SIDE_SELL, 1000, 995), 0, 'SELL at 1000 does not cross resting BID at 995');
    assert.equal(wasmExports.minInt(42, 19), 19, 'minInt(42, 19) === 19');
  });

  await runTest('1.2 SlabOrderbook: TypedArray insertion, strict Price-Time Priority (FIFO) matching, and O(1) cancel', async () => {
    const slab = new SlabOrderbook({ symbol: 'BTC-USD', capacity: 4096, tickSize: 0.5, lotSize: 0.01 });

    // Insert 3 resting SELL orders: two at 94501.0 (IDs 101, 102) and one better ask at 94500.5 (ID 103)
    const r1 = slab.submitSlabOrder('SELL', 94501.0, 1.5, 101);
    assert.equal(r1.filledSize, 0);
    assert.equal(r1.restingId, 101);

    const r2 = slab.submitSlabOrder('SELL', 94501.0, 2.0, 102);
    assert.equal(r2.filledSize, 0);
    assert.equal(r2.restingId, 102);

    const r3 = slab.submitSlabOrder('SELL', 94500.5, 1.0, 103);
    assert.equal(r3.filledSize, 0);
    assert.equal(r3.restingId, 103);

    assert.equal(slab.activeOrders, 3, 'Expected 3 active resting orders in slab');

    // Incoming BUY for 2.0 @ 94501.0 must match ID 103 (1.0 @ 94500.5) first, then FIFO match ID 101 (1.0 of 1.5 @ 94501.0)
    const m1 = slab.submitSlabOrder('BUY', 94501.0, 2.0, 201);
    assert.ok(Math.abs(m1.filledSize - 2.0) < 1e-6, `Expected full 2.0 fill, got ${m1.filledSize}`);
    assert.equal(m1.matchCount, 2, 'Expected 2 maker orders hit (103 fully filled, 101 partially filled)');
    assert.equal(slab.activeOrders, 2, 'Expected 2 resting asks remaining (101 partial + 102 full)');

    // Verify remaining size on head ask (ID 101) is 0.5
    const snapBeforeCancel = slab.getSnapshot(5);
    assert.equal(snapBeforeCancel.asks.length, 1, 'Remaining asks are both at 94501.0');
    assert.ok(Math.abs(snapBeforeCancel.asks[0].size - 2.5) < 1e-4, '0.5 (ID 101) + 2.0 (ID 102) = 2.5');

    // O(1) cancel of resting order ID 102
    const cancelled = slab.cancelSlabOrder(102);
    assert.equal(cancelled, true, 'Expected cancelSlabOrder(102) to return true');
    assert.equal(slab.cancelSlabOrder(102), false, 'Second cancel of 102 must return false');
    assert.equal(slab.activeOrders, 1, 'Expected 1 resting order remaining after O(1) cancel');

    const metrics = slab.getSlabMetrics();
    assert.equal(metrics.wasmAccelerated, true);
    assert.equal(metrics.activeOrders, 1);
    assert.ok(metrics.totalVolume >= 2.0);
  });

  await runTest('1.3 SlabOrderbook: throughput smoke test (10,000 insert/match/cancel ops)', async () => {
    const slab = new SlabOrderbook({ symbol: 'ETH-USD', capacity: 16384, tickSize: 0.1, lotSize: 0.01 });
    const t0 = performance.now();
    for (let i = 1; i <= 5000; i++) {
      slab.submitSlabOrder(SIDE_BUY, 3175.0 - (i % 10) * 0.1, 0.5, i);
      if (i % 2 === 0) {
        slab.submitSlabOrder(SIDE_SELL, 3175.0, 0.25, 5000 + i);
      } else {
        slab.cancelSlabOrder(i);
      }
    }
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 500, `Expected 10,000 slab operations in < 500ms, took ${elapsedMs.toFixed(2)}ms`);
  });

  // ===========================================================================
  // 2. ALGO EXECUTION ENGINE & BACKTESTER (`src/engine/algoEngine.js`)
  // ===========================================================================
  await runTest('2.1 AlgoExecutionEngine: Avellaneda-Stoikov reservation price r(s,q,t) = s - q*gamma*sigma^2*(T-t) inventory skew', async () => {
    const neutral = computeAvellanedaStoikovQuotes({
      midPrice: 94500,
      inventoryQty: 0,
      gamma: 0.1,
      sigma: 20,
      kappa: 1.5,
      timeRemaining: 1.0,
      tickSize: 0.5
    });
    assert.equal(neutral.reservationPrice, 94500, 'Zero inventory reservationPrice equals midPrice');
    assert.ok(neutral.optimalBid < neutral.reservationPrice && neutral.optimalAsk > neutral.reservationPrice);

    const longInv = computeAvellanedaStoikovQuotes({
      midPrice: 94500,
      inventoryQty: 2.5,
      gamma: 0.1,
      sigma: 20,
      kappa: 1.5,
      timeRemaining: 1.0,
      tickSize: 0.5
    });
    const shortInv = computeAvellanedaStoikovQuotes({
      midPrice: 94500,
      inventoryQty: -2.5,
      gamma: 0.1,
      sigma: 20,
      kappa: 1.5,
      timeRemaining: 1.0,
      tickSize: 0.5
    });
    assert.ok(longInv.reservationPrice < neutral.reservationPrice, 'Long inventory shifts reservation price down to attract buyers');
    assert.ok(shortInv.reservationPrice > neutral.reservationPrice, 'Short inventory shifts reservation price up to attract sellers');
  });

  await runTest('2.2 AlgoExecutionEngine: TWAP, VWAP, ICEBERG, and AVELLANEDA_STOIKOV child order slicing & lifecycle', async () => {
    const algoEngine = new AlgoExecutionEngine(matchingEngine, db, { defaultIntervalMs: 5000 });
    try {
      const strategies = ['TWAP', 'VWAP', 'ICEBERG', 'AVELLANEDA_STOIKOV'];
      for (const strategy of strategies) {
        const started = algoEngine.startAlgo({
          accountId: 'ACC-INST-01',
          symbol: 'BTC-USD',
          strategy,
          side: 'BUY',
          totalSize: 0.12,
          slices: 3,
          displaySize: 0.04,
          intervalMs: 10000
        });
        assert.ok(started.id, `Expected algo id for ${strategy}`);
        assert.equal(started.strategy, strategy);
        assert.equal(started.completedSlices, 1, `First child slice of ${strategy} executes immediately`);
        assert.ok(started.filledSize > 0, `Expected positive filledSize on first slice of ${strategy}`);

        // Step remaining slices deterministically
        algoEngine.stepAlgo(started.id);
        const completed = algoEngine.stepAlgo(started.id);
        assert.equal(completed.status, 'COMPLETED', `Expected ${strategy} algo to reach COMPLETED after 3 slices`);
        assert.equal(completed.progressPct, 100);
      }

      const allAlgos = algoEngine.getAlgos();
      assert.ok(allAlgos.length >= 4, 'Expected all 4 parent algos in getAlgos()');
    } finally {
      algoEngine.stopAll();
    }
  });

  await runTest('2.3 AlgoExecutionEngine: Historical OHLCV runBacktest (EMA_CROSS, MEAN_REVERSION_BOLLINGER, AVELLANEDA_MM)', async () => {
    const algoEngine = new AlgoExecutionEngine(matchingEngine, db);
    for (const strategy of ['EMA_CROSS', 'MEAN_REVERSION_BOLLINGER', 'AVELLANEDA_MM']) {
      const bt = algoEngine.runBacktest({
        symbol: 'BTC-USD',
        strategy,
        initialCapital: 1000000
      });
      assert.equal(bt.symbol, 'BTC-USD');
      assert.equal(bt.strategy, strategy);
      assert.equal(typeof bt.finalEquity, 'number');
      assert.equal(typeof bt.sharpeRatio, 'number');
      assert.equal(typeof bt.sortinoRatio, 'number');
      assert.equal(typeof bt.maxDrawdownPct, 'number');
      assert.ok(Array.isArray(bt.equityCurve) && bt.equityCurve.length >= 10, `Expected non-empty equityCurve for ${strategy}`);
    }
  });

  // ===========================================================================
  // 3. QUANT RISK ENGINE (`src/engine/quantRisk.js`)
  // ===========================================================================
  await runTest('3.1 QuantRisk: 10,000-Path Monte Carlo VaR 95%/99%, CVaR Expected Shortfall, VPIN, OBI, Micro-Price & Copilot', async () => {
    const report = quantRisk.computeQuantRiskReport({
      db,
      engine: matchingEngine,
      marketSim,
      accountId: 'ACC-INST-01',
      symbol: 'BTC-USD',
      paths: 10000
    });

    assert.equal(report.paths, 10000, 'Expected 10,000 Monte Carlo paths');
    assert.ok(report.var95 > 0, `Expected positive VaR 95%, got ${report.var95}`);
    assert.ok(report.var99 >= report.var95, `Expected VaR 99% (${report.var99}) >= VaR 95% (${report.var95})`);
    assert.ok(report.cvar99 >= report.var99, `Expected CVaR 99% (${report.cvar99}) >= VaR 99% (${report.var99})`);

    // Microstructure bounds
    assert.ok(report.vpin >= 0 && report.vpin <= 1, `Expected VPIN in [0, 1], got ${report.vpin}`);
    assert.ok(report.obi >= -1 && report.obi <= 1, `Expected OBI in [-1, 1], got ${report.obi}`);
    assert.ok(report.microPrice > 0, `Expected positive Stoikov Micro-Price, got ${report.microPrice}`);
    assert.ok(report.kyleLambda > 0, 'Expected positive Kyle Lambda price impact coefficient');

    // Quant Copilot briefing
    assert.ok(report.copilot && typeof report.copilot.headline === 'string', 'Expected Quant Copilot headline');
    assert.ok(report.copilot.kellyFraction > 0 && report.copilot.kellyFraction <= 1, 'Expected valid Kelly fraction');
    assert.ok(Array.isArray(report.copilot.actionItems) && report.copilot.actionItems.length >= 2);
  });

  // ===========================================================================
  // 4. WAVE 2 REST ENDPOINTS & STRATEGIC 10-SLIDE HTML DECK
  // ===========================================================================
  let appServer = null;
  try {
    appServer = await createArgusServer({ port: 0, dbMemory: true, simIntervalMs: 1000 });
    const baseUrl = appServer.url;

    await runTest('4.1 GET /api/quant/risk returns 200 OK with 10,000-path VaR 95%/99%, CVaR, VPIN, OBI, Micro-Price & Copilot', async () => {
      const res = await httpRequest(baseUrl, 'GET', '/api/quant/risk?accountId=ACC-INST-01&symbol=BTC-USD');
      assert.equal(res.status, 200, `Expected 200 OK from GET /api/quant/risk, got ${res.status}`);
      assert.equal(res.json.paths, 10000);
      assert.ok(res.json.var99 >= res.json.var95 && res.json.cvar99 >= res.json.var99);
      assert.equal(typeof res.json.vpin, 'number');
      assert.equal(typeof res.json.obi, 'number');
      assert.equal(typeof res.json.microPrice, 'number');
      assert.ok(res.json.copilot && res.json.copilot.summary);
    });

    await runTest('4.2 POST /api/algos & GET /api/algos launch and list institutional algorithmic executions', async () => {
      const postRes = await httpRequest(baseUrl, 'POST', '/api/algos', {
        accountId: 'ACC-INST-01',
        symbol: 'BTC-USD',
        strategy: 'AVELLANEDA_STOIKOV',
        side: 'BUY',
        totalSize: 0.1,
        slices: 2
      });
      assert.ok(postRes.status === 200 || postRes.status === 201, `Expected 200/201 from POST /api/algos, got ${postRes.status}`);
      assert.ok(postRes.json.id || postRes.json.algo?.id, 'Expected created algo ID');

      const getRes = await httpRequest(baseUrl, 'GET', '/api/algos');
      assert.equal(getRes.status, 200, `Expected 200 OK from GET /api/algos, got ${getRes.status}`);
      const list = getRes.json.algos || getRes.json.executions || getRes.json;
      assert.ok(Array.isArray(list) && list.length >= 1, 'Expected non-empty algos array');
    });

    await runTest('4.3 POST /api/backtest runs historical OHLCV strategy simulation and returns equityCurve & Sharpe', async () => {
      const res = await httpRequest(baseUrl, 'POST', '/api/backtest', {
        symbol: 'BTC-USD',
        strategy: 'EMA_CROSS',
        initialCapital: 1000000
      });
      assert.equal(res.status, 200, `Expected 200 OK from POST /api/backtest, got ${res.status}`);
      assert.equal(res.json.symbol, 'BTC-USD');
      assert.equal(typeof res.json.sharpeRatio, 'number');
      assert.ok(Array.isArray(res.json.equityCurve) && res.json.equityCurve.length > 0);
    });

    await runTest('4.4 GET /api/slab-metrics returns 200 OK with TypedArray/WASM slab orderbook telemetry', async () => {
      const res = await httpRequest(baseUrl, 'GET', '/api/slab-metrics?symbol=BTC-USD');
      assert.equal(res.status, 200, `Expected 200 OK from GET /api/slab-metrics, got ${res.status}`);
      assert.ok(res.json.capacity > 0, 'Expected positive slab capacity');
    });

    await runTest('4.5 GET /deck.html returns 200 OK Strategic 10-Slide HTML Deck with 10 slides & offline High-DPI Canvas charts', async () => {
      const res = await httpRequest(baseUrl, 'GET', '/deck.html');
      assert.equal(res.status, 200, `Expected 200 OK from GET /deck.html, got ${res.status}`);
      assert.ok(res.headers['content-type'].includes('text/html'), 'Expected text/html Content-Type');

      const slideMatches = res.text.match(/class="slide(\s+active)?"\s+data-slide="\d+"/g) || [];
      assert.equal(slideMatches.length, 10, `Expected exactly 10 slides in /deck.html, found ${slideMatches.length}`);
      assert.ok(res.text.includes('canvasSlide1') && res.text.includes('canvasSlide10'), 'Expected interactive High-DPI canvases across slides');
      assert.ok(res.text.includes('toggleSpeakerNotes'), 'Expected speaker notes [N] support');
      assert.ok(!res.text.includes('cdn.jsdelivr.net'), 'Deck must work 100% offline with zero external CDN script dependencies');
    });
  } finally {
    if (appServer) {
      await appServer.stop();
    }
  }

  console.log('========================================================================');
  console.log(` WAVE 2 QA SUMMARY: ${passCount} PASSED | ${failCount} FAILED`);
  console.log('========================================================================');

  process.exit(failCount === 0 ? 0 : 1);
})();
