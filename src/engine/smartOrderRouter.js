'use strict';

/**
 * ARGUS TERMINAL — Multi-Venue Smart Order Router (SOR) & Cross-Exchange Arbitrage Engine
 *
 * Simulates 4 institutional execution venues across all 6 instruments:
 *   1. `ARGUS-LIT`    — Primary Internal L2 Book      (Maker/Taker -0.5 / +1.5 bps, latency 0.3 ms)
 *   2. `CME-GLOBEX`   — Institutional Futures Book    (Maker/Taker +0.8 / +1.2 bps, latency 1.4 ms)
 *   3. `BINANCE-INST` — Deep Offshore Spot Liquidity  (Maker/Taker  0.0 / +2.0 bps, latency 4.2 ms)
 *   4. `LMAX-LD4`     — London Equinix LD4 ECN        (Maker/Taker +0.5 / +1.0 bps, latency 2.1 ms)
 *
 * Implements:
 *   - `routeOrder({ symbol, side, totalSize, urgency = 'NORMAL' })`
 *   - `scanArbitrage(tickers)`
 */

const { INITIAL_INSTRUMENTS, roundToTick } = require('../db/database');

const INSTITUTIONAL_VENUES = [
  {
    id: 'ARGUS-LIT',
    venue: 'ARGUS-LIT',
    name: 'Argus Primary Internal L2 Book',
    location: 'NY4-EQUINIX',
    makerFeeBps: -0.5,
    takerFeeBps: 1.5,
    latencyMs: 0.3,
    kyleLambdaBaseBps: 1.8,
    depthWeight: 0.28
  },
  {
    id: 'CME-GLOBEX',
    venue: 'CME-GLOBEX',
    name: 'CME Globex Institutional Futures Book',
    location: 'AURORA-DC3',
    makerFeeBps: 0.8,
    takerFeeBps: 1.2,
    latencyMs: 1.4,
    kyleLambdaBaseBps: 1.5,
    depthWeight: 0.26
  },
  {
    id: 'BINANCE-INST',
    venue: 'BINANCE-INST',
    name: 'Binance Institutional Offshore Spot VIP',
    location: 'AWS-AP-NE1',
    makerFeeBps: 0.0,
    takerFeeBps: 2.0,
    latencyMs: 4.2,
    kyleLambdaBaseBps: 1.1,
    depthWeight: 0.24
  },
  {
    id: 'LMAX-LD4',
    venue: 'LMAX-LD4',
    name: 'LMAX Digital London Equinix LD4 ECN',
    location: 'LD4-SLOUGH',
    makerFeeBps: 0.5,
    takerFeeBps: 1.0,
    latencyMs: 2.1,
    kyleLambdaBaseBps: 1.6,
    depthWeight: 0.22
  }
];

const VENUE_MAP = new Map(INSTITUTIONAL_VENUES.map((v) => [v.id, v]));

const URGENCY_LATENCY_MULTIPLIERS = {
  LOW: 0.08,
  PASSIVE: 0.08,
  NORMAL: 0.16,
  MEDIUM: 0.16,
  HIGH: 0.32,
  AGGRESSIVE: 0.35,
  IMMEDIATE: 0.40
};

const INSTRUMENT_MAP = new Map(
  INITIAL_INSTRUMENTS.map((inst) => [
    inst.symbol,
    {
      symbol: inst.symbol,
      name: inst.name,
      assetClass: inst.asset_class,
      basePrice: Number(inst.base_price),
      tickSize: Number(inst.tick_size),
      lotSize: Number(inst.lot_size)
    }
  ])
);

function getInstrumentSpec(symbol) {
  const clean = String(symbol || 'BTC-USD').toUpperCase();
  return (
    INSTRUMENT_MAP.get(clean) || {
      symbol: clean,
      name: clean,
      assetClass: 'CRYPTO',
      basePrice: 94500.0,
      tickSize: 0.5,
      lotSize: 0.01
    }
  );
}

class SmartOrderRouter {
  /**
   * @param {object} [matchingEngine]
   * @param {object} [marketSim]
   */
  constructor(matchingEngine = null, marketSim = null) {
    this.matchingEngine = matchingEngine;
    this.marketSim = marketSim;
    this.venues = INSTITUTIONAL_VENUES;
    this._scanSeq = 100;
  }

  getVenues() {
    return this.venues.map((v) => ({ ...v }));
  }

  /**
   * Resolve reference mid-price for a symbol from live matchingEngine, marketSim, or seeded instrument table.
   * @param {string} symbol
   * @param {Array|object} [tickers]
   * @returns {number}
   */
  _resolveMidPrice(symbol, tickers = null) {
    const spec = getInstrumentSpec(symbol);
    if (Array.isArray(tickers)) {
      const found = tickers.find((t) => t && t.symbol === symbol);
      if (found && Number(found.lastPrice) > 0) {
        return Number(found.lastPrice);
      }
    } else if (tickers && typeof tickers === 'object' && tickers[symbol]) {
      const t = tickers[symbol];
      if (typeof t === 'number' && t > 0) return t;
      if (t && Number(t.lastPrice) > 0) return Number(t.lastPrice);
    }

    if (this.matchingEngine && typeof this.matchingEngine.getSnapshot === 'function') {
      try {
        const snap = this.matchingEngine.getSnapshot(symbol, 1);
        if (snap && Number(snap.midPrice) > 0) {
          return Number(snap.midPrice);
        }
      } catch (_) {
        // fallback to spec.basePrice
      }
    }

    return spec.basePrice;
  }

  /**
   * Build the 4-venue institutional L2 orderbook ladder for a given symbol and target order size.
   * Each level carries raw quote price, takerFeeBps, latencySlippageBps, Kyle's lambda impact bps,
   * and effective net price.
   *
   * @param {object} params
   * @returns {object}
   */
  buildMultiVenueLadder({ symbol = 'BTC-USD', side = 'BUY', totalSize = 1.0, urgency = 'NORMAL', midPrice = null }) {
    const spec = getInstrumentSpec(symbol);
    const refMid = Number(midPrice) > 0 ? Number(midPrice) : this._resolveMidPrice(spec.symbol);
    const normSide = String(side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const normUrgency = String(urgency || 'NORMAL').toUpperCase();
    const latencyMult = URGENCY_LATENCY_MULTIPLIERS[normUrgency] ?? 0.16;

    // Venue micro-basis offsets (in bps) relative to reference mid-price
    // Reflects natural inter-exchange microstructure dispersion
    const venueQuoteOffsetsBps = {
      'ARGUS-LIT': { bidOffsetBps: -0.6, askOffsetBps: 0.6 },
      'CME-GLOBEX': { bidOffsetBps: -0.3, askOffsetBps: 0.8 },
      'BINANCE-INST': { bidOffsetBps: -0.8, askOffsetBps: 0.4 },
      'LMAX-LD4': { bidOffsetBps: -0.4, askOffsetBps: 0.9 }
    };

    const combinedLevels = [];
    const venueBooks = {};
    const levelsPerVenue = 8;

    for (const v of this.venues) {
      const offsets = venueQuoteOffsetsBps[v.id] || { bidOffsetBps: -0.5, askOffsetBps: 0.5 };
      const latencySlippageBps = Number((v.latencyMs * latencyMult).toFixed(4));
      const levels = [];

      // Distribute liquidity across 8 levels per venue so total venue depth is ~1.6x totalSize
      // while top levels interleave across the 4 venues to minimize Kyle's lambda impact
      const levelCapacityShares = [0.09, 0.11, 0.14, 0.18, 0.22, 0.26, 0.30, 0.35];

      for (let lvl = 0; lvl < levelsPerVenue; lvl++) {
        const stepBps = lvl * (1.15 + v.kyleLambdaBaseBps * 0.35);
        let rawPrice;
        if (normSide === 'BUY') {
          const askBps = offsets.askOffsetBps + stepBps * 0.45;
          rawPrice = Number((refMid * (1 + askBps / 10000)).toFixed(6));
        } else {
          const bidBps = offsets.bidOffsetBps - stepBps * 0.45;
          rawPrice = Number((refMid * (1 + bidBps / 10000)).toFixed(6));
        }

        // Kyle's lambda marginal market impact increases with deeper book levels on the same venue
        const kyleImpactBps = Number((v.kyleLambdaBaseBps * (0.25 + lvl * 0.55)).toFixed(4));
        const totalCostBps = v.takerFeeBps + latencySlippageBps + kyleImpactBps;

        const effectivePrice =
          normSide === 'BUY'
            ? Number((rawPrice * (1 + totalCostBps / 10000)).toFixed(6))
            : Number((rawPrice * (1 - totalCostBps / 10000)).toFixed(6));

        const levelSize = Math.max(
          spec.lotSize * 0.01,
          Number((totalSize * levelCapacityShares[lvl] * (v.depthWeight / 0.25)).toFixed(6))
        );

        const entry = {
          venue: v.id,
          venueName: v.name,
          level: lvl + 1,
          rawPrice,
          effectivePrice,
          availableSize: levelSize,
          feeBps: v.takerFeeBps,
          makerFeeBps: v.makerFeeBps,
          latencyMs: v.latencyMs,
          latencySlippageBps,
          kyleImpactBps,
          totalCostBps: Number(totalCostBps.toFixed(4))
        };

        levels.push(entry);
        combinedLevels.push(entry);
      }

      venueBooks[v.id] = levels;
    }

    // Sort combined multi-venue L2 ladder by best effective net price:
    // For BUY: lowest effectivePrice first; for SELL: highest effectivePrice first
    combinedLevels.sort((a, b) =>
      normSide === 'BUY'
        ? a.effectivePrice - b.effectivePrice
        : b.effectivePrice - a.effectivePrice
    );

    return {
      symbol: spec.symbol,
      side: normSide,
      midPrice: refMid,
      tickSize: spec.tickSize,
      lotSize: spec.lotSize,
      venueBooks,
      combinedLevels
    };
  }

  /**
   * Sweep the combined multi-venue L2 liquidity ladder across all 4 venues sorted by
   * effective net price after taker fee, latency slippage, and Kyle's lambda market impact.
   *
   * @param {object} params
   * @param {string} params.symbol
   * @param {string} params.side - 'BUY' | 'SELL'
   * @param {number} params.totalSize
   * @param {string} [params.urgency='NORMAL']
   * @returns {object}
   */
  routeOrder(params = {}) {
    const symbol = String(params.symbol || 'BTC-USD').toUpperCase();
    const side = String(params.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const rawSize = Number(params.totalSize ?? params.size ?? params.orderQty ?? params.qty ?? 1.0);
    const totalSize = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 1.0;
    const urgency = String(params.urgency || 'NORMAL').toUpperCase();

    const ladder = this.buildMultiVenueLadder({
      symbol,
      side,
      totalSize,
      urgency,
      midPrice: params.midPrice
    });

    // Accumulate fills per venue across the sorted multi-venue ladder
    const venueStats = new Map();
    for (const v of this.venues) {
      venueStats.set(v.id, {
        venue: v.id,
        venueName: v.name,
        size: 0,
        rawNotional: 0,
        effectiveNotional: 0,
        feeBps: v.takerFeeBps,
        makerFeeBps: v.makerFeeBps,
        latencyMs: v.latencyMs,
        kyleImpactWeighted: 0
      });
    }

    let remaining = totalSize;
    for (const lvl of ladder.combinedLevels) {
      if (remaining <= 1e-9) break;
      const takeSize = Math.min(remaining, lvl.availableSize);
      const bucket = venueStats.get(lvl.venue);
      bucket.size += takeSize;
      bucket.rawNotional += takeSize * lvl.rawPrice;
      bucket.effectiveNotional += takeSize * lvl.effectivePrice;
      bucket.kyleImpactWeighted += takeSize * lvl.kyleImpactBps;
      remaining -= takeSize;
    }

    // If any residual remains, allocate to deepest venue (BINANCE-INST)
    if (remaining > 1e-9) {
      const fallbackVenue = venueStats.get('BINANCE-INST');
      const lastLvl = ladder.venueBooks['BINANCE-INST'][ladder.venueBooks['BINANCE-INST'].length - 1];
      fallbackVenue.size += remaining;
      fallbackVenue.rawNotional += remaining * lastLvl.rawPrice;
      fallbackVenue.effectiveNotional += remaining * lastLvl.effectivePrice;
      remaining = 0;
    }

    // Compute single-venue benchmark price (if 100% of totalSize were dumped onto a single venue
    // without cross-venue splitting, incurring full single-book depth sweep + quadratic Kyle's lambda)
    const singleVenueCostBps = 8.4 + Math.min(18.0, Math.log10(Math.max(1, totalSize)) * 4.2);

    let totalEffectiveNotional = 0;
    let totalRawNotional = 0;
    const rawAllocations = [];

    for (const v of this.venues) {
      const st = venueStats.get(v.id);
      if (st.size <= 1e-9) continue;
      totalEffectiveNotional += st.effectiveNotional;
      totalRawNotional += st.rawNotional;
      rawAllocations.push(st);
    }

    // Normalize sizes and percentages so they sum cleanly to totalSize and 100%
    let runningSize = 0;
    let runningPct = 0;
    const allocations = rawAllocations.map((st, idx) => {
      const isLast = idx === rawAllocations.length - 1;
      const roundedSize = isLast
        ? Number(Math.max(0, totalSize - runningSize).toFixed(6))
        : Number(st.size.toFixed(6));
      runningSize = Number((runningSize + roundedSize).toFixed(6));

      const rawPct = (roundedSize / totalSize) * 100;
      const pct = isLast
        ? Number(Math.max(0, 100 - runningPct).toFixed(2))
        : Number(rawPct.toFixed(2));
      runningPct = Number((runningPct + pct).toFixed(2));

      const avgPrice = Number((st.rawNotional / st.size).toFixed(4));
      const effectiveAvgPrice = Number((st.effectiveNotional / st.size).toFixed(4));
      const notionalUsd = Number((roundedSize * avgPrice).toFixed(2));

      return {
        venue: st.venue,
        venueName: st.venueName,
        size: roundedSize,
        pct,
        avgPrice,
        effectiveAvgPrice,
        feeBps: st.feeBps,
        makerFeeBps: st.makerFeeBps,
        latencyMs: st.latencyMs,
        kyleImpactBps: Number((st.kyleImpactWeighted / st.size).toFixed(2)),
        notionalUsd
      };
    });

    // Sort allocations by largest share first
    allocations.sort((a, b) => b.size - a.size);

    const vwapEffectivePrice = Number((totalEffectiveNotional / totalSize).toFixed(4));
    const vwapRawPrice = Number((totalRawNotional / totalSize).toFixed(4));

    const singleVenueBenchmarkPrice =
      side === 'BUY'
        ? Number((vwapEffectivePrice * (1 + singleVenueCostBps / 10000)).toFixed(4))
        : Number((vwapEffectivePrice * (1 - singleVenueCostBps / 10000)).toFixed(4));

    const priceDiff = Math.abs(singleVenueBenchmarkPrice - vwapEffectivePrice);
    const savingsBps = Number(((priceDiff / vwapEffectivePrice) * 10000).toFixed(2));
    const savingsUsd = Number((priceDiff * totalSize).toFixed(2));

    return {
      symbol,
      side,
      totalSize,
      urgency,
      midPrice: Number(ladder.midPrice.toFixed(4)),
      vwapRawPrice,
      vwapEffectivePrice,
      singleVenueBenchmarkPrice,
      savingsBps,
      savingsUsd,
      totalNotionalUsd: Number(allocations.reduce((s, a) => s + a.notionalUsd, 0).toFixed(2)),
      venuesUsed: allocations.length,
      allocations,
      timestamp: Date.now()
    };
  }

  /**
   * Scan all 4 institutional venues across all 6 symbols + triangular FX/Crypto legs
   * (`BTC-USD` / `ETH-USD` / `ETH-BTC` synthetic) to detect live:
   *   1. Cross-Exchange Spatial Arbitrage (`BestBid_VenueA > BestAsk_VenueB + Fees`)
   *   2. Triangular FX/Crypto Synthetic Arbitrage (`BTC-USD` / `ETH-USD` / `ETH-BTC`)
   *   3. Statistical Basis Arbitrage (`CME-GLOBEX` Futures vs Spot Venues)
   *
   * @param {Array|object} [tickers]
   * @returns {{ timestamp: number, opportunities: Array<object> }}
   */
  scanArbitrage(tickers = null) {
    const now = Date.now();
    this._scanSeq += 1;

    const btcMid = this._resolveMidPrice('BTC-USD', tickers);
    const ethMid = this._resolveMidPrice('ETH-USD', tickers);
    const solMid = this._resolveMidPrice('SOL-USD', tickers);
    const nvdaMid = this._resolveMidPrice('NVDA-EQ', tickers);
    const xauMid = this._resolveMidPrice('XAU-USD', tickers);
    const idrMid = this._resolveMidPrice('IDR-USD', tickers);

    // Helper to construct a verified arbitrage opportunity where sellBid > buyAsk + Fees
    const buildOpportunity = ({
      idSuffix,
      type,
      symbol,
      buyVenue,
      sellVenue,
      refPrice,
      grossSpreadBps,
      maxCapacitySize,
      confidence,
      description
    }) => {
      const buyV = VENUE_MAP.get(buyVenue) || INSTITUTIONAL_VENUES[0];
      const sellV = VENUE_MAP.get(sellVenue) || INSTITUTIONAL_VENUES[1];

      // Total round-trip execution fee in bps (floor at 0.5 bps minimum friction)
      const totalFeesBps = Math.max(0.5, Number((buyV.takerFeeBps + sellV.takerFeeBps).toFixed(2)));
      const ensuredGrossBps = Math.max(totalFeesBps + 1.8, Number(grossSpreadBps.toFixed(2)));
      const netEdgeBps = Number((ensuredGrossBps - totalFeesBps).toFixed(2));

      const halfSpreadRatio = (ensuredGrossBps / 10000) / 2;
      const buyAsk = Number((refPrice * (1 - halfSpreadRatio)).toFixed(4));
      const sellBid = Number((refPrice * (1 + halfSpreadRatio)).toFixed(4));
      const estProfitUsd = Number(((netEdgeBps / 10000) * buyAsk * maxCapacitySize).toFixed(2));

      return {
        id: `ARB-${this._scanSeq}-${idSuffix}`,
        type,
        symbol,
        buyVenue,
        sellVenue,
        buyAsk,
        sellBid,
        totalFeesBps,
        grossSpreadBps: ensuredGrossBps,
        netEdgeBps,
        maxCapacitySize,
        estProfitUsd,
        latencyWindowMs: Number(Math.max(buyV.latencyMs, sellV.latencyMs).toFixed(2)),
        confidence: Number(confidence.toFixed(2)),
        description,
        timestamp: now
      };
    };

    // Synthetic ETH-BTC cross rate implied by ETH-USD / BTC-USD
    const ethBtcImplied = Number((ethMid / Math.max(1, btcMid)).toFixed(6));

    const opportunities = [
      // 1. Cross-Exchange Spatial Arbitrage on BTC-USD (LMAX-LD4 vs BINANCE-INST)
      buildOpportunity({
        idSuffix: 'BTC-SPATIAL',
        type: 'SPATIAL_ARBITRAGE',
        symbol: 'BTC-USD',
        buyVenue: 'ARGUS-LIT',
        sellVenue: 'BINANCE-INST',
        refPrice: btcMid,
        grossSpreadBps: 7.8,
        maxCapacitySize: 3.5,
        confidence: 0.94,
        description: 'Cross-Exchange Spatial Arb: Lift ARGUS-LIT Ask (-0.5/1.5bps) & Hit BINANCE-INST Bid'
      }),

      // 2. Statistical Basis Arbitrage on BTC-USD (ARGUS-LIT Spot vs CME-GLOBEX Futures)
      buildOpportunity({
        idSuffix: 'BTC-BASIS',
        type: 'STATISTICAL_BASIS',
        symbol: 'BTC-USD',
        buyVenue: 'ARGUS-LIT',
        sellVenue: 'CME-GLOBEX',
        refPrice: btcMid,
        grossSpreadBps: 9.4,
        maxCapacitySize: 5.0,
        confidence: 0.96,
        description: 'CME Globex Annualized Cash-and-Carry Basis Dislocation vs Argus Lit Spot'
      }),

      // 3. Triangular FX/Crypto Arbitrage (BTC-USD / ETH-USD / ETH-BTC Synthetic)
      {
        ...buildOpportunity({
          idSuffix: 'ETH-BTC-TRI',
          type: 'TRIANGULAR_ARBITRAGE',
          symbol: 'ETH-BTC',
          buyVenue: 'LMAX-LD4',
          sellVenue: 'BINANCE-INST',
          refPrice: ethMid,
          grossSpreadBps: 8.6,
          maxCapacitySize: 42.0,
          confidence: 0.91,
          description: `Triangular Crypto Leg: Buy ETH-USD (LMAX-LD4) -> Cross ETH-BTC (${ethBtcImplied}) -> Sell BTC-USD (BINANCE-INST)`
        }),
        legs: ['ETH-USD', 'ETH-BTC', 'BTC-USD'],
        syntheticRatio: ethBtcImplied
      },

      // 4. Cross-Exchange Spatial Arbitrage on ETH-USD (LMAX-LD4 vs CME-GLOBEX)
      buildOpportunity({
        idSuffix: 'ETH-SPATIAL',
        type: 'SPATIAL_ARBITRAGE',
        symbol: 'ETH-USD',
        buyVenue: 'LMAX-LD4',
        sellVenue: 'CME-GLOBEX',
        refPrice: ethMid,
        grossSpreadBps: 6.5,
        maxCapacitySize: 28.0,
        confidence: 0.89,
        description: 'London LD4 ECN Ask Dislocation vs Aurora CME Globex Institutional Bid'
      }),

      // 5. Cross-Exchange Spatial Arbitrage on SOL-USD (ARGUS-LIT vs BINANCE-INST)
      buildOpportunity({
        idSuffix: 'SOL-SPATIAL',
        type: 'SPATIAL_ARBITRAGE',
        symbol: 'SOL-USD',
        buyVenue: 'ARGUS-LIT',
        sellVenue: 'BINANCE-INST',
        refPrice: solMid,
        grossSpreadBps: 10.2,
        maxCapacitySize: 450.0,
        confidence: 0.92,
        description: 'High-Beta L1 Offshore Spot Bid Skew vs Argus Internal L2 Ask'
      }),

      // 6. Statistical Basis Arbitrage on XAU-USD Bullion (LMAX-LD4 Spot vs CME-GLOBEX COMEX)
      buildOpportunity({
        idSuffix: 'XAU-BASIS',
        type: 'STATISTICAL_BASIS',
        symbol: 'XAU-USD',
        buyVenue: 'LMAX-LD4',
        sellVenue: 'CME-GLOBEX',
        refPrice: xauMid,
        grossSpreadBps: 5.9,
        maxCapacitySize: 60.0,
        confidence: 0.95,
        description: 'London Bullion Spot-to-COMEX EFP Basis Expansion'
      }),

      // 7. Cross-Exchange Spatial Arbitrage on NVDA-EQ (ARGUS-LIT vs LMAX-LD4)
      buildOpportunity({
        idSuffix: 'NVDA-SPATIAL',
        type: 'SPATIAL_ARBITRAGE',
        symbol: 'NVDA-EQ',
        buyVenue: 'ARGUS-LIT',
        sellVenue: 'LMAX-LD4',
        refPrice: nvdaMid,
        grossSpreadBps: 5.4,
        maxCapacitySize: 800.0,
        confidence: 0.87,
        description: 'Cross-Venue Equity Synthetic ECN Spread Capture'
      }),

      // 8. Triangular FX NDF Basis Arbitrage on IDR-USD (CME-GLOBEX vs LMAX-LD4)
      buildOpportunity({
        idSuffix: 'IDR-BASIS',
        type: 'STATISTICAL_BASIS',
        symbol: 'IDR-USD',
        buyVenue: 'LMAX-LD4',
        sellVenue: 'CME-GLOBEX',
        refPrice: idrMid,
        grossSpreadBps: 6.2,
        maxCapacitySize: 25.0,
        confidence: 0.88,
        description: 'Asian NDF 1M Forward Points vs London Interbank Spot FX'
      })
    ];

    opportunities.sort((a, b) => b.netEdgeBps - a.netEdgeBps);

    return {
      timestamp: now,
      venuesScanned: this.venues.map((v) => v.id),
      symbolsScanned: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'NVDA-EQ', 'XAU-USD', 'IDR-USD', 'ETH-BTC'],
      opportunities
    };
  }
}

const defaultSmartOrderRouter = new SmartOrderRouter();

module.exports = {
  SmartOrderRouter,
  defaultSmartOrderRouter,
  INSTITUTIONAL_VENUES,
  VENUES: INSTITUTIONAL_VENUES,
  routeOrder: (params) => defaultSmartOrderRouter.routeOrder(params),
  scanArbitrage: (tickers) => defaultSmartOrderRouter.scanArbitrage(tickers),
  getVenues: () => defaultSmartOrderRouter.getVenues()
};
