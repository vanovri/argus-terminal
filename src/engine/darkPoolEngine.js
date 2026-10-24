'use strict';

/**
 * ARGUS TERMINAL — Wave 4: Institutional Dark Pool Crossing Network (ARGUS-DARK-ATS)
 *
 * Implements:
 *   1. Midpoint Peg (MIDPOINT_PEG), Session VWAP Peg (VWAP_PEG), and Hidden Limit (LIMIT_DARK) Orders:
 *      - Executes anonymously at the Lit NBBO Midpoint P_mid = (BestBid + BestAsk) / 2,
 *        eliminating bid-ask spread crossing costs and hiding pre-trade size from the Lit L2 book.
 *   2. Institutional Anti-Gaming & Block Size Enforcement:
 *      - Minimum Acceptable Quantity (MAQ / `minQty`) blocks predatory small-order "pinging"
 *        by requiring `matchSize >= Math.max(incoming.minQty, resting.minQty)`.
 *      - VPIN Flow Toxicity & Crumbling-Quote Shield (`maxToxicityVpin`, `maxSpreadBps`)
 *        automatically pauses dark peg crossing when Lit order flow is toxic or dislocated.
 *   3. Exact Price Improvement & Lit Sweep Avoidance Telemetry:
 *      - Computes Price Improvement vs Lit NBBO Touch (USD & bps) and vs Lit L2 Sweep Impact.
 */

const crypto = require('node:crypto');
const { INITIAL_INSTRUMENTS, roundToTick } = require('../db/database');

let darkSeq = 5000;
function nextDarkId(prefix = 'DRK') {
  darkSeq += 1;
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${darkSeq}-${rand}`;
}

class DarkPoolEngine {
  constructor(matchingEngine = null, dbInstance = null, marketSim = null) {
    this.engine = matchingEngine;
    this.db = dbInstance;
    this.marketSim = marketSim;

    // Map<symbol, { bids: Array, asks: Array }> — sorted by Size-Time / Price-Time priority
    this.darkBooks = new Map();
    this.darkTrades = [];
    this.metricsBySymbol = new Map();

    this._initDarkPool();
  }

  _initDarkPool() {
    const now = Date.now();
    for (const inst of INITIAL_INSTRUMENTS) {
      this.darkBooks.set(inst.symbol, { bids: [], asks: [] });
      this.metricsBySymbol.set(inst.symbol, {
        symbol: inst.symbol,
        totalDarkVolume: 0,
        totalDarkNotionalUsd: 0,
        totalPriceImprovementUsd: 0,
        totalCrossCount: 0,
        blockedPingAttempts: 0,
        toxicityShieldTriggers: 0
      });
    }

    // Seed resting institutional dark pool block interest & historical dark prints
    const seedRestingBlocks = [
      { symbol: 'BTC-USD', accountId: 'ACC-INST-02', side: 'BUY', pegType: 'MIDPOINT_PEG', size: 8.5, minQty: 0.5, limitPrice: null, maxToxicityVpin: 0.68, clientTag: 'BLACKROCK-BLOCK-BID' },
      { symbol: 'BTC-USD', accountId: 'ACC-INST-02', side: 'BUY', pegType: 'MIDPOINT_PEG', size: 12.0, minQty: 2.0, limitPrice: null, maxToxicityVpin: 0.65, clientTag: 'SOVEREIGN-SWF-BID' },
      { symbol: 'BTC-USD', accountId: 'ACC-INST-02', side: 'SELL', pegType: 'MIDPOINT_PEG', size: 6.0, minQty: 0.5, limitPrice: null, maxToxicityVpin: 0.68, clientTag: 'FIDELITY-DARK-ASK' },
      { symbol: 'BTC-USD', accountId: 'ACC-INST-02', side: 'SELL', pegType: 'LIMIT_DARK', size: 15.0, minQty: 3.0, limitPrice: 94480.0, maxToxicityVpin: 0.70, clientTag: 'MINER-TREASURY-ASK' },
      { symbol: 'ETH-USD', accountId: 'ACC-INST-02', side: 'BUY', pegType: 'MIDPOINT_PEG', size: 85.0, minQty: 5.0, limitPrice: null, maxToxicityVpin: 0.65, clientTag: 'ETH-WHALE-DARK-BID' },
      { symbol: 'ETH-USD', accountId: 'ACC-INST-02', side: 'SELL', pegType: 'MIDPOINT_PEG', size: 60.0, minQty: 5.0, limitPrice: null, maxToxicityVpin: 0.65, clientTag: 'ETH-INST-DARK-ASK' },
      { symbol: 'NVDA-EQ', accountId: 'ACC-INST-02', side: 'BUY', pegType: 'MIDPOINT_PEG', size: 5000, minQty: 200, limitPrice: null, maxToxicityVpin: 0.65, clientTag: 'PENSION-EQ-BLOCK' },
      { symbol: 'NVDA-EQ', accountId: 'ACC-INST-02', side: 'SELL', pegType: 'MIDPOINT_PEG', size: 4200, minQty: 200, limitPrice: null, maxToxicityVpin: 0.65, clientTag: 'LONG-ONLY-REBAL' }
    ];

    for (let i = 0; i < seedRestingBlocks.length; i++) {
      const s = seedRestingBlocks[i];
      const book = this._getOrCreateBook(s.symbol);
      const order = {
        id: `DRK-SEED-${100 + i}`,
        accountId: s.accountId,
        symbol: s.symbol,
        side: s.side,
        pegType: s.pegType,
        limitPrice: s.limitPrice,
        size: s.size,
        filledSize: 0,
        remainingSize: s.size,
        minQty: s.minQty,
        maxToxicityVpin: s.maxToxicityVpin,
        maxSpreadBps: 25.0,
        status: 'RESTING_DARK',
        clientTag: s.clientTag,
        createdAt: now - (30 - i) * 5000,
        _seq: i + 1
      };
      if (order.side === 'BUY') book.bids.push(order);
      else book.asks.push(order);
    }

    // Seed initial historical dark block prints so analytics are populated on startup
    const seedPrints = [
      { symbol: 'BTC-USD', side: 'BUY', size: 4.5, executionPrice: 94500.0, litBestBid: 94499.0, litBestAsk: 94501.0, litSweepPrice: 94518.5, pegType: 'MIDPOINT_PEG', tsOffsetMs: 95000 },
      { symbol: 'BTC-USD', side: 'SELL', size: 6.2, executionPrice: 94498.5, litBestBid: 94497.5, litBestAsk: 94499.5, litSweepPrice: 94476.0, pegType: 'MIDPOINT_PEG', tsOffsetMs: 55000 },
      { symbol: 'ETH-USD', side: 'BUY', size: 45.0, executionPrice: 3180.0, litBestBid: 3179.8, litBestAsk: 3180.2, litSweepPrice: 3181.4, pegType: 'VWAP_PEG', tsOffsetMs: 35000 },
      { symbol: 'NVDA-EQ', side: 'BUY', size: 2500, executionPrice: 148.20, litBestBid: 148.18, litBestAsk: 148.22, litSweepPrice: 148.36, pegType: 'MIDPOINT_PEG', tsOffsetMs: 18000 }
    ];

    for (let i = 0; i < seedPrints.length; i++) {
      const p = seedPrints[i];
      const touchDiff = p.side === 'BUY'
        ? Math.max(0.01, p.litBestAsk - p.executionPrice)
        : Math.max(0.01, p.executionPrice - p.litBestBid);
      const sweepDiff = Math.abs(p.litSweepPrice - p.executionPrice);
      const improvementUsd = Number((sweepDiff * p.size).toFixed(2));
      const improvementBps = Number(((sweepDiff / p.executionPrice) * 10000).toFixed(2));

      const print = {
        id: `DTRD-SEED-${200 + i}`,
        venue: 'ARGUS-DARK-ATS',
        symbol: p.symbol,
        side: p.side,
        pegType: p.pegType,
        size: p.size,
        price: p.executionPrice,
        executionPrice: p.executionPrice,
        litMidpoint: p.executionPrice,
        litBestBid: p.litBestBid,
        litBestAsk: p.litBestAsk,
        litSweepPrice: p.litSweepPrice,
        touchImprovementPerUnit: Number(touchDiff.toFixed(4)),
        priceImprovementBps: improvementBps,
        priceImprovementUsd: improvementUsd,
        makerOrderId: `DRK-MAKER-${i}`,
        takerOrderId: `DRK-TAKER-${i}`,
        timestamp: now - p.tsOffsetMs
      };
      this.darkTrades.unshift(print);

      const m = this.metricsBySymbol.get(p.symbol);
      if (m) {
        m.totalDarkVolume = Number((m.totalDarkVolume + p.size).toFixed(4));
        m.totalDarkNotionalUsd = Number((m.totalDarkNotionalUsd + p.size * p.executionPrice).toFixed(2));
        m.totalPriceImprovementUsd = Number((m.totalPriceImprovementUsd + improvementUsd).toFixed(2));
        m.totalCrossCount += 1;
      }
    }
  }

  _getOrCreateBook(symbol) {
    const cleanSym = String(symbol || 'BTC-USD').toUpperCase();
    if (!this.darkBooks.has(cleanSym)) {
      this.darkBooks.set(cleanSym, { bids: [], asks: [] });
      this.metricsBySymbol.set(cleanSym, {
        symbol: cleanSym,
        totalDarkVolume: 0,
        totalDarkNotionalUsd: 0,
        totalPriceImprovementUsd: 0,
        totalCrossCount: 0,
        blockedPingAttempts: 0,
        toxicityShieldTriggers: 0
      });
    }
    return this.darkBooks.get(cleanSym);
  }

  /**
   * Resolves current Lit NBBO Bid, Ask, Midpoint, Spread, Session VWAP, and estimated Lit L2 Sweep Price.
   */
  getLitMarketReference(symbol = 'BTC-USD', orderSide = 'BUY', orderSize = 1.0, overrides = {}) {
    const cleanSym = String(symbol || 'BTC-USD').toUpperCase();
    const inst = INITIAL_INSTRUMENTS.find((i) => i.symbol === cleanSym) || INITIAL_INSTRUMENTS[0];
    const tickSize = inst.tick_size || 0.5;

    let bestBid = overrides.litBestBid !== undefined ? Number(overrides.litBestBid) : null;
    let bestAsk = overrides.litBestAsk !== undefined ? Number(overrides.litBestAsk) : null;
    let vwap = overrides.vwap !== undefined ? Number(overrides.vwap) : null;
    let litBids = [];
    let litAsks = [];

    if (this.engine && typeof this.engine.getSnapshot === 'function') {
      const snap = this.engine.getSnapshot(cleanSym, 15);
      if (snap) {
        litBids = Array.isArray(snap.bids) ? snap.bids : [];
        litAsks = Array.isArray(snap.asks) ? snap.asks : [];
        if (bestBid === null && litBids.length > 0) bestBid = Number(litBids[0].price);
        if (bestAsk === null && litAsks.length > 0) bestAsk = Number(litAsks[0].price);
      }
    }

    if (this.marketSim && typeof this.marketSim.getTickers === 'function') {
      const tickers = this.marketSim.getTickers();
      const t = Array.isArray(tickers) ? tickers.find((x) => x.symbol === cleanSym) : null;
      if (t) {
        if (bestBid === null) bestBid = Number(t.bid || t.lastPrice - tickSize);
        if (bestAsk === null) bestAsk = Number(t.ask || t.lastPrice + tickSize);
        if (vwap === null) vwap = Number(t.vwap || t.lastPrice);
      }
    }

    if (bestBid === null) bestBid = inst.base_price - tickSize;
    if (bestAsk === null) bestAsk = inst.base_price + tickSize;
    if (bestAsk <= bestBid) bestAsk = bestBid + tickSize;

    const midpoint = Number(((bestBid + bestAsk) / 2).toFixed(4));
    const spread = Number((bestAsk - bestBid).toFixed(4));
    const spreadBps = midpoint > 0 ? Number(((spread / midpoint) * 10000).toFixed(2)) : 0;
    if (vwap === null) vwap = midpoint;

    // Estimate what sweeping `orderSize` across the Lit L2 orderbook would cost
    const ladder = orderSide === 'BUY' ? litAsks : litBids;
    let rem = Math.max(0.0001, Number(orderSize) || 1.0);
    let costNotional = 0;

    for (const lvl of ladder) {
      if (rem <= 1e-9) break;
      const take = Math.min(rem, Number(lvl.size || 0));
      costNotional += take * Number(lvl.price);
      rem -= take;
    }

    if (rem > 1e-9) {
      const worstPx = ladder.length > 0
        ? Number(ladder[ladder.length - 1].price)
        : (orderSide === 'BUY' ? bestAsk : bestBid);
      const dir = orderSide === 'BUY' ? 1 : -1;
      const impactExtra = worstPx * (1 + dir * 0.0004 * Math.sqrt(rem));
      costNotional += rem * impactExtra;
    }

    const rawSweepPrice = costNotional / Math.max(0.0001, Number(orderSize) || 1.0);
    // Ensure Lit sweep price is at least as expensive as the Lit touch (bestAsk for BUY, bestBid for SELL)
    const litSweepPrice = orderSide === 'BUY'
      ? Math.max(bestAsk, Number(rawSweepPrice.toFixed(4)))
      : Math.min(bestBid, Number(rawSweepPrice.toFixed(4)));

    const currentVpin = overrides.vpin !== undefined
      ? Number(overrides.vpin)
      : 0.28; // Normal baseline toxicity unless spiked

    return {
      symbol: cleanSym,
      bestBid,
      bestAsk,
      midpoint,
      vwap,
      spread,
      spreadBps,
      litSweepPrice,
      currentVpin
    };
  }

  /**
   * Checks whether an order satisfies its limit price constraint at the candidate crossing price.
   */
  _isPriceAcceptable(order, candidatePrice) {
    if (order.limitPrice === null || order.limitPrice === undefined) return true;
    const lim = Number(order.limitPrice);
    if (!Number.isFinite(lim) || lim <= 0) return true;
    return order.side === 'BUY' ? candidatePrice <= lim + 1e-9 : candidatePrice >= lim - 1e-9;
  }

  /**
   * Submits an institutional order into the Dark Pool Crossing Network (`ARGUS-DARK-ATS`).
   * Enforces:
   *   - VPIN Toxicity Shield (`currentVpin <= maxToxicityVpin`)
   *   - Minimum Execution Quantity (`minQty` / MAQ) on both sides
   *   - Midpoint / VWAP Peg crossing price with zero bid-ask spread leakage
   */
  submitDarkOrder(params = {}) {
    const symbol = String(params.symbol || 'BTC-USD').toUpperCase();
    const side = String(params.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const pegType = String(params.pegType || params.type || 'MIDPOINT_PEG').toUpperCase();
    const size = Number(params.size ?? params.totalSize ?? 1.0);
    const minQty = Math.max(0, Number(params.minQty ?? params.minimumQty ?? 0));
    const limitPrice = params.limitPrice !== undefined && params.limitPrice !== null && params.limitPrice !== ''
      ? Number(params.limitPrice)
      : null;
    const maxToxicityVpin = Number(params.maxToxicityVpin ?? 0.65);
    const maxSpreadBps = Number(params.maxSpreadBps ?? 30.0);
    const accountId = params.accountId || 'ACC-INST-01';
    const clientTag = params.clientTag || 'DARK-BLOCK-DMA';

    if (!Number.isFinite(size) || size <= 0) {
      throw new Error('Dark Pool order size must be a positive number');
    }
    if (minQty > size) {
      throw new Error(`Minimum execution quantity (minQty=${minQty}) cannot exceed order size (${size})`);
    }

    const book = this._getOrCreateBook(symbol);
    const symMetrics = this.metricsBySymbol.get(symbol);
    const litRef = this.getLitMarketReference(symbol, side, size, {
      litBestBid: params.litBestBid,
      litBestAsk: params.litBestAsk,
      vwap: params.vwap,
      vpin: params.vpin ?? params.currentVpin
    });

    const incoming = {
      id: params.id || nextDarkId('DRK'),
      accountId,
      symbol,
      side,
      pegType,
      limitPrice,
      size,
      filledSize: 0,
      remainingSize: size,
      minQty,
      maxToxicityVpin,
      maxSpreadBps,
      status: 'RESTING_DARK',
      clientTag,
      createdAt: Date.now(),
      _seq: ++darkSeq
    };

    // 1. Check Anti-Gaming VPIN Toxicity Shield & Max Lit Spread Lockout
    if (litRef.currentVpin > maxToxicityVpin || litRef.spreadBps > maxSpreadBps) {
      symMetrics.toxicityShieldTriggers += 1;
      incoming.status = 'SHIELD_PAUSED';
      incoming.shieldReason = litRef.currentVpin > maxToxicityVpin
        ? `VPIN Flow Toxicity (${litRef.currentVpin.toFixed(3)}) exceeds order threshold (${maxToxicityVpin.toFixed(3)})`
        : `Lit NBBO Spread (${litRef.spreadBps.toFixed(2)} bps) exceeds maxSpreadBps (${maxSpreadBps.toFixed(2)} bps)`;

      if (side === 'BUY') book.bids.push(incoming);
      else book.asks.push(incoming);

      return {
        order: incoming,
        fills: [],
        shieldTriggered: true,
        shieldReason: incoming.shieldReason,
        litReference: litRef
      };
    }

    // 2. Determine Crossing Reference Price (Midpoint or Session VWAP)
    const crossingPrice = pegType === 'VWAP_PEG' ? litRef.vwap : litRef.midpoint;

    // 3. Match against opposite Dark Book sorted by Size-Time priority (largest blocks first, then FIFO)
    const oppositeBook = side === 'BUY' ? book.asks : book.bids;
    oppositeBook.sort((a, b) => {
      if (Math.abs(b.remainingSize - a.remainingSize) > 1e-6) {
        return b.remainingSize - a.remainingSize;
      }
      return a._seq - b._seq;
    });

    const fills = [];
    let blockedByMinQtyCount = 0;

    let idx = 0;
    while (idx < oppositeBook.length && incoming.remainingSize > 1e-9) {
      const resting = oppositeBook[idx];

      // Check VPIN shield on resting order as well
      if (litRef.currentVpin > (resting.maxToxicityVpin ?? 0.65)) {
        idx += 1;
        continue;
      }

      // Check limit price compatibility with Midpoint / Crossing Price
      if (!this._isPriceAcceptable(incoming, crossingPrice) || !this._isPriceAcceptable(resting, crossingPrice)) {
        idx += 1;
        continue;
      }

      const candidateMatchSize = Number(Math.min(incoming.remainingSize, resting.remainingSize).toFixed(6));
      const requiredMinQty = Math.max(incoming.minQty || 0, resting.minQty || 0);

      // Enforce Minimum Acceptable Quantity (MAQ / Anti-Pinging Protection)
      if (candidateMatchSize + 1e-9 < requiredMinQty) {
        blockedByMinQtyCount += 1;
        symMetrics.blockedPingAttempts += 1;
        idx += 1;
        continue;
      }

      incoming.remainingSize = Number((incoming.remainingSize - candidateMatchSize).toFixed(6));
      incoming.filledSize = Number((incoming.filledSize + candidateMatchSize).toFixed(6));

      resting.remainingSize = Number((resting.remainingSize - candidateMatchSize).toFixed(6));
      resting.filledSize = Number((resting.filledSize + candidateMatchSize).toFixed(6));
      resting.status = resting.remainingSize <= 1e-9 ? 'FILLED_DARK' : 'PARTIAL_DARK';

      const touchSavingsPerUnit = side === 'BUY'
        ? Math.max(0, litRef.bestAsk - crossingPrice)
        : Math.max(0, crossingPrice - litRef.bestBid);

      const sweepSavingsPerUnit = side === 'BUY'
        ? Math.max(touchSavingsPerUnit, litRef.litSweepPrice - crossingPrice)
        : Math.max(touchSavingsPerUnit, crossingPrice - litRef.litSweepPrice);

      const priceImprovementUsd = Number((sweepSavingsPerUnit * candidateMatchSize).toFixed(2));
      const priceImprovementBps = crossingPrice > 0
        ? Number(((sweepSavingsPerUnit / crossingPrice) * 10000).toFixed(2))
        : 0;

      const darkPrint = {
        id: nextDarkId('DTRD'),
        venue: 'ARGUS-DARK-ATS',
        symbol,
        side,
        pegType,
        price: crossingPrice,
        executionPrice: crossingPrice,
        size: candidateMatchSize,
        litMidpoint: litRef.midpoint,
        litBestBid: litRef.bestBid,
        litBestAsk: litRef.bestAsk,
        litSweepPrice: litRef.litSweepPrice,
        touchImprovementPerUnit: Number(touchSavingsPerUnit.toFixed(4)),
        priceImprovementPerUnit: Number(sweepSavingsPerUnit.toFixed(4)),
        priceImprovementBps,
        priceImprovementUsd,
        makerOrderId: resting.id,
        takerOrderId: incoming.id,
        makerAccountId: resting.accountId,
        takerAccountId: incoming.accountId,
        timestamp: Date.now()
      };

      fills.push(darkPrint);
      this.darkTrades.unshift(darkPrint);
      if (this.darkTrades.length > 100) this.darkTrades.pop();

      symMetrics.totalDarkVolume = Number((symMetrics.totalDarkVolume + candidateMatchSize).toFixed(4));
      symMetrics.totalDarkNotionalUsd = Number((symMetrics.totalDarkNotionalUsd + candidateMatchSize * crossingPrice).toFixed(2));
      symMetrics.totalPriceImprovementUsd = Number((symMetrics.totalPriceImprovementUsd + priceImprovementUsd).toFixed(2));
      symMetrics.totalCrossCount += 1;

      if (resting.remainingSize <= 1e-9) {
        oppositeBook.splice(idx, 1);
      } else {
        idx += 1;
      }
    }

    if (incoming.remainingSize <= 1e-9) {
      incoming.status = 'FILLED_DARK';
      incoming.remainingSize = 0;
    } else if (incoming.filledSize > 1e-9) {
      incoming.status = 'PARTIAL_DARK';
      if (side === 'BUY') book.bids.push(incoming);
      else book.asks.push(incoming);
    } else {
      incoming.status = 'RESTING_DARK';
      if (side === 'BUY') book.bids.push(incoming);
      else book.asks.push(incoming);
    }

    // Persist dark crosses to SQLite trades & audit_logs if database is connected
    if (this.db && fills.length > 0) {
      try {
        const insertTrade = this.db.prepare(`
          INSERT INTO trades (id, symbol, price, size, side, maker_order_id, taker_order_id, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertAudit = this.db.prepare(`
          INSERT INTO audit_logs (event_type, payload, created_at)
          VALUES (?, ?, ?)
        `);
        for (const f of fills) {
          insertTrade.run(f.id, f.symbol, f.executionPrice, f.size, f.side, f.makerOrderId, f.takerOrderId, f.timestamp);
          insertAudit.run('DARK_POOL_CROSS', JSON.stringify({
            tradeId: f.id,
            venue: 'ARGUS-DARK-ATS',
            symbol: f.symbol,
            size: f.size,
            midpointPrice: f.executionPrice,
            priceImprovementUsd: f.priceImprovementUsd,
            priceImprovementBps: f.priceImprovementBps
          }), f.timestamp);
        }
      } catch (_) {
        // Non-fatal if running standalone without SQLite schema
      }
    }

    // Replenish synthetic institutional dark liquidity if side becomes depleted
    this._replenishDarkLiquidity(symbol, litRef.midpoint);

    const totalFilledSize = fills.reduce((acc, f) => acc + f.size, 0);
    const totalImprovementUsd = fills.reduce((acc, f) => acc + f.priceImprovementUsd, 0);

    return {
      order: incoming,
      fills,
      crossedVolume: Number(totalFilledSize.toFixed(6)),
      executionPrice: crossingPrice,
      totalPriceImprovementUsd: Number(totalImprovementUsd.toFixed(2)),
      blockedByMinQtyCount,
      shieldTriggered: false,
      litReference: litRef
    };
  }

  _replenishDarkLiquidity(symbol, midpointPrice) {
    const book = this._getOrCreateBook(symbol);
    const inst = INITIAL_INSTRUMENTS.find((i) => i.symbol === symbol) || INITIAL_INSTRUMENTS[0];
    const baseLot = inst.lot_size || 0.01;
    const now = Date.now();

    if (book.bids.length < 2) {
      book.bids.push({
        id: nextDarkId('DRK-MM-BID'),
        accountId: 'ACC-INST-02',
        symbol,
        side: 'BUY',
        pegType: 'MIDPOINT_PEG',
        limitPrice: roundToTick(midpointPrice * 1.005, inst.tick_size),
        size: Number((baseLot * 600).toFixed(4)),
        filledSize: 0,
        remainingSize: Number((baseLot * 600).toFixed(4)),
        minQty: Number((baseLot * 50).toFixed(4)),
        maxToxicityVpin: 0.68,
        maxSpreadBps: 25.0,
        status: 'RESTING_DARK',
        clientTag: 'INST-DARK-REPLENISH-BID',
        createdAt: now,
        _seq: ++darkSeq
      });
    }

    if (book.asks.length < 2) {
      book.asks.push({
        id: nextDarkId('DRK-MM-ASK'),
        accountId: 'ACC-INST-02',
        symbol,
        side: 'SELL',
        pegType: 'MIDPOINT_PEG',
        limitPrice: roundToTick(midpointPrice * 0.995, inst.tick_size),
        size: Number((baseLot * 600).toFixed(4)),
        filledSize: 0,
        remainingSize: Number((baseLot * 600).toFixed(4)),
        minQty: Number((baseLot * 50).toFixed(4)),
        maxToxicityVpin: 0.68,
        maxSpreadBps: 25.0,
        status: 'RESTING_DARK',
        clientTag: 'INST-DARK-REPLENISH-ASK',
        createdAt: now,
        _seq: ++darkSeq
      });
    }
  }

  /**
   * Returns anonymized institutional Dark Pool status, resting block depth aggregates,
   * anti-gaming shield metrics, and recent midpoint prints for `symbol`.
   */
  getStatus(symbol = 'BTC-USD') {
    const cleanSym = String(symbol || 'BTC-USD').toUpperCase();
    const book = this._getOrCreateBook(cleanSym);
    const symMetrics = this.metricsBySymbol.get(cleanSym);
    const litRef = this.getLitMarketReference(cleanSym, 'BUY', 5.0);

    const hiddenBidVolume = book.bids.reduce((acc, b) => acc + b.remainingSize, 0);
    const hiddenAskVolume = book.asks.reduce((acc, a) => acc + a.remainingSize, 0);

    // Anonymized order descriptors (Dark Pools do not expose exact individual prices, only tier buckets)
    const restingOrders = [...book.bids, ...book.asks].map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      pegType: o.pegType,
      remainingSize: o.remainingSize,
      minQty: o.minQty,
      maxToxicityVpin: o.maxToxicityVpin,
      status: o.status,
      clientTag: o.clientTag,
      createdAt: o.createdAt
    }));

    const symbolPrints = this.darkTrades.filter((t) => t.symbol === cleanSym).slice(0, 25);

    return {
      venue: 'ARGUS-DARK-ATS',
      symbol: cleanSym,
      litReference: litRef,
      darkBookSummary: {
        restingBidOrdersCount: book.bids.length,
        restingAskOrdersCount: book.asks.length,
        hiddenBidVolume: Number(hiddenBidVolume.toFixed(4)),
        hiddenAskVolume: Number(hiddenAskVolume.toFixed(4)),
        totalHiddenLiquidity: Number((hiddenBidVolume + hiddenAskVolume).toFixed(4)),
        indicativeMidpointPrice: litRef.midpoint,
        indicativeVwapPrice: litRef.vwap
      },
      metrics: {
        ...symMetrics,
        darkShareOfVolumePct: 18.4,
        avgPriceImprovementBps: symbolPrints.length > 0
          ? Number((symbolPrints.reduce((a, p) => a + p.priceImprovementBps, 0) / symbolPrints.length).toFixed(2))
          : 4.25
      },
      restingOrders,
      recentPrints: symbolPrints,
      timestamp: Date.now()
    };
  }
}

module.exports = {
  DarkPoolEngine
};
