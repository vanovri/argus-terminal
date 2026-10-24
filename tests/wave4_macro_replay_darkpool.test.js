/**
 * ARGUS TERMINAL — Wave 4 Macro Yield Curve (NSS), Fixed Income Bond Desk,
 *                  LOB Replay Time-Machine & Dark Pool Crossing Network QA Suite
 * Covers:
 *   1. Suite 1 — Nelson-Siegel-Svensson Yield Curve, OLS Calibration & Fixed Income Bond Desk (`src/engine/yieldCurveFixedIncome.js`)
 *   2. Suite 2 — Limit Order Book (LOB) Replay Time-Machine & SHA-256 State Hash (`src/engine/lobTimeMachine.js`)
 *   3. Suite 3 — Institutional Dark Pool Crossing Network, MAQ Anti-Pinging & VPIN Shield (`src/engine/darkPoolEngine.js`)
 *   4. Suite 4 — Wave 4 REST API Endpoints & `/macro.html` Workstation (`port: 3494, dbMemory: true`)
 */

'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');

const { initDatabase } = require('../src/db/database');
const { MatchingEngine } = require('../src/engine/orderbook');
const { MarketSimulator } = require('../src/engine/marketSim');
const { createArgusServer } = require('../src/server/index');

const yieldCurveFixedIncome = require('../src/engine/yieldCurveFixedIncome');
const { LobTimeMachine, computeBookStateHash } = require('../src/engine/lobTimeMachine');
const { DarkPoolEngine } = require('../src/engine/darkPoolEngine');

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
    console.error(`       ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n       ') : err}`);
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
        timeout: 8000
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
  console.log(' ARGUS TERMINAL — WAVE 4 MACRO NSS, BOND DESK, LOB REPLAY & DARK POOL QA');
  console.log('========================================================================');

  const db = initDatabase({ memory: true });
  const matchingEngine = new MatchingEngine(db);
  const marketSim = new MarketSimulator(matchingEngine, db);

  // ===========================================================================
  // SUITE 1 — Nelson-Siegel-Svensson Yield Curve & Fixed Income Bond Desk
  // ===========================================================================
  await runTest('1.1 NSS Yield Curve satisfies asymptotic limits (tau->0 => beta0+beta1, D(0)=1) and regime slopes (NORMAL_STEEP vs INVERTED_HAWKISH)', async () => {
    const params = {
      beta0: 0.0485,
      beta1: -0.0115,
      beta2: -0.0060,
      beta3: 0.0045,
      lambda1: 1.65,
      lambda2: 6.50
    };

    const atZero = yieldCurveFixedIncome.evaluateNelsonSiegelSvensson(0, params);
    const expectedShortRate = params.beta0 + params.beta1;
    assert.ok(
      Math.abs(atZero.spotYield - expectedShortRate) < 1e-7,
      `Expected y(0) = beta0 + beta1 (${expectedShortRate}), got ${atZero.spotYield}`
    );
    assert.ok(
      Math.abs(atZero.forwardRate - expectedShortRate) < 1e-7,
      `Expected f(0) = beta0 + beta1 (${expectedShortRate}), got ${atZero.forwardRate}`
    );
    assert.equal(atZero.discountFactor, 1, 'Expected discountFactor D(0) === 1');

    const normalCurve = yieldCurveFixedIncome.buildYieldCurve({ regime: 'NORMAL_STEEP' });
    assert.ok(normalCurve.spreads.spread2s10sBps > 0, `Expected positive 2s10s spread in NORMAL_STEEP, got ${normalCurve.spreads.spread2s10sBps}`);
    assert.equal(normalCurve.spreads.isInverted2s10s, false);

    const invertedCurve = yieldCurveFixedIncome.buildYieldCurve({ regime: 'INVERTED_HAWKISH' });
    assert.ok(invertedCurve.spreads.spread2s10sBps < 0, `Expected negative 2s10s spread in INVERTED_HAWKISH, got ${invertedCurve.spreads.spread2s10sBps}`);
    assert.equal(invertedCurve.spreads.isInverted2s10s, true);
  });

  await runTest('1.2 calibrateNelsonSiegelSvensson recovers NSS factor loadings from synthetic yield curve observations with RMSE < 0.5 bps', async () => {
    const trueParams = {
      beta0: 0.0475,
      beta1: -0.0120,
      beta2: -0.0050,
      beta3: 0.0040,
      lambda1: 1.65,
      lambda2: 6.50
    };

    const tenors = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30];
    const observations = tenors.map((tau) => ({
      tau,
      yield: yieldCurveFixedIncome.evaluateNelsonSiegelSvensson(tau, trueParams).spotYield
    }));

    const fit = yieldCurveFixedIncome.calibrateNelsonSiegelSvensson(observations, {
      lambda1: 1.65,
      lambda2: 6.50
    });

    assert.ok(fit.rmseBps < 0.5, `Expected calibration RMSE < 0.5 bps, got ${fit.rmseBps} bps`);
    assert.ok(Math.abs(fit.beta0 - trueParams.beta0) < 1e-4, `Expected beta0 ~= ${trueParams.beta0}, got ${fit.beta0}`);
    assert.ok(Math.abs(fit.beta1 - trueParams.beta1) < 1e-4, `Expected beta1 ~= ${trueParams.beta1}, got ${fit.beta1}`);
  });

  await runTest('1.3 Fixed Income priceBond & Newton-Raphson solveBondYtm verify par identity, Duration/DV01/Convexity bounds, and YTM inversion < 1e-7', async () => {
    // Par bond test: when couponRate === ytm and accruedFraction === 0, cleanPrice === 100
    const parBond = yieldCurveFixedIncome.priceBond({
      faceValue: 100,
      notionalUsd: 10000000,
      couponRate: 0.045,
      frequency: 2,
      maturityYears: 10,
      accruedFraction: 0,
      ytm: 0.045
    });

    assert.ok(Math.abs(parBond.cleanPrice - 100) < 1e-5, `Expected par bond cleanPrice === 100, got ${parBond.cleanPrice}`);
    assert.ok(parBond.macaulayDuration > parBond.modifiedDuration, 'Expected Macaulay Duration > Modified Duration');
    assert.ok(parBond.modifiedDuration > 6 && parBond.modifiedDuration < 10, `Expected 10Y Modified Duration in (6, 10), got ${parBond.modifiedDuration}`);
    assert.ok(parBond.convexity > 50, `Expected positive 10Y bond convexity > 50, got ${parBond.convexity}`);
    assert.ok(parBond.dv01Usd > 6000, `Expected 10Y $10M par DV01 > $6,000/bp, got ${parBond.dv01Usd}`);

    // Price at discount (ytm = 5.25%) and recover YTM via Newton-Raphson
    const trueYtm = 0.0525;
    const discountBond = yieldCurveFixedIncome.priceBond({
      faceValue: 100,
      couponRate: 0.0425,
      frequency: 2,
      maturityYears: 10,
      accruedFraction: 0.25,
      ytm: trueYtm
    });

    const solved = yieldCurveFixedIncome.solveBondYtm({
      faceValue: 100,
      couponRate: 0.0425,
      frequency: 2,
      maturityYears: 10,
      accruedFraction: 0.25,
      cleanPrice: discountBond.cleanPrice
    });

    assert.equal(solved.converged, true, 'Expected Newton-Raphson YTM solver to converge');
    assert.ok(Math.abs(solved.ytm - trueYtm) < 1e-7, `Expected recovered YTM ${solved.ytm} ~= ${trueYtm}`);
    assert.ok(solved.iterations <= 10, `Expected convergence in <= 10 iterations, took ${solved.iterations}`);
  });

  await runTest('1.4 solveBondZSpread and shockBondPrice verify 2nd-order Duration+Convexity Taylor expansion vs exact repricing', async () => {
    const zRes = yieldCurveFixedIncome.solveBondZSpread({
      faceValue: 100,
      couponRate: 0.0510,
      frequency: 2,
      maturityYears: 10,
      creditSpreadBps: 68.0,
      regime: 'NORMAL_STEEP'
    });
    assert.equal(zRes.converged, true, 'Expected Z-Spread Newton-Raphson solver to converge');
    assert.ok(Math.abs(zRes.zSpreadBps) < 500, `Expected realistic Z-Spread in bps, got ${zRes.zSpreadBps}`);

    const shock = yieldCurveFixedIncome.shockBondPrice(
      { faceValue: 100, notionalUsd: 1000000, couponRate: 0.0435, frequency: 2, maturityYears: 10, ytm: 0.0435 },
      [-100, -50, 0, 50, 100]
    );
    const up100 = shock.scenarios.find((s) => s.shiftBps === 100);
    assert.ok(up100, 'Expected +100 bps shock scenario');
    assert.ok(up100.exactPriceChange < 0, 'Bond price must fall when yield rises +100 bps');
    assert.ok(up100.convexityAdjustment > 0, 'Positive convexity adjustment must be > 0 for non-zero yield shift');
    assert.ok(up100.approxErrorBps < 2.0, `Expected 2nd-order Taylor approximation error < 2.0 bps at +100bps shock, got ${up100.approxErrorBps} bps`);
  });

  // ===========================================================================
  // SUITE 2 — Limit Order Book (LOB) Replay Time-Machine
  // ===========================================================================
  await runTest('2.1 LobTimeMachine reconstructs historical L2 states across keyframes & deltas with 100% SHA-256 hash verification', async () => {
    const tm = new LobTimeMachine(matchingEngine);
    const timeline = tm.getTimeline('BTC-USD', 60);

    assert.equal(timeline.symbol, 'BTC-USD');
    assert.ok(timeline.totalEvents >= 60, `Expected >= 60 seeded events, got ${timeline.totalEvents}`);
    assert.ok(timeline.keyframes.length >= 6, `Expected >= 6 keyframe checkpoints, got ${timeline.keyframes.length}`);

    for (const targetSeq of [1, 10, 17, 33, 48, 60]) {
      const stateA = tm.seekToSequence('BTC-USD', targetSeq);
      const stateB = tm.seekToSequence('BTC-USD', targetSeq);
      assert.equal(stateA.seq, targetSeq);
      assert.equal(stateA.deterministicVerified, true, `Expected deterministic SHA-256 verification at seq=${targetSeq}`);
      assert.equal(stateA.stateHash, stateB.stateHash, 'Repeated seekToSequence must produce identical SHA-256 stateHash');
      assert.equal(stateA.stateHash, computeBookStateHash(stateA.orderbook));
      assert.ok(stateA.orderbook.bids.length >= 10 && stateA.orderbook.asks.length >= 10);
      assert.ok(stateA.orderbook.bestAsk > stateA.orderbook.bestBid, 'Best Ask must strictly exceed Best Bid in reconstructed frame');
    }
  });

  await runTest('2.2 LobTimeMachine.recordEvent appends live delta events while preserving past historical sequence hashes', async () => {
    const tm = new LobTimeMachine(matchingEngine);
    const beforeSeq25 = tm.seekToSequence('BTC-USD', 25);

    const rec = tm.recordEvent({
      symbol: 'BTC-USD',
      eventType: 'MARKET_SWEEP',
      side: 'BUY',
      price: 94505.0,
      size: 2.5,
      actor: 'QA-TIME-TRAVELER'
    });

    assert.equal(rec.event.seq, 61);
    assert.equal(rec.state.deterministicVerified, true);

    const afterSeq25 = tm.seekToSequence('BTC-USD', 25);
    assert.equal(afterSeq25.stateHash, beforeSeq25.stateHash, 'Appending future events must never mutate historical sequence state');
  });

  // ===========================================================================
  // SUITE 3 — Institutional Dark Pool Crossing Network (ARGUS-DARK-ATS)
  // ===========================================================================
  await runTest('3.1 DarkPoolEngine crosses MIDPOINT_PEG orders at exact Lit NBBO Midpoint with positive price improvement vs Lit touch & sweep', async () => {
    const dp = new DarkPoolEngine(matchingEngine, db, marketSim);

    // Submit a SELL block of 3.0 BTC-USD with minQty 0.5 against seeded BUY block (8.5 BTC @ MIDPOINT_PEG)
    const crossRes = dp.submitDarkOrder({
      accountId: 'ACC-INST-01',
      symbol: 'BTC-USD',
      side: 'SELL',
      pegType: 'MIDPOINT_PEG',
      size: 3.0,
      minQty: 0.5,
      litBestBid: 94498.0,
      litBestAsk: 94502.0,
      vpin: 0.24
    });

    assert.equal(crossRes.shieldTriggered, false);
    assert.equal(crossRes.order.status, 'FILLED_DARK');
    assert.ok(Math.abs(crossRes.crossedVolume - 3.0) < 1e-6, `Expected 3.0 BTC crossed, got ${crossRes.crossedVolume}`);
    assert.equal(crossRes.executionPrice, 94500.0, 'Expected execution at exact NBBO Midpoint (94498 + 94502)/2 = 94500.0');
    assert.ok(crossRes.totalPriceImprovementUsd > 0, `Expected positive price improvement USD, got ${crossRes.totalPriceImprovementUsd}`);
    assert.ok(crossRes.fills[0].priceImprovementBps > 0, 'Expected positive priceImprovementBps');
  });

  await runTest('3.2 DarkPoolEngine Anti-Gaming Minimum Execution Quantity (minQty / MAQ) blocks small predatory ping orders', async () => {
    const dp = new DarkPoolEngine(matchingEngine, db, marketSim);

    // Seeded BTC-USD dark book has resting asks with minQty >= 0.5 and 3.0.
    // A tiny 0.05 BTC ping order must be blocked from matching against those resting blocks!
    const pingRes = dp.submitDarkOrder({
      accountId: 'ACC-INST-01',
      symbol: 'BTC-USD',
      side: 'BUY',
      pegType: 'MIDPOINT_PEG',
      size: 0.05,
      minQty: 0.01,
      vpin: 0.22
    });

    assert.equal(pingRes.crossedVolume, 0, 'Expected 0 crossed volume for predatory small ping order below resting MAQ');
    assert.ok(pingRes.blockedByMinQtyCount > 0, 'Expected blockedByMinQtyCount > 0 when ping size < resting minQty');
    assert.equal(pingRes.order.status, 'RESTING_DARK');
  });

  await runTest('3.3 DarkPoolEngine VPIN Flow Toxicity Shield pauses dark execution when VPIN exceeds maxToxicityVpin threshold', async () => {
    const dp = new DarkPoolEngine(matchingEngine, db, marketSim);

    const toxicRes = dp.submitDarkOrder({
      accountId: 'ACC-INST-01',
      symbol: 'BTC-USD',
      side: 'BUY',
      pegType: 'MIDPOINT_PEG',
      size: 2.0,
      minQty: 0.5,
      maxToxicityVpin: 0.55,
      vpin: 0.82 // Toxic order flow spike!
    });

    assert.equal(toxicRes.shieldTriggered, true, 'Expected VPIN Toxicity Shield to trigger when vpin (0.82) > maxToxicityVpin (0.55)');
    assert.equal(toxicRes.order.status, 'SHIELD_PAUSED');
    assert.equal(toxicRes.fills.length, 0, 'No fills should occur while VPIN shield is active');
  });

  // ===========================================================================
  // SUITE 4 — Wave 4 REST API Endpoints & `/macro.html` Workstation
  // ===========================================================================
  let appServer = null;
  try {
    appServer = await createArgusServer({ port: 3494, dbMemory: true, simIntervalMs: 1000 });
    const baseUrl = appServer.url;

    await runTest('4.1 GET /api/macro/yield-curve, POST /api/macro/bond-price & POST /api/macro/calibrate-nss return 200 OK', async () => {
      const ycRes = await httpRequest(baseUrl, 'GET', '/api/macro/yield-curve?regime=NORMAL_STEEP&shiftBps=25');
      assert.equal(ycRes.status, 200);
      assert.ok(Array.isArray(ycRes.json.points) && ycRes.json.points.length >= 10, 'Expected >= 10 yield curve tenor points');
      assert.ok(Array.isArray(ycRes.json.bonds) && ycRes.json.bonds.length >= 6, 'Expected >= 6 benchmark fixed income bonds');

      const bondRes = await httpRequest(baseUrl, 'POST', '/api/macro/bond-price', {
        couponRate: 0.0435,
        maturityYears: 10,
        cleanPrice: 98.75,
        notionalUsd: 5000000
      });
      assert.equal(bondRes.status, 200);
      assert.ok(bondRes.json.ytm > 0.04 && bondRes.json.ytm < 0.06);
      assert.ok(bondRes.json.modifiedDuration > 6);
      assert.ok(Array.isArray(bondRes.json.scenarios) && bondRes.json.scenarios.length >= 5);

      const calRes = await httpRequest(baseUrl, 'POST', '/api/macro/calibrate-nss', {
        observations: [
          { tau: 0.25, yield: 0.038 },
          { tau: 2.0, yield: 0.041 },
          { tau: 5.0, yield: 0.043 },
          { tau: 10.0, yield: 0.045 },
          { tau: 30.0, yield: 0.047 }
        ]
      });
      assert.equal(calRes.status, 200);
      assert.equal(typeof calRes.json.beta0, 'number');
      assert.ok(calRes.json.rmseBps < 5.0);
    });

    await runTest('4.2 GET /api/replay/timeline, GET /api/replay/state & POST /api/replay/seek return deterministic L2 states', async () => {
      const tlRes = await httpRequest(baseUrl, 'GET', '/api/replay/timeline?symbol=BTC-USD&limit=30');
      assert.equal(tlRes.status, 200);
      assert.ok(tlRes.json.totalEvents >= 60);

      const stRes = await httpRequest(baseUrl, 'GET', '/api/replay/state?symbol=BTC-USD&seq=30');
      assert.equal(stRes.status, 200);
      assert.equal(stRes.json.seq, 30);
      assert.equal(stRes.json.deterministicVerified, true);

      const seekRes = await httpRequest(baseUrl, 'POST', '/api/replay/seek', { symbol: 'ETH-USD', seq: 42 });
      assert.equal(seekRes.status, 200);
      assert.equal(seekRes.json.symbol, 'ETH-USD');
      assert.equal(seekRes.json.seq, 42);
      assert.equal(seekRes.json.deterministicVerified, true);
    });

    await runTest('4.3 GET /api/darkpool/status & POST /api/darkpool/orders execute midpoint blocks and enforce RBAC', async () => {
      const stRes = await httpRequest(baseUrl, 'GET', '/api/darkpool/status?symbol=BTC-USD');
      assert.equal(stRes.status, 200);
      assert.equal(stRes.json.venue, 'ARGUS-DARK-ATS');
      assert.ok(stRes.json.darkBookSummary.totalHiddenLiquidity > 0);

      const crossRes = await httpRequest(baseUrl, 'POST', '/api/darkpool/orders', {
        accountId: 'ACC-INST-01',
        symbol: 'BTC-USD',
        side: 'BUY',
        pegType: 'MIDPOINT_PEG',
        size: 2.5,
        minQty: 0.5
      });
      assert.equal(crossRes.status, 201);
      assert.ok(crossRes.json.crossedVolume >= 2.5);
      assert.ok(crossRes.json.totalPriceImprovementUsd > 0);

      // Verify RBAC on RESTRICTED sovereign account without X-API-Key
      const unauthRes = await httpRequest(baseUrl, 'POST', '/api/darkpool/orders', {
        accountId: 'ACC-VAULT-99',
        symbol: 'BTC-USD',
        side: 'BUY',
        size: 1.0
      });
      assert.equal(unauthRes.status, 403, 'Expected 403 Forbidden for unauthenticated RESTRICTED account on /api/darkpool/orders');
    });

    await runTest('4.4 GET /macro.html returns 200 OK with NSS Yield Curve, Fixed Income Bond Desk, LOB Replay Time-Machine & Dark Pool panes', async () => {
      const res = await httpRequest(baseUrl, 'GET', '/macro.html');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));
      const html = res.text;
      assert.ok(/NELSON-SIEGEL-SVENSSON/i.test(html), 'Expected Nelson-Siegel-Svensson Yield Curve pane in /macro.html');
      assert.ok(/FIXED INCOME BOND DESK/i.test(html), 'Expected Fixed Income Bond Desk pane in /macro.html');
      assert.ok(/REPLAY TIME-MACHINE/i.test(html), 'Expected LOB Replay Time-Machine pane in /macro.html');
      assert.ok(/DARK POOL CROSSING NETWORK/i.test(html), 'Expected Dark Pool Crossing Network pane in /macro.html');
      assert.ok(/tabindex="0"\s+role="region"/i.test(html), 'Expected modern-web-guidance accessible scrollable table regions');
    });
  } finally {
    if (appServer) {
      await appServer.stop();
    }
  }

  console.log('========================================================================');
  console.log(` WAVE 4 QA SUMMARY: ${passCount} PASSED | ${failCount} FAILED`);
  console.log('========================================================================');

  process.exit(failCount === 0 ? 0 : 1);
})();
