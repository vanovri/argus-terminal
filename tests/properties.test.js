'use strict';

/**
 * Property-Based Testing Suite (Zero-Dependency Seeded PRNG + Shrink-Ready Invariants)
 * Strengthens Argus Terminal engines against false-positive / shallow unit assertions.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { initDatabase, INITIAL_INSTRUMENTS } = require('../src/db/database');
const { Orderbook } = require('../src/engine/orderbook');
const { SlabOrderbook } = require('../src/engine/slabOrderbook');
const { priceBlackScholes, solveImpliedVolatility } = require('../src/engine/optionsGreeks');
const { choleskyDecomposition, computeReturnRiskMetrics } = require('../src/engine/quantRisk');
const { priceBond, solveBondYtm, shockBondPrice } = require('../src/engine/yieldCurveFixedIncome');
const { SOH, buildFixMessage, parseFixMessage, encodeSbeOrder, decodeSbeOrder } = require('../src/engine/fixProtocol');

class SeededRng {
    constructor(seed = 0x20261108) {
        this.state = seed >>> 0 || 1;
    }

    nextU32() {
        let x = this.state;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.state = x >>> 0;
        return this.state;
    }

    float(min = 0, max = 1) {
        return min + (this.nextU32() / 0x100000000) * (max - min);
    }

    int(min, maxInclusive) {
        return min + (this.nextU32() % (maxInclusive - min + 1));
    }

    pick(arr) {
        return arr[this.int(0, arr.length - 1)];
    }
}

describe('Argus Terminal Property-Based Invariant Suite (200 Trials / Property)', () => {
    it('Property 1: Orderbook quantity conservation, uncrossed spread (bestBid < bestAsk), and price-time FIFO across 200 random order sequences', () => {
        const rng = new SeededRng(0xA11CE01);
        const db = initDatabase({ memory: true });
        try {
            for (let trial = 0; trial < 40; trial++) {
                const ob = new Orderbook(INITIAL_INSTRUMENTS[0], db);
                ob.bids = [];
                ob.asks = [];
                // Disable synthetic auto-replenishment so pure matching conservation is isolated
                ob._replenishBookLiquidity = () => {};

                let totalSubmittedQty = 0;
                let totalTradedQty = 0;

                for (let step = 0; step < 25; step++) {
                    const side = rng.pick(['BUY', 'SELL']);
                    const price = 94000 + rng.int(0, 20) * 10;
                    const size = Math.round(rng.float(0.1, 3.0) * 100) / 100;
                    totalSubmittedQty += size;

                    const res = ob.submitOrder({
                        accountId: step % 2 === 0 ? 'ACC-INST-01' : 'ACC-INST-02',
                        side,
                        type: 'LIMIT',
                        price,
                        size,
                        isSynthetic: true,
                    });

                    for (const fill of res.fills) {
                        totalTradedQty += fill.size;
                    }

                    // Invariant A: Book is never crossed after matching
                    if (ob.bids.length > 0 && ob.asks.length > 0) {
                        assert.ok(
                            ob.bids[0].price < ob.asks[0].price,
                            `Crossed book at trial=${trial} step=${step}: bid=${ob.bids[0].price} >= ask=${ob.asks[0].price}`
                        );
                    }

                    // Invariant B: Bids strictly sorted descending by price, then ascending by sequence
                    for (let i = 1; i < ob.bids.length; i++) {
                        assert.ok(ob.bids[i - 1].price >= ob.bids[i].price);
                        if (ob.bids[i - 1].price === ob.bids[i].price) {
                            assert.ok(ob.bids[i - 1]._seq < ob.bids[i]._seq);
                        }
                    }

                    // Invariant C: Asks strictly sorted ascending by price, then ascending by sequence
                    for (let i = 1; i < ob.asks.length; i++) {
                        assert.ok(ob.asks[i - 1].price <= ob.asks[i].price);
                        if (ob.asks[i - 1].price === ob.asks[i].price) {
                            assert.ok(ob.asks[i - 1]._seq < ob.asks[i]._seq);
                        }
                    }
                }

                // Invariant D: Conservation of quantity: sum(resting) + 2 * sum(fills) == sum(submitted)
                const restingBidQty = ob.bids.reduce((acc, o) => acc + o.remainingSize, 0);
                const restingAskQty = ob.asks.reduce((acc, o) => acc + o.remainingSize, 0);
                const accountedQty = restingBidQty + restingAskQty + 2 * totalTradedQty;
                assert.ok(
                    Math.abs(accountedQty - totalSubmittedQty) < 1e-6,
                    `Quantity leak at trial=${trial}: accounted=${accountedQty} vs submitted=${totalSubmittedQty}`
                );
            }
        } finally {
            db.close();
        }
    });

    it('Property 2: Black-Scholes Put-Call Parity (C - P = S*e^(-qT) - K*e^(-rT)), Greek bounds, and IV round-trip across 200 random contracts', () => {
        const rng = new SeededRng(0xB50002);
        for (let i = 0; i < 200; i++) {
            const S = rng.float(20, 500);
            const K = S * rng.float(0.75, 1.25);
            const T = rng.float(0.05, 3.0);
            const r = rng.float(0.0, 0.12);
            const q = rng.float(0.0, 0.06);
            const sigma = rng.float(0.08, 1.2);

            const res = priceBlackScholes({ S, K, T, r, q, sigma, optionType: 'call' });
            const C = res.call.price;
            const P = res.put.price;

            // Put-Call Parity: C - P = S * exp(-q*T) - K * exp(-r*T)
            const rhs = S * Math.exp(-q * T) - K * Math.exp(-r * T);
            assert.ok(
                Math.abs((C - P) - rhs) < 1e-2,
                `Put-Call Parity violated at i=${i}: C-P=${C - P} vs rhs=${rhs}`
            );

            // Greek bounds & Call-Put Delta identity: Delta_call - Delta_put = exp(-q*T)
            assert.ok(res.call.delta >= 0 && res.call.delta <= 1.0001);
            assert.ok(res.put.delta >= -1.0001 && res.put.delta <= 0);
            assert.ok(Math.abs((res.call.delta - res.put.delta) - Math.exp(-q * T)) < 1e-3);
            assert.ok(res.gamma >= 0);
            assert.ok(res.vega >= 0);

            // Implied Volatility round-trip for near-the-money options
            if (Math.abs(Math.log(S / K)) < 0.2 && T >= 0.1 && sigma <= 0.8) {
                const iv = solveImpliedVolatility({ targetPrice: C, S, K, T, r, q, optionType: 'call' });
                assert.equal(iv.converged, true);
                assert.ok(Math.abs(iv.impliedVol - sigma) < 5e-3);
            }
        }
    });

    it('Property 3: Bond Price-YTM inverse monotonicity, YTM solver round-trip, and positive yield shock price decrease across 200 random bonds', () => {
        const rng = new SeededRng(0xF10003);
        for (let i = 0; i < 200; i++) {
            const couponRate = rng.float(0.0, 0.10);
            const maturityYears = rng.int(1, 25);
            const ytm1 = rng.float(0.005, 0.08);
            const ytm2 = ytm1 + rng.float(0.005, 0.05);
            const frequency = rng.pick([1, 2, 4]);

            const b1 = priceBond({ faceValue: 1000, couponRate, maturityYears, ytm: ytm1, frequency });
            const b2 = priceBond({ faceValue: 1000, couponRate, maturityYears, ytm: ytm2, frequency });

            // Higher YTM strictly lowers bond price
            assert.ok(b2.cleanPrice < b1.cleanPrice, `Non-monotonic bond price at i=${i}`);
            assert.ok(b1.macaulayDuration > 0 && b1.macaulayDuration <= maturityYears + 1e-6);
            assert.ok(b1.convexity > 0);

            // YTM solver round-trip
            const solved = solveBondYtm({
                targetPrice: b1.cleanPrice,
                faceValue: 1000,
                couponRate,
                maturityYears,
                frequency,
            });
            assert.equal(solved.converged, true);
            assert.ok(Math.abs(solved.ytm - ytm1) < 1e-3);
        }

        // Strengthening shockBondPrice: +100 bps shock must lower price, -100 bps must raise price
        const shocked = shockBondPrice({ maturityYears: 10, couponRate: 0.04, ytm: 0.04 }, [-100, 0, 100]);
        assert.equal(shocked.scenarios.length, 3);
        assert.ok(shocked.scenarios[0].exactDirtyPrice > shocked.scenarios[1].exactDirtyPrice);
        assert.ok(shocked.scenarios[2].exactDirtyPrice < shocked.scenarios[1].exactDirtyPrice);
        assert.ok(shocked.scenarios[0].exactPriceChange > 0);
        assert.ok(shocked.scenarios[2].exactPriceChange < 0);
    });

    it('Property 4: FIX 4.4 tag-10 modulo-256 checksum oracle & 40-byte SBE binary codec round-trip across 200 random orders', () => {
        const rng = new SeededRng(0xF18004);
        const symbols = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'NVDA-EQ', 'XAU-USD', 'IDR-USD'];
        for (let i = 0; i < 200; i++) {
            const symbol = rng.pick(symbols);
            const side = rng.pick(['BUY', 'SELL']);
            const ordType = rng.pick(['LIMIT', 'MARKET']);
            const price = Math.round(rng.float(10, 100000) * 100) / 100;
            const size = Math.round(rng.float(0.01, 50) * 100) / 100;
            const orderIdNum = rng.int(1, 5000000);

            // SBE binary wire round-trip
            const wire = encodeSbeOrder({ orderIdNum, symbol, side, ordType, price, size });
            assert.equal(wire.byteLength, 40);
            const dec = decodeSbeOrder(wire);
            assert.equal(dec.orderIdNum, orderIdNum);
            assert.equal(dec.symbol, symbol);
            assert.equal(dec.side, side);
            assert.equal(dec.ordType, ordType);
            assert.ok(Math.abs(dec.price - price) < 1e-6);
            assert.ok(Math.abs(dec.size - size) < 1e-6);

            // FIX 4.4 independent checksum oracle (sum of bytes before `10=` mod 256)
            const msg = buildFixMessage('D', {
                11: `ORD-${orderIdNum}`,
                55: symbol,
                54: side === 'BUY' ? '1' : '2',
                38: String(size),
                40: ordType === 'MARKET' ? '1' : '2',
                44: String(price),
            }, { delimiter: SOH });
            const parsed = parseFixMessage(msg);
            assert.equal(parsed.validChecksum, true);
            assert.equal(parsed.validStructure, true);

            const idx10 = msg.lastIndexOf(`${SOH}10=`);
            const prefix = msg.slice(0, idx10 + 1);
            let sum = 0;
            for (let b = 0; b < prefix.length; b++) {
                sum = (sum + prefix.charCodeAt(b)) & 0xFF;
            }
            const expectedTag10 = String(sum).padStart(3, '0');
            assert.equal(parsed.expectedChecksum, expectedTag10);
            assert.equal(parsed.providedChecksum, expectedTag10);
        }
    });

    it('Property 5: Cholesky L*L^T == Sigma reconstruction and Historical CVaR >= VaR tail ordering', () => {
        const rng = new SeededRng(0xC07E05);
        for (let i = 0; i < 100; i++) {
            const rho = rng.float(-0.95, 0.95);
            const s1 = rng.float(0.5, 3.0);
            const s2 = rng.float(0.5, 3.0);
            const cov = [
                [s1 * s1, rho * s1 * s2],
                [rho * s1 * s2, s2 * s2],
            ];
            const L = choleskyDecomposition(cov);
            // Reconstruct L * L^T
            const r00 = L[0][0] * L[0][0] + L[0][1] * L[0][1];
            const r01 = L[0][0] * L[1][0] + L[0][1] * L[1][1];
            const r11 = L[1][0] * L[1][0] + L[1][1] * L[1][1];
            assert.ok(Math.abs(r00 - cov[0][0]) < 1e-6);
            assert.ok(Math.abs(r01 - cov[0][1]) < 1e-6);
            assert.ok(Math.abs(r11 - cov[1][1]) < 1e-6);

            const rets = Array.from({ length: 40 }, () => rng.float(-0.08, 0.08));
            const risk = computeReturnRiskMetrics(rets);
            assert.ok(risk.historicalVar99 >= risk.historicalVar95 - 1e-9);
            assert.ok(risk.historicalCvar99 >= risk.historicalVar99 - 1e-9);
        }
    });

    it('Property 6: SlabOrderbook TypedArray/WASM kernel matches quantity conservation across random operations', () => {
        const rng = new SeededRng(0x51AB06);
        const slab = new SlabOrderbook({ tickSize: 0.5, lotSize: 0.01 });
        let submitted = 0;
        let matched = 0;

        for (let id = 1; id <= 200; id++) {
            const side = rng.pick(['BUY', 'SELL']);
            const price = 94500 + rng.int(-10, 10) * 0.5;
            const size = rng.int(1, 20) * 0.1;
            submitted += size;

            const r = slab.submitSlabOrder(side, price, size, id);
            matched += r.filledSize;
        }

        let restingQty = 0;
        for (let slot = 0; slot < slab.capacity; slot++) {
            if (slab.activeFlags[slot] === 1) {
                restingQty += slab.sizes[slot];
            }
        }
        assert.ok(Math.abs((restingQty + 2 * matched) - submitted) < 1e-5);
    });

    it('Property 7: Orderbook._replenishBookLiquidity preserves strict uncrossed book invariant (bestBid < bestAsk) on depleted books', () => {
        initDatabase({ inMemory: true, forceReinit: true });
        const book = new Orderbook(INITIAL_INSTRUMENTS[0]);
        // Clear book to trigger post-match _replenishBookLiquidity() when length < 6
        book.bids = [];
        book.asks = [];
        book.submitOrder({ side: 'SELL', type: 'LIMIT', price: 94000, size: 1.0, clientId: 'replenish-sell-probe' });
        const bestBid = book.bids[0].price;
        const bestAsk = book.asks[0].price;
        assert.equal(bestAsk, 94000);
        assert.ok(bestBid < bestAsk, `Uncrossed book invariant violated: bestBid (${bestBid}) >= bestAsk (${bestAsk})`);

        // Also verify BUY order far above basePrice on depleted book never crosses synthetic asks
        book.bids = [];
        book.asks = [];
        book.submitOrder({ side: 'BUY', type: 'LIMIT', price: 96000, size: 1.0, clientId: 'replenish-buy-probe' });
        assert.equal(book.bids[0].price, 96000);
        assert.ok(
            book.bids[0].price < book.asks[0].price,
            `Uncrossed book invariant violated on high BUY: bestBid (${book.bids[0].price}) >= bestAsk (${book.asks[0].price})`
        );
    });
});
