'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
    isFiniteNumber,
    assertFiniteNumber,
    assertPositiveFinite,
    assertNonNegativeFinite,
    logDiagnostic,
    getRecentDiagnostics,
} = require('../src/engine/validation');
const { initDatabase, roundToTick, INITIAL_INSTRUMENTS } = require('../src/db/database');
const {
    Orderbook,
    MatchingEngine,
    findBinaryInsertIndex,
    compareFifoPriority,
} = require('../src/engine/orderbook');
const { SlabOrderbook } = require('../src/engine/slabOrderbook');
const { LobTimeMachine } = require('../src/engine/lobTimeMachine');
const {
    normPdf,
    normCdf,
    priceBlackScholes,
    solveImpliedVolatility,
    buildOptionsChainAndSurface,
} = require('../src/engine/optionsGreeks');
const {
    choleskyDecomposition,
    computeReturnRiskMetrics,
    computePortfolioVaR,
    computeMicrostructureAlpha,
    generateQuantBriefing,
    runStrategyBacktest,
} = require('../src/engine/quantRisk');
const {
    evaluateNelsonSiegelSvensson,
    calibrateNelsonSiegelSvensson,
    priceBond,
    solveBondYtm,
    solveBondZSpread,
    shockBondPrice,
    buildMacroBondDeskReport,
} = require('../src/engine/yieldCurveFixedIncome');
const {
    SOH,
    computeFixChecksum,
    buildFixMessage,
    parseFixMessage,
    encodeSbeOrder,
    decodeSbeOrder,
    executeFixOrder,
} = require('../src/engine/fixProtocol');
const { SmartOrderRouter } = require('../src/engine/smartOrderRouter');
const { DarkPoolEngine } = require('../src/engine/darkPoolEngine');
const { AlgoExecutionEngine } = require('../src/engine/algoEngine');
const { MarketSimulator } = require('../src/engine/marketSim');
const { createArgusServer } = require('../src/server/index');
const { validateReadOnlySql, validateWebhookTargetUrl } = require('../src/server/routes');

function requestHttp(baseUrl, method, reqPath, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(baseUrl);
        const payload = body !== null
            ? (typeof body === 'string' ? body : JSON.stringify(body))
            : null;
        const req = http.request({
            hostname: target.hostname,
            port: target.port,
            path: reqPath,
            method,
            headers: {
                ...(payload !== null ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                } : {}),
                ...headers,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try {
                    json = JSON.parse(raw);
                } catch {
                    json = null;
                }
                resolve({ status: res.statusCode || 0, raw, json, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (payload !== null) {
            req.write(payload);
        }
        req.end();
    });
}

describe('Validation & Database Core Unit Suite', () => {
    it('validates finite numbers and rejects boolean/NaN/Infinity traps', () => {
        assert.equal(isFiniteNumber(42.5), true);
        assert.equal(isFiniteNumber(0), true);
        assert.equal(isFiniteNumber(true), false);
        assert.equal(isFiniteNumber(false), false);
        assert.equal(isFiniteNumber(''), false);
        assert.equal(isFiniteNumber('not-a-number'), false);
        assert.equal(isFiniteNumber(NaN), false);
        assert.equal(isFiniteNumber(Infinity), false);
        assert.equal(isFiniteNumber(-Infinity), false);

        assert.equal(assertFiniteNumber(-12.5, 'val'), -12.5);
        assert.equal(assertPositiveFinite(0.001, 'pos'), 0.001);
        assert.equal(assertNonNegativeFinite(0, 'nonNeg'), 0);

        assert.throws(() => assertFiniteNumber(NaN, 'val'), /finite number/);
        assert.throws(() => assertFiniteNumber(true, 'val'), /finite number/);
        assert.throws(() => assertPositiveFinite(0, 'pos'), /positive finite number/);
        assert.throws(() => assertPositiveFinite(-1, 'pos'), /positive finite number/);
        assert.throws(() => assertNonNegativeFinite(-0.01, 'nonNeg'), /non-negative finite number/);

        const entry = logDiagnostic('unit-test', 'sample_op', new Error('boom'));
        assert.equal(entry.component, 'unit-test');
        assert.equal(entry.event, 'sample_op');
        assert.ok(getRecentDiagnostics().length >= 1);
    });

    it('rounds prices to tick size and seeds an isolated in-memory SQLite database idempotently', () => {
        assert.equal(roundToTick(94500.37, 0.5), 94500.5);
        assert.equal(roundToTick(1.08426, 0.0001), 1.0843);
        assert.throws(() => roundToTick(NaN, 0.5), /finite number/);
        assert.throws(() => roundToTick(100, 0), /positive finite number/);

        const db = initDatabase({ memory: true });
        try {
            const instruments = db.prepare('SELECT COUNT(*) as c FROM instruments').get();
            assert.equal(instruments.c, 6);
            const candles = db.prepare('SELECT COUNT(*) as c FROM candles').get();
            assert.ok(candles.c > 500);
        } finally {
            db.close();
        }
    });
});

describe('Orderbook & MatchingEngine Unit Suite', () => {
    const btcInstrument = INITIAL_INSTRUMENTS[0];

    it('maintains strict price-time FIFO ordering with O(log N) binary insertion and multi-level batch sweeps', () => {
        const db = initDatabase({ memory: true });
        try {
            const ob = new Orderbook(btcInstrument, db);
            ob.bids = [];
            ob.asks = [];

            ob._insertResting({
                id: 'ASK-1',
                accountId: 'ACC-INST-02',
                symbol: 'BTC-USD',
                side: 'SELL',
                type: 'LIMIT',
                price: 94510,
                size: 1.0,
                filledSize: 0,
                remainingSize: 1.0,
                status: 'OPEN',
                clientTag: 'MM',
                createdAt: 1000,
                isSynthetic: true,
            });
            ob._insertResting({
                id: 'ASK-2',
                accountId: 'ACC-INST-02',
                symbol: 'BTC-USD',
                side: 'SELL',
                type: 'LIMIT',
                price: 94505,
                size: 1.0,
                filledSize: 0,
                remainingSize: 1.0,
                status: 'OPEN',
                clientTag: 'MM',
                createdAt: 1001,
                isSynthetic: true,
            });
            ob._insertResting({
                id: 'ASK-3',
                accountId: 'ACC-INST-02',
                symbol: 'BTC-USD',
                side: 'SELL',
                type: 'LIMIT',
                price: 94505,
                size: 1.5,
                filledSize: 0,
                remainingSize: 1.5,
                status: 'OPEN',
                clientTag: 'MM',
                createdAt: 1002,
                isSynthetic: true,
            });

            assert.ok(compareFifoPriority(ob.asks[0], ob.asks[1], 'SELL') < 0);
            assert.equal(findBinaryInsertIndex(ob.asks, { side: 'SELL', price: 94520, createdAt: 2000, _seq: 99 }), 3);
            assert.deepEqual(ob.asks.map((o) => o.id), ['ASK-2', 'ASK-3', 'ASK-1']);

            // Sweep across ASK-2 (full 1.0) and ASK-3 (partial 0.5)
            const res = ob.submitOrder({
                accountId: 'ACC-INST-01',
                side: 'BUY',
                type: 'LIMIT',
                price: 94505,
                size: 1.5,
            });
            assert.equal(res.order.status, 'FILLED');
            assert.equal(res.fills.length, 2);
            assert.equal(res.fills[0].makerOrderId, 'ASK-2');
            assert.equal(res.fills[0].size, 1.0);
            assert.equal(res.fills[1].makerOrderId, 'ASK-3');
            assert.equal(res.fills[1].size, 0.5);
            assert.equal(ob.asks[0].id, 'ASK-3');
            assert.equal(ob.asks[0].remainingSize, 1.0);
        } finally {
            db.close();
        }
    });

    it('supports order cancellation and amendOrder (preserving priority on size reduction, re-sequencing on price/size increase)', () => {
        const db = initDatabase({ memory: true });
        try {
            const ob = new Orderbook(btcInstrument, db);
            ob.bids = [];

            const o1 = ob.submitOrder({
                accountId: 'ACC-INST-01',
                side: 'BUY',
                type: 'LIMIT',
                price: 94000,
                size: 2.0,
                isSynthetic: true,
            }).order;
            const o2 = ob.submitOrder({
                accountId: 'ACC-INST-02',
                side: 'BUY',
                type: 'LIMIT',
                price: 94000,
                size: 2.0,
                isSynthetic: true,
            }).order;

            const topTwoIds = () => ob.bids.filter((o) => o.id === o1.id || o.id === o2.id).map((o) => o.id);
            assert.deepEqual(topTwoIds(), [o1.id, o2.id]);

            // Size down at same price keeps FIFO priority ahead of o2
            const downRes = ob.amendOrder(o1.id, { size: 1.25 });
            assert.equal(downRes.remainingSize, 1.25);
            assert.deepEqual(topTwoIds(), [o1.id, o2.id]);

            // Size increase at same price loses time priority (moves behind o2)
            const upRes = ob.amendOrder(o1.id, { size: 3.0 });
            assert.equal(upRes.remainingSize, 3.0);
            assert.deepEqual(topTwoIds(), [o2.id, o1.id]);

            // Price improvement moves o1 ahead of o2
            ob.amendOrder(o1.id, { price: 94005 });
            assert.deepEqual(topTwoIds(), [o1.id, o2.id]);

            // Cancel order
            const cancelled = ob.cancelOrder(o1.id);
            assert.equal(cancelled.status, 'CANCELLED');
            assert.equal(ob.cancelOrder('NON-EXISTENT'), null);
        } finally {
            db.close();
        }
    });

    it('enforces Self-Trade Prevention (CANCEL_TAKER, CANCEL_MAKER, SKIP) and rejects invalid NaN/Infinity/<=0 inputs', () => {
        const db = initDatabase({ memory: true });
        try {
            const ob = new Orderbook(btcInstrument, db);
            ob.asks = [];

            const selfAsk = ob.submitOrder({
                accountId: 'ACC-INST-01',
                side: 'SELL',
                type: 'LIMIT',
                price: 94500,
                size: 1.0,
                isSynthetic: true,
            }).order;
            ob.submitOrder({
                accountId: 'ACC-INST-02',
                side: 'SELL',
                type: 'LIMIT',
                price: 94500,
                size: 1.0,
                isSynthetic: true,
            });

            // CANCEL_TAKER aborts remaining taker quantity when encountering same account
            const stpTaker = ob.submitOrder({
                accountId: 'ACC-INST-01',
                side: 'BUY',
                type: 'LIMIT',
                price: 94500,
                size: 1.0,
                preventSelfTrade: true,
                stpMode: 'CANCEL_TAKER',
                isSynthetic: true,
            });
            assert.equal(stpTaker.fills.length, 0);
            assert.equal(stpTaker.order.status, 'CANCELLED');
            assert.equal(ob.asks.some((o) => o.id === selfAsk.id), true);

            // SKIP bypasses self order and fills against ACC-INST-02
            const stpSkip = ob.submitOrder({
                accountId: 'ACC-INST-01',
                side: 'BUY',
                type: 'LIMIT',
                price: 94500,
                size: 1.0,
                preventSelfTrade: true,
                stpMode: 'SKIP',
                isSynthetic: true,
            });
            assert.equal(stpSkip.fills.length, 1);
            assert.equal(stpSkip.order.status, 'FILLED');
            assert.equal(ob.asks.some((o) => o.id === selfAsk.id), true);

            // CANCEL_MAKER cancels resting self order
            const stpMaker = ob.submitOrder({
                accountId: 'ACC-INST-01',
                side: 'BUY',
                type: 'LIMIT',
                price: 94500,
                size: 1.0,
                preventSelfTrade: true,
                stpMode: 'CANCEL_MAKER',
                isSynthetic: true,
            });
            assert.equal(stpMaker.fills.length, 0);
            assert.equal(ob.asks.some((o) => o.id === selfAsk.id), false);

            // Validation guards
            assert.throws(() => ob.submitOrder({ side: 'BUY', type: 'LIMIT', price: NaN, size: 1 }), /positive number/);
            assert.throws(() => ob.submitOrder({ side: 'BUY', type: 'LIMIT', price: Infinity, size: 1 }), /positive number/);
            assert.throws(() => ob.submitOrder({ side: 'BUY', type: 'LIMIT', price: -10, size: 1 }), /positive number/);
            assert.throws(() => ob.submitOrder({ side: 'BUY', type: 'LIMIT', price: 94500, size: 0 }), /positive number/);
            assert.throws(() => ob.submitOrder({ side: 'BUY', type: 'LIMIT', price: 94500, size: -5 }), /positive number/);
            assert.throws(() => ob.submitOrder({ side: 'BUY', type: 'LIMIT', price: true, size: 1 }), /positive number/);
            assert.throws(() => ob.submitOrder({ side: 'HOLD', type: 'LIMIT', price: 94500, size: 1 }), /Invalid order side/);
            assert.throws(() => ob.submitOrder({ side: 'BUY', type: 'FOK', price: 94500, size: 1 }), /Invalid order type/);
        } finally {
            db.close();
        }
    });

    it('persists orders, positions, and buying-power checks through MatchingEngine', () => {
        const db = initDatabase({ memory: true });
        try {
            const engine = new MatchingEngine(db);
            const snap = engine.getSnapshot('BTC-USD', 10);
            assert.equal(snap.symbol, 'BTC-USD');
            assert.ok(snap.bids.length > 0 && snap.asks.length > 0);

            const placed = engine.submitOrder({
                symbol: 'BTC-USD',
                side: 'BUY',
                type: 'LIMIT',
                price: snap.bids[0].price,
                size: 0.1,
            });
            assert.equal(placed.order.status, 'OPEN');

            const amended = engine.amendOrder(placed.order.id, { size: 0.05 });
            assert.equal(amended.size, 0.05);

            const cancelled = engine.cancelOrder(placed.order.id);
            assert.equal(cancelled.status, 'CANCELLED');

            assert.throws(() => engine.submitOrder({
                symbol: 'BTC-USD',
                side: 'BUY',
                type: 'LIMIT',
                price: 95000,
                size: 100000,
            }), /Insufficient buying power/);
        } finally {
            db.close();
        }
    });
});

describe('SlabOrderbook & WASM Kernel Unit Suite', () => {
    it('executes zero-GC FIFO matching, O(1) cancellation, overflow ID mapping, and rejects invalid inputs', () => {
        const slab = new SlabOrderbook({ tickSize: 0.5, lotSize: 0.01 });

        const m1 = slab.submitSlabOrder('SELL', 94500, 1.0, 10);
        assert.equal(m1.matchCount, 0);
        const m2 = slab.submitSlabOrder('SELL', 94500, 2.0, 11);
        assert.equal(m2.matchCount, 0);

        // Overflow external orderId > maxDirectId uses overflowIdMap
        const overflowId = 2000000;
        const m3 = slab.submitSlabOrder('BUY', 94490, 1.5, overflowId);
        assert.equal(m3.restingId, overflowId);
        assert.equal(slab.cancelSlabOrder(overflowId), true);
        assert.equal(slab.cancelSlabOrder(overflowId), false);

        // Sweep across resting asks
        const sweep = slab.submitSlabOrder('BUY', 94505, 1.5, 12);
        assert.equal(sweep.matchCount, 2);
        assert.equal(sweep.filledSize, 1.5);

        const metrics = slab.getSlabMetrics();
        assert.equal(metrics.wasmAccelerated, true);
        assert.ok(metrics.capacity >= 65536);

        assert.equal(slab.cancelSlabOrder(-1), false);
        assert.equal(slab.cancelSlabOrder(NaN), false);
        assert.throws(() => slab.submitSlabOrder('BUY', NaN, 1.0), /finite number/);
        assert.throws(() => slab.submitSlabOrder('BUY', Infinity, 1.0), /finite number/);
        assert.throws(() => slab.submitSlabOrder('BUY', 0, 1.0), /positive finite number/);
        assert.throws(() => slab.submitSlabOrder('BUY', 94500, -1), /positive finite number/);
        assert.throws(() => slab.submitSlabOrder('BUY', true, 1.0), /finite number/);
        assert.throws(() => slab.submitSlabOrder('INVALID', 94500, 1.0), /Invalid slab order side/);
    });
});

describe('LOBTimeMachine Ring-Buffer Eviction & Deterministic Replay Unit Suite', () => {
    it('bounds event journal to maxEvents while preserving 100% deterministic SHA-256 replay across retained window', () => {
        const tm = new LobTimeMachine(null, {
            keyframeInterval: 10,
            maxEvents: 35,
        });

        for (let i = 0; i < 30; i++) {
            tm.recordEvent({
                symbol: 'BTC-USD',
                eventType: i % 3 === 0 ? 'ADD_LIMIT' : (i % 3 === 1 ? 'PARTIAL_FILL' : 'CANCEL_LIMIT'),
                side: i % 2 === 0 ? 'BUY' : 'SELL',
                price: 94500 + (i % 5) * 0.5,
                size: 0.25 + (i % 4) * 0.1,
            });
        }

        const timeline = tm.getTimeline('BTC-USD', 100);
        assert.ok(timeline.totalEvents <= 35, `Expected <= 35 events, got ${timeline.totalEvents}`);
        assert.ok(timeline.minSeq > 1, 'Expected oldest events to be evicted past seq 1');

        // Verify deterministic replay at minSeq, midSeq, and maxSeq
        const midSeq = Math.floor((timeline.minSeq + timeline.maxSeq) / 2);
        for (const targetSeq of [timeline.minSeq, midSeq, timeline.maxSeq]) {
            const r1 = tm.seekToSequence('BTC-USD', targetSeq);
            const r2 = tm.seekToSequence('BTC-USD', targetSeq);
            assert.equal(r1.deterministicVerified, true);
            assert.equal(r1.stateHash, r2.stateHash);
            assert.equal(r1.seq, targetSeq);
        }

        const tsReplay = tm.seekToTimestamp('BTC-USD', timeline.endTimestamp - 5000);
        assert.equal(tsReplay.deterministicVerified, true);

        assert.throws(() => tm.recordEvent({ symbol: 'BTC-USD', side: 'BUY', price: -1, size: 1 }), /positive finite number/);
        assert.throws(() => tm.recordEvent({ symbol: 'BTC-USD', side: 'BUY', price: 94500, size: 0 }), /positive finite number/);
        assert.throws(() => new LobTimeMachine(null, { maxEvents: 0 }), /finite integer >= 2/);
    });
});

describe('OptionsGreeks Edge Cases (T=0, sigma=0, S<=0, IV Solver) Unit Suite', () => {
    it('evaluates exact intrinsic value at expiry (T=0) and zero volatility (sigma=0) without NaN or division by zero', () => {
        const atExpiry = priceBlackScholes({
            S: 105, K: 100, T: 0, r: 0.05, sigma: 0.25, optionType: 'call',
        });
        assert.equal(atExpiry.price, 5);
        assert.equal(atExpiry.call.intrinsicValue, 5);
        assert.equal(atExpiry.call.timeValue, 0);
        assert.equal(atExpiry.gamma, 0);
        assert.equal(atExpiry.vega, 0);
        assert.equal(atExpiry.call.delta, 1);
        assert.equal(atExpiry.put.price, 0);
        assert.equal(atExpiry.put.delta, 0);

        const zeroSigmaCall = priceBlackScholes({
            S: 100, K: 100, T: 1.0, r: 0.05, sigma: 0, optionType: 'call',
        });
        const expectedZeroSigma = 100 - 100 * Math.exp(-0.05);
        assert.ok(Math.abs(zeroSigmaCall.price - expectedZeroSigma) < 1e-4);
        assert.equal(zeroSigmaCall.gamma, 0);
        assert.equal(zeroSigmaCall.vega, 0);

        // Deep ITM / OTM numerical stability
        const deepItm = priceBlackScholes({
            S: 500, K: 50, T: 0.5, r: 0.04, sigma: 0.2, optionType: 'call',
        });
        assert.ok(deepItm.delta > 0.999 && deepItm.delta <= 1.0);
        assert.ok(Number.isFinite(deepItm.vanna) && Number.isFinite(deepItm.vomma));

        assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
        assert.ok(normPdf(0) > 0.3989);
    });

    it('rejects S<=0, K<=0, T<0, sigma<0, boolean, and NaN inputs and solves Implied Volatility accurately', () => {
        assert.throws(() => priceBlackScholes({ S: 0, K: 100, T: 0.5, sigma: 0.2 }), /positive finite number/);
        assert.throws(() => priceBlackScholes({ S: -10, K: 100, T: 0.5, sigma: 0.2 }), /positive finite number/);
        assert.throws(() => priceBlackScholes({ S: 100, K: 0, T: 0.5, sigma: 0.2 }), /positive finite number/);
        assert.throws(() => priceBlackScholes({ S: 100, K: 100, T: -0.1, sigma: 0.2 }), /non-negative finite number/);
        assert.throws(() => priceBlackScholes({ S: 100, K: 100, T: 0.5, sigma: -0.2 }), /non-negative finite number/);
        assert.throws(() => priceBlackScholes({ S: true, K: 100, T: 0.5, sigma: 0.2 }), /finite number/);

        const targetGreeks = priceBlackScholes({
            S: 100, K: 105, T: 0.5, r: 0.045, sigma: 0.32, optionType: 'call',
        });
        const ivSolved = solveImpliedVolatility({
            targetPrice: targetGreeks.price,
            S: 100,
            K: 105,
            T: 0.5,
            r: 0.045,
            optionType: 'call',
        });
        assert.equal(ivSolved.converged, true);
        assert.ok(Math.abs(ivSolved.impliedVol - 0.32) < 1e-3);

        const surface = buildOptionsChainAndSurface({ symbol: 'BTC-USD', spotPrice: 94500 });
        assert.equal(surface.surface.length, surface.tenors.length);
    });
});

describe('QuantRisk Edge Cases (Empty Returns, Zero Variance, VaR, Backtest) Unit Suite', () => {
    it('handles empty returns and zero-variance constant returns in computeReturnRiskMetrics without division-by-zero NaN', () => {
        const emptyMetrics = computeReturnRiskMetrics([]);
        assert.equal(emptyMetrics.count, 0);
        assert.equal(emptyMetrics.sharpeRatio, 0);
        assert.equal(emptyMetrics.sortinoRatio, 0);
        assert.equal(emptyMetrics.historicalVar95, 0);

        const zeroVarMetrics = computeReturnRiskMetrics([0.001, 0.001, 0.001, 0.001, 0.001]);
        assert.equal(zeroVarMetrics.variance, 0);
        assert.equal(zeroVarMetrics.stdDev, 0);
        assert.equal(zeroVarMetrics.sharpeRatio, 0);
        assert.equal(zeroVarMetrics.sortinoRatio, 0);
        assert.equal(Number.isFinite(zeroVarMetrics.historicalVar95), true);
        assert.equal(Number.isFinite(zeroVarMetrics.historicalCvar99), true);

        const realistic = computeReturnRiskMetrics([0.01, -0.005, 0.012, -0.008, 0.015, -0.002, 0.009]);
        assert.ok(Number.isFinite(realistic.sharpeRatio));
        assert.ok(Number.isFinite(realistic.sortinoRatio));
        assert.throws(() => computeReturnRiskMetrics([0.01, NaN]), /finite number/);
    });

    it('computes Cholesky decomposition, Portfolio VaR, Microstructure Alpha, Quant Briefing, and Backtest', () => {
        const L = choleskyDecomposition([
            [1.0, 0.5],
            [0.5, 1.0],
        ]);
        assert.equal(L.length, 2);
        assert.ok(Math.abs(L[0][0] - 1.0) < 1e-9);

        const db = initDatabase({ memory: true });
        try {
            const engine = new MatchingEngine(db);
            const sim = new MarketSimulator(engine, db);
            const varResult = computePortfolioVaR(db, engine, sim, 'ACC-INST-01', 1500);
            assert.equal(varResult.paths, 1500);
            assert.ok(varResult.monteCarlo.var99 >= varResult.monteCarlo.var95);

            const micro = computeMicrostructureAlpha(db, engine, 'BTC-USD');
            assert.equal(micro.symbol, 'BTC-USD');
            assert.ok(micro.vpin >= 0 && micro.vpin <= 1);

            const briefing = generateQuantBriefing(db, engine, sim, 'BTC-USD');
            assert.ok(typeof briefing.headline === 'string' && briefing.headline.length > 10);

            const bt = runStrategyBacktest(db, { symbol: 'BTC-USD', strategy: 'EMA_CROSS', initialCapital: 50000 });
            assert.equal(bt.initialCapital, 50000);
            assert.ok(Array.isArray(bt.equityCurve) && bt.equityCurve.length > 0);
            assert.equal(bt.equityCurve[bt.equityCurve.length - 1].equity, bt.finalEquity);
            assert.ok(bt.equityCurve.every((pt) => Number.isFinite(pt.equity) && pt.equity > 0));
            assert.ok(Number.isFinite(bt.finalEquity) && bt.finalEquity > 0);
            assert.ok(bt.maxDrawdownPct >= 0 && bt.maxDrawdownPct <= 100);

            assert.throws(() => computePortfolioVaR(db, engine, sim, 'ACC-INST-01', 0), /positive finite number/);
            assert.throws(() => runStrategyBacktest(db, { initialCapital: -100 }), /positive finite number/);
        } finally {
            db.close();
        }
    });
});

describe('YieldCurve & FixedIncome Edge Cases (Degenerate Tenors, Zero Coupon) Unit Suite', () => {
    it('evaluates NSS at tau=0, calibrates degenerate/duplicate tenors without NaN, and prices zero-coupon bonds', () => {
        const rateAtZero = evaluateNelsonSiegelSvensson(0, {
            beta0: 0.042, beta1: 0.011, beta2: -0.005, beta3: -0.002, lambda1: 1.5, lambda2: 0.4,
        });
        assert.ok(Math.abs(rateAtZero.spotYield - 0.053) < 1e-6);

        // Degenerate duplicate tenors should still solve via diagonal ridge regularization
        const degenerateFit = calibrateNelsonSiegelSvensson([
            { maturityYears: 2.0, yield: 4.5 },
            { maturityYears: 2.0, yield: 4.5 },
            { maturityYears: 2.0, yield: 4.5 },
        ]);
        assert.ok(Number.isFinite(degenerateFit.beta0));
        assert.ok(Number.isFinite(degenerateFit.beta1));
        assert.equal(degenerateFit.fittedPoints.length, 3);

        assert.throws(() => calibrateNelsonSiegelSvensson([{ maturityYears: 1, yield: 4 }]), /At least 3/);
        assert.throws(() => calibrateNelsonSiegelSvensson([
            { maturityYears: 0, yield: 4 },
            { maturityYears: 2, yield: 4 },
            { maturityYears: 5, yield: 4 },
        ]), /positive finite number/);

        // Zero-coupon bond: Macaulay duration must equal exact maturityYears
        const zeroCoupon = priceBond({
            faceValue: 1000,
            couponRate: 0,
            maturityYears: 5,
            ytm: 0.04,
            frequency: 2,
        });
        assert.ok(Math.abs(zeroCoupon.macaulayDuration - 5.0) < 1e-6);
        assert.ok(zeroCoupon.cleanPrice > 0 && zeroCoupon.cleanPrice < 1000);

        const solvedYtm = solveBondYtm({
            targetPrice: zeroCoupon.cleanPrice,
            faceValue: 1000,
            couponRate: 0,
            maturityYears: 5,
            frequency: 2,
        });
        assert.equal(solvedYtm.converged, true);
        assert.ok(Math.abs(solvedYtm.ytmPct - 4.0) < 1e-2);

        const zSpread = solveBondZSpread({
            dirtyPrice: zeroCoupon.cleanPrice,
            faceValue: 1000,
            couponRate: 0,
            maturityYears: 5,
            frequency: 2,
        });
        assert.equal(zSpread.converged, true);

        const shocked = shockBondPrice({ maturityYears: 10 }, [-100, 0, 100]);
        assert.equal(shocked.scenarios.length, 3);
        assert.ok(shocked.scenarios[0].exactDirtyPrice > shocked.baseBond.dirtyPrice);
        assert.equal(shocked.scenarios[1].exactPriceChange, 0);
        assert.ok(shocked.scenarios[2].exactDirtyPrice < shocked.baseBond.dirtyPrice);
        assert.ok(shocked.scenarios[2].exactPriceChange < 0);

        const snap = buildMacroBondDeskReport();
        assert.ok(Array.isArray(snap.bonds) && snap.bonds.length >= 4);
        for (const bond of snap.bonds) {
            assert.ok(bond.dirtyPrice > 0 && bond.macaulayDuration > 0 && bond.convexity > 0);
        }
        assert.ok(snap.deskSummary.totalNotionalUsd > 0 && snap.deskSummary.totalDv01Usd > 0);
    });
});

describe('FIX 4.4 & SBE Binary Wire Protocol Unit Suite', () => {
    it('detects tampered checksums, malformed tag=value pairs, missing SOH, and blocks execution on invalid checksum', () => {
        const rawFix = buildFixMessage(
            'D',
            {
                11: 'CL-900',
                55: 'BTC-USD',
                54: '1',
                38: '0.5',
                40: '2',
                44: '94500',
            },
            { delimiter: SOH }
        );

        // Tamper with price without updating tag 10 checksum
        const tamperedFix = rawFix.replace('44=94500', '44=91000');
        const parsedTampered = parseFixMessage(tamperedFix);
        assert.equal(parsedTampered.validChecksum, false);

        const db = initDatabase({ memory: true });
        try {
            const engine = new MatchingEngine(db);
            const execTampered = executeFixOrder(tamperedFix, engine);
            assert.equal(execTampered.success, false);
            assert.match(execTampered.error, /INVALID_FIX_CHECKSUM/);

            // Valid order execution via FIX
            const execValid = executeFixOrder(rawFix, engine);
            assert.equal(execValid.success, true);
            assert.ok(execValid.order);
        } finally {
            db.close();
        }

        // Malformed tag=value token and missing trailing SOH
        const malformedRaw = `8=FIX.4.4${SOH}9=15${SOH}35=D${SOH}BADTOKEN${SOH}10=000`;
        const parsedMalformed = parseFixMessage(malformedRaw);
        assert.equal(parsedMalformed.hasTrailingDelimiter, false);
        assert.deepEqual(parsedMalformed.malformedTokens, ['BADTOKEN']);
        assert.equal(parsedMalformed.validStructure, false);
        assert.equal(computeFixChecksum('ABC').length, 3);

        // SBE roundtrip and validation
        const buf = encodeSbeOrder({
            orderIdNum: 42,
            symbol: 'ETH-USD',
            side: 'SELL',
            ordType: 'LIMIT',
            price: 2850.5,
            size: 3.25,
        });
        const decoded = decodeSbeOrder(buf);
        assert.equal(decoded.byteLength, 40);
        assert.equal(decoded.symbol, 'ETH-USD');
        assert.equal(decoded.price, 2850.5);
        assert.equal(decoded.size, 3.25);

        assert.throws(() => decodeSbeOrder(Buffer.alloc(10)), /expected 40 bytes/);
        assert.throws(() => encodeSbeOrder({ price: NaN, size: 1 }), /finite number/);
        assert.throws(() => encodeSbeOrder({ price: 100, size: -1 }), /non-negative finite number/);
    });
});

describe('SmartOrderRouter, DarkPoolEngine, AlgoEngine & MarketSimulator Unit Suite', () => {
    it('routes multi-venue orders, executes dark pool midpoint crosses with MAQ/VPIN guards, and runs algo slices', () => {
        const db = initDatabase({ memory: true });
        try {
            const engine = new MatchingEngine(db);
            const sor = new SmartOrderRouter(engine);
            const venues = sor.getVenues();
            assert.equal(venues.length, 4);

            const routed = sor.routeOrder({
                symbol: 'BTC-USD',
                side: 'BUY',
                totalSize: 0.5,
                executeOnPrimary: true,
            });
            assert.equal(routed.totalSize, 0.5);
            assert.ok(routed.allocations.length >= 1);
            assert.throws(() => sor.routeOrder({ symbol: 'BTC-USD', side: 'BUY', totalSize: -1 }), /positive finite number/);

            const arb = sor.scanArbitrage();
            assert.ok(Array.isArray(arb.opportunities) && arb.opportunities.length > 0);
            for (const opp of arb.opportunities) {
                assert.ok(opp.netEdgeBps > 0, `Expected positive net arbitrage edge, got ${opp.netEdgeBps}`);
                assert.ok(opp.sellBid > opp.buyAsk, `Expected sellBid (${opp.sellBid}) > buyAsk (${opp.buyAsk})`);
            }

            // Dark pool midpoint cross & MAQ anti-pinging
            const dp = new DarkPoolEngine(engine);
            const blockSell = dp.submitDarkOrder({
                symbol: 'BTC-USD',
                side: 'SELL',
                size: 2.0,
                minQty: 0.5,
                accountId: 'ACC-INST-02',
            });
            assert.ok(blockSell.order);

            // Qualifying block buy crosses at midpoint
            const blockBuy = dp.submitDarkOrder({
                symbol: 'BTC-USD',
                side: 'BUY',
                size: 1.0,
                minQty: 0.5,
                accountId: 'ACC-INST-01',
            });
            assert.ok(blockBuy.fills.length >= 1);
            assert.throws(() => dp.submitDarkOrder({ symbol: 'BTC-USD', side: 'BUY', size: 0 }), /positive number/);

            // AlgoExecutionEngine lifecycle
            const algo = new AlgoExecutionEngine(engine, db);
            const twap = algo.startAlgo({
                strategy: 'TWAP',
                symbol: 'BTC-USD',
                side: 'BUY',
                totalSize: 0.4,
                slices: 4,
            });
            assert.ok(twap.id);
            const cancelled = algo.cancelAlgo(twap.id);
            assert.equal(cancelled.status, 'CANCELLED');
            algo.stopAll();

            // MarketSimulator deterministic tick step
            const sim = new MarketSimulator(engine, db);
            sim.step();
            const tickers = sim.getTickers();
            assert.equal(tickers.length, 6);
        } finally {
            db.close();
        }
    });
});

describe('HTTP Server & Security Hardening (URIError, Sibling Path Traversal, SSRF Redirect & Stream Cap)', () => {
    let srv;
    let baseUrl;

    before(async () => {
        srv = await createArgusServer({ port: 0, memoryDb: true, simIntervalMs: 60000 });
        baseUrl = `http://127.0.0.1:${srv.port}`;
    });

    after(async () => {
        if (srv) {
            await srv.stop();
        }
    });

    it('returns 400 Bad Request on malformed percent-encoded URLs without crashing the server', async () => {
        const badStatic = await requestHttp(baseUrl, 'GET', '/%E0%A4%A');
        assert.equal(badStatic.status, 400);
        assert.match(badStatic.raw, /Bad Request/i);

        const badApi = await requestHttp(baseUrl, 'GET', '/api/%E0%A4%A');
        assert.equal(badApi.status, 400);
        assert.match(badApi.json.error, /Malformed URL/i);

        const badDelete = await requestHttp(baseUrl, 'DELETE', '/api/orders/%E0%A4%A');
        assert.equal(badDelete.status, 400);

        // Server remains healthy afterwards
        const health = await requestHttp(baseUrl, 'GET', '/api/health');
        assert.equal(health.status, 200);
        assert.equal(health.json.status, 'ok');
    });

    it('blocks sibling-prefix path traversal (/..%2fpublic-evil/secret.txt) and dotfile traversal with 403', async () => {
        const siblingTraversal = await requestHttp(baseUrl, 'GET', '/..%2fpublic-evil/secret.txt');
        assert.equal(siblingTraversal.status, 403);

        const parentTraversal = await requestHttp(baseUrl, 'GET', '/..%2fpackage.json');
        assert.equal(parentTraversal.status, 403);
    });

    it('enforces read-only SQL query validation and blocks SSRF loopback, 302 redirects to 127.0.0.1, timeouts, and >4KB responses', async () => {
        assert.equal(validateReadOnlySql('SELECT * FROM instruments LIMIT 1').valid, true);
        assert.equal(validateReadOnlySql('DROP TABLE instruments').valid, false);
        assert.equal(validateReadOnlySql('SELECT 1; SELECT 2').valid, false);

        assert.equal(validateWebhookTargetUrl('https://hooks.example.com/notify').valid, true);
        assert.equal(validateWebhookTargetUrl('http://127.0.0.1:8080/internal').valid, false);
        assert.equal(validateWebhookTargetUrl('http://169.254.169.254/latest/meta-data').valid, false);
        assert.equal(validateWebhookTargetUrl('http://[::1]:8080/admin').valid, false);

        const originalFetch = global.fetch;
        try {
            // 1. Mock a 302 redirect pointing to http://127.0.0.1:8080/admin
            let fetchOptionsSeen = null;
            global.fetch = async (_url, opts) => {
                fetchOptionsSeen = opts;
                return new Response(null, {
                    status: 302,
                    headers: { location: 'http://127.0.0.1:8080/admin' },
                });
            };

            const redirectRes = await requestHttp(baseUrl, 'POST', '/api/webhooks/test', {
                url: 'https://hooks.example.com/redirect-me',
                payload: { ping: true },
            });
            assert.equal(fetchOptionsSeen.redirect, 'manual');
            assert.equal(redirectRes.status, 403);
            assert.match(redirectRes.json.error, /redirect.*blocked/i);

            // 2. Mock an oversized >4 KB response stream and verify cancellation + 4096-byte cap
            let streamCancelled = false;
            const bigChunk = new Uint8Array(3000).fill(65); // 'A'
            global.fetch = async () => ({
                status: 200,
                headers: new Headers(),
                body: {
                    getReader() {
                        let calls = 0;
                        return {
                            async read() {
                                calls += 1;
                                if (calls <= 3) {
                                    return { done: false, value: bigChunk };
                                }
                                return { done: true, value: undefined };
                            },
                            async cancel() {
                                streamCancelled = true;
                            },
                        };
                    },
                },
            });

            const cappedRes = await requestHttp(baseUrl, 'POST', '/api/webhooks/test', {
                url: 'https://hooks.example.com/huge-body',
                payload: { ping: true },
            });
            assert.equal(cappedRes.status, 200);
            assert.equal(cappedRes.json.truncated, true);
            assert.equal(cappedRes.json.bodySnippet.length, 2000);
            assert.equal(streamCancelled, true);

            // 3. Mock timeout error -> 504 Gateway Timeout
            global.fetch = async () => {
                const err = new Error('The operation was aborted due to timeout');
                err.name = 'TimeoutError';
                throw err;
            };
            const timeoutRes = await requestHttp(baseUrl, 'POST', '/api/webhooks/test', {
                url: 'https://hooks.example.com/slow',
                payload: { ping: true },
            });
            assert.equal(timeoutRes.status, 504);
            assert.match(timeoutRes.json.error, /timed out/i);
        } finally {
            global.fetch = originalFetch;
        }
    });
});
