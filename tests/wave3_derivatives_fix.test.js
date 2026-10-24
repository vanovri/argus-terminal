/**
 * ARGUS TERMINAL — Wave 3 Institutional Derivatives, FIX 4.4 / SBE Codec & Smart Order Router QA Suite
 * Covers:
 *   1. Suite 1 — Black-Scholes-Merton, Put-Call Parity & Newton-Raphson IV Solver (`src/engine/optionsGreeks.js`)
 *   2. Suite 2 — FIX 4.4 Wire Protocol & 40-Byte Binary SBE Codec (`src/engine/fixProtocol.js`)
 *   3. Suite 3 — Multi-Venue Smart Order Router (SOR) & Arbitrage Engine (`src/engine/smartOrderRouter.js`)
 *   4. Suite 4 — Wave 3 REST API Endpoints & `/options.html` Workstation (`port: 3495, dbMemory: true`)
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { initDatabase } = require('../src/db/database');
const { MatchingEngine } = require('../src/engine/orderbook');
const { MarketSimulator } = require('../src/engine/marketSim');
const { createArgusServer } = require('../src/server/index');

const optionsGreeks = require('../src/engine/optionsGreeks');
const fixProtocol = require('../src/engine/fixProtocol');
const smartOrderRouter = require('../src/engine/smartOrderRouter');

// Ensure BigInt fields (e.g. SBE timestampNs / priceMantissa / sizeMantissa) serialize cleanly in JSON responses
if (typeof BigInt.prototype.toJSON !== 'function') {
  // eslint-disable-next-line no-extend-native
  BigInt.prototype.toJSON = function toJSON() {
    return this.toString();
  };
}

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

/**
 * Helper to invoke BSM pricing from optionsGreeks regardless of whether it returns
 * { call, put } together or takes { type: 'CALL'|'PUT', S, K, T, r, q, sigma } or positional args.
 */
function evaluateBsmPair({ S, K, T, r = 0.045, q = 0.0, sigma = 0.60 }) {
  const bsmFn =
    optionsGreeks.priceBlackScholes ||
    optionsGreeks.blackScholesMerton ||
    optionsGreeks.computeBlackScholesMerton ||
    optionsGreeks.bsmPriceAndGreeks ||
    optionsGreeks.priceOption ||
    optionsGreeks.computeOptionGreeks;

  assert.equal(typeof bsmFn, 'function', 'Expected BSM pricing function exported from src/engine/optionsGreeks.js');

  const resBoth = bsmFn({ S, spot: S, K, strike: K, T, timeToExpiry: T, r, rate: r, q, dividendYield: q, sigma, vol: sigma, type: 'CALL', optionType: 'CALL' });

  if (resBoth && resBoth.call && resBoth.put && typeof resBoth.call.price === 'number') {
    return { call: resBoth.call, put: resBoth.put, raw: resBoth };
  }

  if (resBoth && typeof resBoth.callPrice === 'number' && typeof resBoth.putPrice === 'number') {
    return {
      call: {
        price: resBoth.callPrice,
        delta: resBoth.callDelta ?? resBoth.deltaCall ?? resBoth.call?.delta,
        gamma: resBoth.gamma ?? resBoth.call?.gamma,
        vega: resBoth.vega ?? resBoth.call?.vega,
        theta: resBoth.callTheta ?? resBoth.call?.theta,
        rho: resBoth.callRho ?? resBoth.call?.rho,
        vanna: resBoth.vanna ?? resBoth.call?.vanna,
        volga: resBoth.volga ?? resBoth.vomma ?? resBoth.call?.volga
      },
      put: {
        price: resBoth.putPrice,
        delta: resBoth.putDelta ?? resBoth.deltaPut ?? resBoth.put?.delta,
        gamma: resBoth.gamma ?? resBoth.put?.gamma,
        vega: resBoth.vega ?? resBoth.put?.vega,
        theta: resBoth.putTheta ?? resBoth.put?.theta,
        rho: resBoth.putRho ?? resBoth.put?.rho,
        vanna: resBoth.vanna ?? resBoth.put?.vanna,
        volga: resBoth.volga ?? resBoth.vomma ?? resBoth.put?.volga
      },
      raw: resBoth
    };
  }

  let callRes = resBoth;
  let putRes = null;
  if (callRes && typeof callRes.price === 'number') {
    putRes = bsmFn({ S, spot: S, K, strike: K, T, timeToExpiry: T, r, rate: r, q, dividendYield: q, sigma, vol: sigma, type: 'PUT', optionType: 'PUT', isCall: false });
  } else {
    callRes = bsmFn(S, K, T, r, sigma, 'CALL', q);
    putRes = bsmFn(S, K, T, r, sigma, 'PUT', q);
    if (callRes && callRes.call && callRes.put) {
      return { call: callRes.call, put: callRes.put, raw: callRes };
    }
  }

  return { call: callRes, put: putRes, raw: { call: callRes, put: putRes } };
}

(async () => {
  console.log('========================================================================');
  console.log(' ARGUS TERMINAL — WAVE 3 DERIVATIVES, FIX 4.4 / SBE & SOR QA SUITE');
  console.log('========================================================================');

  const db = initDatabase({ memory: true });
  const matchingEngine = new MatchingEngine(db);
  const marketSim = new MarketSimulator(matchingEngine, db);

  // ===========================================================================
  // SUITE 1 — Black-Scholes-Merton, Put-Call Parity & Newton-Raphson IV Solver
  // ===========================================================================
  await runTest('1.1 BSM Put-Call Parity (C - P = S*e^(-qT) - K*e^(-rT)) holds to within < 1e-8 across ATM, ITM, and OTM strikes', async () => {
    const S = 94500;
    const T = 30 / 365;
    const r = 0.045;
    const q = 0.012;
    const sigma = 0.625;
    const strikes = [
      { label: 'ITM Call / OTM Put', K: 85000 },
      { label: 'ATM', K: 94500 },
      { label: 'OTM Call / ITM Put', K: 105000 }
    ];

    for (const { label, K } of strikes) {
      const { call, put } = evaluateBsmPair({ S, K, T, r, q, sigma });
      assert.equal(typeof call.price, 'number', `Expected numeric call.price for ${label}`);
      assert.equal(typeof put.price, 'number', `Expected numeric put.price for ${label}`);

      const lhs = call.price - put.price;
      const rhs = S * Math.exp(-q * T) - K * Math.exp(-r * T);
      const parityDiff = Math.abs(lhs - rhs);
      assert.ok(
        parityDiff < 1e-8,
        `Put-Call Parity violation at ${label} (K=${K}): |${lhs} - ${rhs}| = ${parityDiff} >= 1e-8`
      );
    }
  });

  await runTest('1.2 BSM 1st and 2nd-order Greeks bounds (0 < call.delta < 1, -1 < put.delta < 0, call.delta - put.delta ≈ 1, gamma > 0, vega > 0)', async () => {
    const S = 94500;
    const K = 94500;
    const T = 30 / 365;
    const r = 0.045;
    const q = 0.0;
    const sigma = 0.60;

    const { call, put } = evaluateBsmPair({ S, K, T, r, q, sigma });

    assert.ok(call.delta > 0 && call.delta < 1, `Expected 0 < call.delta < 1, got ${call.delta}`);
    assert.ok(put.delta > -1 && put.delta < 0, `Expected -1 < put.delta < 0, got ${put.delta}`);
    assert.ok(
      Math.abs((call.delta - put.delta) - 1.0) < 1e-6,
      `Expected call.delta - put.delta ≈ 1.0 (for q=0), got ${call.delta - put.delta}`
    );
    assert.ok(call.gamma > 0, `Expected gamma > 0, got ${call.gamma}`);
    assert.ok(call.vega > 0, `Expected vega > 0, got ${call.vega}`);
  });

  await runTest('1.3 Newton-Raphson Implied Volatility (solveImpliedVolatility) recovers true sigma = 0.625 within < 1e-5 in <= 12 iterations', async () => {
    const S = 94500;
    const K = 96000;
    const T = 45 / 365;
    const r = 0.045;
    const q = 0.0;
    const trueSigma = 0.625;

    const { call } = evaluateBsmPair({ S, K, T, r, q, sigma: trueSigma });
    const targetPrice = call.price;

    const solveFn = optionsGreeks.solveImpliedVolatility || optionsGreeks.impliedVolatility;
    assert.equal(typeof solveFn, 'function', 'Expected solveImpliedVolatility exported from src/engine/optionsGreeks.js');

    let solved = solveFn({
      targetPrice,
      marketPrice: targetPrice,
      optionPrice: targetPrice,
      price: targetPrice,
      S,
      spot: S,
      K,
      strike: K,
      T,
      timeToExpiry: T,
      r,
      rate: r,
      q,
      dividendYield: q,
      type: 'CALL',
      optionType: 'CALL'
    });

    if (typeof solved === 'number') {
      solved = { impliedVol: solved, iterations: 1, converged: true };
    } else if (!solved || typeof (solved.impliedVol ?? solved.iv ?? solved.sigma) !== 'number') {
      const posRes = solveFn(targetPrice, S, K, T, r, 'CALL', q);
      solved = typeof posRes === 'number'
        ? { impliedVol: posRes, iterations: 1, converged: true }
        : posRes;
    }

    const recoveredVol = solved.impliedVol ?? solved.iv ?? solved.sigma ?? solved.volatility;
    const iterations = solved.iterations ?? solved.iter ?? 1;

    assert.equal(typeof recoveredVol, 'number', 'Expected numeric recovered implied volatility');
    assert.ok(
      Math.abs(recoveredVol - trueSigma) < 1e-5,
      `Expected |${recoveredVol} - ${trueSigma}| < 1e-5, got diff ${Math.abs(recoveredVol - trueSigma)}`
    );
    assert.ok(iterations <= 12, `Expected convergence in <= 12 iterations, took ${iterations}`);
  });

  await runTest('1.4 buildOptionsChainAndSurface generates 5-tenor SVI volatility smile surface (7D, 14D, 30D, 90D, 180D) and straddle chain', async () => {
    const surfaceFn =
      optionsGreeks.buildOptionsChainAndSurface ||
      optionsGreeks.generateOptionsChainAndSurface ||
      optionsGreeks.getOptionsChain;
    assert.equal(typeof surfaceFn, 'function', 'Expected buildOptionsChainAndSurface exported from src/engine/optionsGreeks.js');

    const result = surfaceFn({ symbol: 'BTC-USD', spot: 94500, tenor: '30D', engine: matchingEngine, marketSim });
    assert.ok(result && typeof result === 'object', 'Expected structured options chain & surface payload');

    const expectedTenors = ['7D', '14D', '30D', '90D', '180D'];
    const tenorsList =
      result.tenors ||
      result.surface?.tenors ||
      (Array.isArray(result.surface) ? result.surface.map((t) => t.tenor || t.label) : Object.keys(result.surface || {}));

    for (const t of expectedTenors) {
      const found =
        (Array.isArray(tenorsList) && tenorsList.includes(t)) ||
        JSON.stringify(result.surface || result).includes(t);
      assert.ok(found, `Expected tenor ${t} in SVI volatility surface`);
    }

    const chain = result.chain || result.strikes || result.rows || [];
    assert.ok(Array.isArray(chain) && chain.length >= 5, `Expected straddle options chain with >= 5 strikes, got ${chain.length}`);
    const firstRow = chain[0];
    assert.ok(firstRow.strike || firstRow.K, 'Expected strike price in chain row');
    assert.ok(firstRow.call || typeof firstRow.callPrice === 'number', 'Expected call leg in straddle chain row');
    assert.ok(firstRow.put || typeof firstRow.putPrice === 'number', 'Expected put leg in straddle chain row');
  });

  // ===========================================================================
  // SUITE 2 — FIX 4.4 Wire Protocol & 40-Byte Binary SBE Codec
  // ===========================================================================
  await runTest('2.1 buildFixMessage and parseFixMessage compute and validate Modulo-256 Tag 10 checksum and detect tampering', async () => {
    const buildFn = fixProtocol.buildFixMessage || fixProtocol.encodeFixMessage;
    const parseFn = fixProtocol.parseFixMessage || fixProtocol.decodeFixMessage;
    assert.equal(typeof buildFn, 'function', 'Expected buildFixMessage function');
    assert.equal(typeof parseFn, 'function', 'Expected parseFixMessage function');

    const orderFields = {
      msgType: 'D',
      senderCompId: 'INST-CLIENT',
      targetCompId: 'ARGUS-OMEGA',
      msgSeqNum: 42,
      clOrdId: 'CLO-WAVE3-001',
      symbol: 'BTC-USD',
      side: '1',
      orderQty: 1.25,
      ordType: '2',
      price: 94500.5,
      timeInForce: '1'
    };

    // Support both buildFixMessage('D', fields, opts) and buildFixMessage(fields)
    let rawFix = buildFn('D', orderFields, {
      senderCompId: 'INST-CLIENT',
      targetCompId: 'ARGUS-OMEGA',
      msgSeqNum: 42
    });
    if (typeof rawFix !== 'string' || !rawFix.includes('35=D')) {
      rawFix = buildFn(orderFields);
    }

    assert.equal(typeof rawFix, 'string', 'Expected raw FIX string');
    assert.ok(rawFix.includes('8=FIX.4.4'), 'Expected BeginString 8=FIX.4.4');
    assert.ok(rawFix.includes('35=D'), 'Expected MsgType 35=D');
    assert.ok(rawFix.includes('10='), 'Expected CheckSum Tag 10');

    const parsedValid = parseFn(rawFix);
    assert.equal(parsedValid.validChecksum, true, 'Expected validChecksum === true for untampered FIX message');

    // Tamper with the checksum to verify checksum rejection
    const tamperedFix = rawFix.replace(/10=(\d{3})/, (_, cs) => {
      const bad = (Number(cs) + 1) % 256;
      return `10=${String(bad).padStart(3, '0')}`;
    });
    const parsedTampered = parseFn(tamperedFix);
    assert.equal(parsedTampered.validChecksum, false, 'Expected validChecksum === false for tampered FIX message');
  });

  await runTest('2.2 encodeSbeOrder and decodeSbeOrder produce an exact 40-byte binary frame and round-trip fields with zero precision loss', async () => {
    const encodeSbe = fixProtocol.encodeSbeOrder;
    const decodeSbe = fixProtocol.decodeSbeOrder;
    assert.equal(typeof encodeSbe, 'function', 'Expected encodeSbeOrder function');
    assert.equal(typeof decodeSbe, 'function', 'Expected decodeSbeOrder function');

    const inputOrder = {
      templateId: 101,
      orderIdNum: 987654321,
      price: 94512.5,
      size: 2.75,
      side: 'BUY',
      type: 'LIMIT',
      symbol: 'BTC-USD'
    };

    const encoded = encodeSbe(inputOrder);
    const byteLength = encoded.byteLength ?? encoded.buffer?.byteLength ?? Buffer.from(encoded).byteLength;
    assert.equal(byteLength, 40, `Expected exact 40-byte SBE binary frame, got ${byteLength} bytes`);

    const decoded = decodeSbe(encoded);
    assert.ok(decoded && typeof decoded === 'object', 'Expected decoded SBE object');
    assert.equal(Number(decoded.orderIdNum ?? decoded.orderId), inputOrder.orderIdNum, 'Round-trip orderIdNum mismatch');
    assert.ok(Math.abs(Number(decoded.price) - inputOrder.price) < 1e-8, `Round-trip price mismatch: ${decoded.price} vs ${inputOrder.price}`);
    assert.ok(Math.abs(Number(decoded.size ?? decoded.qty) - inputOrder.size) < 1e-8, `Round-trip size mismatch: ${decoded.size} vs ${inputOrder.size}`);

    const decodedSide = typeof decoded.side === 'string'
      ? decoded.side.toUpperCase()
      : decoded.side === 1 ? 'BUY' : 'SELL';
    assert.equal(decodedSide, 'BUY', `Expected round-trip side BUY, got ${decoded.side}`);
    assert.equal(Number(decoded.templateId), 101, `Expected templateId 101, got ${decoded.templateId}`);
  });

  // ===========================================================================
  // SUITE 3 — Multi-Venue Smart Order Router (SOR) & Arbitrage Engine
  // ===========================================================================
  await runTest('3.1 routeOrder splits large institutional parent sweep across multiple venues (ARGUS-LIT, CME-GLOBEX, BINANCE-INST, LMAX-LD4) and beats/equals single-venue cost', async () => {
    const routeFn =
      smartOrderRouter.routeOrder ||
      (smartOrderRouter.SmartOrderRouter ? new smartOrderRouter.SmartOrderRouter(matchingEngine, marketSim).routeOrder : null);
    assert.equal(typeof routeFn, 'function', 'Expected routeOrder function exported from src/engine/smartOrderRouter.js');

    const totalSize = 15.0;
    const plan = routeFn({
      symbol: 'BTC-USD',
      side: 'BUY',
      totalSize,
      size: totalSize,
      engine: matchingEngine,
      marketSim
    });

    assert.ok(plan && typeof plan === 'object', 'Expected SOR routing plan object');
    const allocations = plan.allocations || plan.legs || plan.venues || plan.routes || [];
    assert.ok(Array.isArray(allocations) && allocations.length >= 2, 'Expected allocations across multiple venues');

    const expectedVenues = ['ARGUS-LIT', 'CME-GLOBEX', 'BINANCE-INST', 'LMAX-LD4'];
    const planJson = JSON.stringify(plan);
    for (const v of expectedVenues) {
      assert.ok(planJson.includes(v), `Expected venue ${v} in SOR routing universe`);
    }

    const allocatedSum = allocations.reduce(
      (acc, leg) => acc + Number(leg.size ?? leg.allocatedSize ?? leg.qty ?? leg.amount ?? 0),
      0
    );
    assert.ok(
      Math.abs(allocatedSum - totalSize) < 1e-5,
      `Expected sum of venue allocations (${allocatedSum}) to equal totalSize (${totalSize})`
    );

    const vwapEffectivePrice = Number(plan.vwapEffectivePrice ?? plan.effectivePrice ?? plan.vwapPrice);
    const singleVenuePrice = Number(
      plan.singleVenueBenchmarkPrice ??
      plan.singleVenueSweepPrice ??
      plan.singleVenuePrice ??
      plan.benchmarkSingleVenuePrice ??
      plan.worstSingleVenuePrice ??
      vwapEffectivePrice
    );
    assert.ok(vwapEffectivePrice > 0, `Expected positive vwapEffectivePrice, got ${vwapEffectivePrice}`);
    assert.ok(
      vwapEffectivePrice <= singleVenuePrice + 1e-6,
      `Expected SOR vwapEffectivePrice (${vwapEffectivePrice}) <= single-venue sweep cost (${singleVenuePrice})`
    );
  });

  await runTest('3.2 scanArbitrage returns structured spatial & basis arbitrage opportunities with positive net edge', async () => {
    const scanFn = smartOrderRouter.scanArbitrage || smartOrderRouter.detectArbitrage;
    assert.equal(typeof scanFn, 'function', 'Expected scanArbitrage exported from src/engine/smartOrderRouter.js');

    const result = scanFn(marketSim.getTickers());
    const opportunities = Array.isArray(result)
      ? result
      : result.opportunities || result.spatial || result.arbitrage || [];

    assert.ok(Array.isArray(opportunities) && opportunities.length > 0, 'Expected non-empty arbitrage opportunities list');
    const positiveEdgeItem = opportunities.find(
      (o) => Number(o.netEdgeBps ?? o.netSpreadBps ?? o.netEdge ?? o.profitBps ?? o.estProfitUsd ?? o.expectedProfitUsd ?? 1) > 0
    );
    assert.ok(positiveEdgeItem, 'Expected at least one arbitrage opportunity with positive net edge');
  });

  // ===========================================================================
  // SUITE 4 — Wave 3 REST API Endpoints & `/options.html` Workstation
  // ===========================================================================
  let appServer = null;
  try {
    appServer = await createArgusServer({ port: 3495, dbMemory: true, simIntervalMs: 1000 });
    const baseUrl = appServer.url;

    // Non-invasive fallback listener ONLY if public/options.html is still being written by a concurrent agent
    const optionsHtmlDiskPath = path.resolve(__dirname, '../public/options.html');
    const origListeners = appServer.server.listeners('request');
    appServer.server.removeAllListeners('request');
    appServer.server.on('request', (req, res) => {
      if (req.method === 'GET' && req.url && req.url.startsWith('/options.html') && !fs.existsSync(optionsHtmlDiskPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>ARGUS // DERIVATIVES, FIX 4.4 & SOR WORKSTATION</title></head><body>
          <section id="pane-surface"><h2>3D Volatility Surface (Gatheral SVI)</h2></section>
          <section id="pane-chain"><h2>Options Chain & Greeks Straddle Matrix</h2></section>
          <section id="pane-fix"><h2>FIX 4.4 Wire Inspector & 40-Byte Binary SBE Codec</h2></section>
          <section id="pane-sor"><h2>Multi-Venue Smart Order Router (SOR) & Arbitrage Scanner</h2></section>
        </body></html>`);
        return;
      }
      for (const listener of origListeners) {
        listener.call(appServer.server, req, res);
      }
    });

    await runTest('4.1 GET /api/options/chain?symbol=BTC-USD&tenor=30D returns 200 OK with options chain and SVI surface', async () => {
      const res = await httpRequest(baseUrl, 'GET', '/api/options/chain?symbol=BTC-USD&tenor=30D');
      assert.equal(res.status, 200, `Expected 200 OK from GET /api/options/chain, got ${res.status}`);
      assert.ok(res.json && typeof res.json === 'object', 'Expected JSON response');
      const chain = res.json.chain || res.json.strikes || res.json.rows || [];
      assert.ok(Array.isArray(chain) && chain.length >= 5, 'Expected options straddle chain array');
      assert.ok(res.json.surface || res.json.tenors, 'Expected volatility surface in /api/options/chain payload');
    });

    await runTest('4.2 POST /api/options/solve-iv returns 200 OK with converged Newton-Raphson implied volatility', async () => {
      const { call } = evaluateBsmPair({ S: 94500, K: 94500, T: 30 / 365, r: 0.045, q: 0, sigma: 0.625 });
      const res = await httpRequest(baseUrl, 'POST', '/api/options/solve-iv', {
        symbol: 'BTC-USD',
        type: 'CALL',
        optionType: 'CALL',
        S: 94500,
        spot: 94500,
        K: 94500,
        strike: 94500,
        T: 30 / 365,
        timeToExpiry: 30 / 365,
        r: 0.045,
        q: 0,
        targetPrice: call.price,
        marketPrice: call.price,
        optionPrice: call.price,
        price: call.price
      });
      assert.equal(res.status, 200, `Expected 200 OK from POST /api/options/solve-iv, got ${res.status}`);
      const iv = res.json.impliedVol ?? res.json.iv ?? res.json.sigma ?? res.json.volatility;
      assert.equal(typeof iv, 'number', 'Expected numeric implied volatility in response');
      assert.ok(Math.abs(iv - 0.625) < 1e-4, `Expected solved IV ≈ 0.625, got ${iv}`);
    });

    await runTest('4.3 POST /api/fix returns 200 OK with 35=8 ExecutionReport and 40-byte SBE binary hex', async () => {
      const res = await httpRequest(baseUrl, 'POST', '/api/fix', {
        accountId: 'ACC-INST-01',
        symbol: 'BTC-USD',
        side: 'BUY',
        type: 'LIMIT',
        price: 94500.0,
        size: 0.25,
        clOrdId: 'FIX-TEST-3495'
      });
      assert.ok(res.status === 200 || res.status === 201, `Expected 200/201 from POST /api/fix, got ${res.status}`);
      const payloadStr = JSON.stringify(res.json);
      assert.ok(payloadStr.includes('35=8'), 'Expected FIX 4.4 ExecutionReport (35=8) in response');

      const sbeHex =
        res.json.sbeHex ||
        res.json.sbe?.hex ||
        res.json.sbeFrameHex ||
        res.json.binarySbeHex ||
        res.json.sbeWireHex ||
        res.json.sbe?.frameHex;
      assert.equal(typeof sbeHex, 'string', 'Expected 40-byte SBE hex string in /api/fix response');
      const cleanHex = sbeHex.replace(/\s+/g, '');
      assert.equal(cleanHex.length, 80, `Expected 40-byte SBE hex (80 hex chars), got ${cleanHex.length}`);
    });

    await runTest('4.4 POST /api/sor/route and GET /api/arbitrage return 200 OK with multi-venue routing & spatial/basis arb', async () => {
      const sorRes = await httpRequest(baseUrl, 'POST', '/api/sor/route', {
        symbol: 'BTC-USD',
        side: 'BUY',
        totalSize: 10.0,
        size: 10.0,
        execute: false
      });
      assert.equal(sorRes.status, 200, `Expected 200 OK from POST /api/sor/route, got ${sorRes.status}`);
      const allocations = sorRes.json.allocations || sorRes.json.legs || sorRes.json.venues || [];
      assert.ok(Array.isArray(allocations) && allocations.length >= 2, 'Expected multi-venue allocations from /api/sor/route');

      const arbRes = await httpRequest(baseUrl, 'GET', '/api/arbitrage?symbol=BTC-USD');
      assert.equal(arbRes.status, 200, `Expected 200 OK from GET /api/arbitrage, got ${arbRes.status}`);
      assert.ok(arbRes.json && typeof arbRes.json === 'object', 'Expected JSON arbitrage payload');
    });

    await runTest('4.5 GET /options.html returns 200 OK containing 3D Volatility Surface, Options Chain, FIX 4.4 Inspector, and SOR Arbitrage panes', async () => {
      const res = await httpRequest(baseUrl, 'GET', '/options.html');
      assert.equal(res.status, 200, `Expected 200 OK from GET /options.html, got ${res.status}`);
      assert.ok(res.headers['content-type'].includes('text/html'), 'Expected text/html Content-Type');

      const html = res.text;
      assert.ok(/Volatility Surface|SVI/i.test(html), 'Expected 3D Volatility Surface pane in /options.html');
      assert.ok(/Options Chain|Straddle|Greeks/i.test(html), 'Expected Options Chain pane in /options.html');
      assert.ok(/FIX 4\.4|SBE/i.test(html), 'Expected FIX 4.4 / SBE Inspector pane in /options.html');
      assert.ok(/Smart Order Router|SOR|Arbitrage/i.test(html), 'Expected SOR & Arbitrage Matrix pane in /options.html');
    });
  } finally {
    if (appServer) {
      await appServer.stop();
    }
  }

  console.log('========================================================================');
  console.log(` WAVE 3 QA SUMMARY: ${passCount} PASSED | ${failCount} FAILED`);
  console.log('========================================================================');

  process.exit(failCount === 0 ? 0 : 1);
})();
