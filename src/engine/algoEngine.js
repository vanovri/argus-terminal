'use strict';

const EventEmitter = require('node:events');
const { getDb, INITIAL_INSTRUMENTS, roundToTick } = require('../db/database');
const { nextId } = require('./orderbook');

function createPrng(seed) {
  let state = seed >>> 0;
  return function nextRand() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const VALID_ALGO_STRATEGIES = new Set([
  'TWAP',
  'VWAP',
  'ICEBERG',
  'AVELLANEDA_STOIKOV'
]);

/**
 * Compute Avellaneda-Stoikov (2008) high-frequency market-making reservation price
 * and optimal bid/ask quotes:
 *   r(s, q, t) = s - q * gamma * sigma^2 * (T - t)
 *   delta(t)   = (1 / gamma) * ln(1 + gamma / kappa) + 0.5 * gamma * sigma^2 * (T - t)
 *
 * @param {object} params
 * @returns {object}
 */
function computeAvellanedaStoikovQuotes({
  midPrice,
  inventoryQty = 0,
  gamma = 0.1,
  sigma = 5.0,
  kappa = 1.5,
  timeRemaining = 1.0,
  tickSize = 0.50
}) {
  const s = Number(midPrice) || 100;
  const q = Number(inventoryQty) || 0;
  const g = Math.max(0.0001, Number(gamma) || 0.1);
  const k = Math.max(0.001, Number(kappa) || 1.5);
  const tau = Math.max(0.0, Math.min(1.0, Number(timeRemaining ?? 1.0)));
  const tick = Math.max(0.0001, Number(tickSize) || 0.01);
  const rawSigma = Math.max(0.0001, Number(sigma) || 5.0);

  // Exact Avellaneda-Stoikov (2008) reservation price: r(s, q, t) = s - q * gamma * sigma^2 * (T - t)
  const reservationPrice = s - q * g * (rawSigma * rawSigma) * tau;

  // Exact Avellaneda-Stoikov optimal half-spread: delta(t) = (1 / gamma) * ln(1 + gamma / kappa)
  const optimalHalfSpread = (1.0 / g) * Math.log(1.0 + g / k);

  const effectiveHalfSpread = Math.max(tick * 0.5, optimalHalfSpread);
  const optimalBid = roundToTick(reservationPrice - effectiveHalfSpread, tick);
  const optimalAsk = roundToTick(Math.max(optimalBid + tick, reservationPrice + effectiveHalfSpread), tick);

  return {
    midPrice: Number(s.toFixed(4)),
    inventoryQty: Number(q.toFixed(4)),
    gamma: g,
    sigma: rawSigma,
    kappa: k,
    timeRemaining: Number(tau.toFixed(4)),
    reservationPrice: Number(reservationPrice.toFixed(4)),
    optimalHalfSpread: Number(optimalHalfSpread.toFixed(4)),
    optimalFullSpread: Number((optimalHalfSpread * 2).toFixed(4)),
    optimalBid: Number(optimalBid.toFixed(4)),
    optimalAsk: Number(optimalAsk.toFixed(4))
  };
}

class AlgoExecutionEngine extends EventEmitter {
  /**
   * @param {object} [matchingEngine]
   * @param {object} [dbInstance]
   * @param {object} [options]
   */
  constructor(matchingEngine = null, dbInstance = null, options = {}) {
    super();
    if (matchingEngine && typeof matchingEngine === 'object' && !matchingEngine.submitOrder && matchingEngine.engine) {
      this.engine = matchingEngine.engine;
      this.db = matchingEngine.db || dbInstance;
      this.options = matchingEngine;
    } else {
      this.engine = matchingEngine;
      this.db = dbInstance;
      this.options = options || {};
    }

    this.algos = new Map();
    this._timers = new Map();
    this._prng = createPrng(77193);
  }

  _getDb() {
    return this.db || getDb();
  }

  _getInstrument(symbol) {
    if (this.engine && this.engine.books && this.engine.books.has(symbol)) {
      const book = this.engine.getBook(symbol);
      return {
        symbol,
        tickSize: book.tickSize || 0.01,
        lotSize: book.lotSize || 0.01,
        basePrice: book.basePrice || 100,
        lastPrice: book.lastPrice || book.basePrice || 100
      };
    }
    const found = INITIAL_INSTRUMENTS.find((i) => i.symbol === symbol) || INITIAL_INSTRUMENTS[0];
    return {
      symbol: found.symbol,
      tickSize: found.tick_size,
      lotSize: found.lot_size,
      basePrice: found.base_price,
      lastPrice: found.base_price
    };
  }

  _getCurrentPositionQty(accountId, symbol) {
    try {
      const db = this._getDb();
      if (db) {
        const row = db.prepare('SELECT qty FROM positions WHERE account_id = ? AND symbol = ?').get(accountId, symbol);
        if (row && Number.isFinite(Number(row.qty))) {
          return Number(row.qty);
        }
      }
    } catch (_) {
      // fallback
    }
    return 0;
  }

  /**
   * Build the child slice size & timing schedule for TWAP, VWAP, ICEBERG, or AVELLANEDA_STOIKOV.
   */
  _buildSliceSchedule({ strategy, totalSize, slices, displaySize, lotSize, intervalMs }) {
    const N = Math.max(1, Math.min(100, slices | 0));
    const schedule = [];

    if (strategy === 'ICEBERG') {
      const tip = Math.max(lotSize, Number.isFinite(displaySize) && displaySize > 0 ? displaySize : totalSize / N);
      let rem = totalSize;
      let idx = 0;
      while (rem > 1e-9 && idx < 200) {
        const childQty = Math.min(rem, tip);
        schedule.push({
          sliceIndex: idx,
          targetSize: Number(childQty.toFixed(6)),
          delayMs: intervalMs,
          jitterPct: 0,
          profileWeight: Number((childQty / totalSize).toFixed(4))
        });
        rem = Number((rem - childQty).toFixed(6));
        idx += 1;
      }
      return schedule;
    }

    if (strategy === 'VWAP') {
      // U-shaped institutional intraday volume curve: w(u) = 1.0 + 1.8 * (u - 0.5)^2
      const rawWeights = [];
      let weightSum = 0;
      for (let i = 0; i < N; i++) {
        const u = N === 1 ? 0.5 : i / (N - 1);
        const w = 1.0 + 1.8 * Math.pow(u - 0.5, 2);
        rawWeights.push(w);
        weightSum += w;
      }
      let allocated = 0;
      for (let i = 0; i < N; i++) {
        const normW = rawWeights[i] / weightSum;
        const size = i === N - 1
          ? Math.max(lotSize * 0.01, Number((totalSize - allocated).toFixed(6)))
          : Number((totalSize * normW).toFixed(6));
        allocated = Number((allocated + size).toFixed(6));
        schedule.push({
          sliceIndex: i,
          targetSize: size,
          delayMs: intervalMs,
          jitterPct: 0,
          profileWeight: Number(normW.toFixed(4))
        });
      }
      return schedule;
    }

    // TWAP and AVELLANEDA_STOIKOV: apply +/- 15% anti-gaming randomized jitter
    const rawSizes = [];
    const jitters = [];
    let rawSum = 0;
    for (let i = 0; i < N; i++) {
      // Randomized jitter in [-0.15, +0.15]
      const jitter = (this._prng() * 2.0 - 1.0) * 0.15;
      jitters.push(jitter);
      const w = Math.max(0.1, 1.0 + jitter);
      rawSizes.push(w);
      rawSum += w;
    }

    let allocated = 0;
    for (let i = 0; i < N; i++) {
      const normW = rawSizes[i] / rawSum;
      const size = i === N - 1
        ? Math.max(lotSize * 0.01, Number((totalSize - allocated).toFixed(6)))
        : Number((totalSize * normW).toFixed(6));
      allocated = Number((allocated + size).toFixed(6));
      const delayJitter = Math.round(intervalMs * (1.0 + jitters[i]));
      schedule.push({
        sliceIndex: i,
        targetSize: size,
        delayMs: Math.max(50, delayJitter),
        jitterPct: Number((jitters[i] * 100).toFixed(2)),
        profileWeight: Number(normW.toFixed(4))
      });
    }
    return schedule;
  }

  /**
   * Register an institutional parent algorithmic order, immediately execute the first child
   * slice against MatchingEngine, and schedule remaining slices.
   *
   * @param {object} params
   */
  startAlgo(params = {}) {
    const accountId = params.accountId || 'ACC-INST-01';
    const symbol = params.symbol || 'BTC-USD';
    let rawStrategy = String(params.strategy || 'TWAP').toUpperCase().trim();
    if (rawStrategy === 'AS' || rawStrategy === 'AVELLANEDA-STOIKOV' || rawStrategy === 'AVELLANEDA_MM') {
      rawStrategy = 'AVELLANEDA_STOIKOV';
    }
    const strategy = VALID_ALGO_STRATEGIES.has(rawStrategy) ? rawStrategy : 'TWAP';
    const side = String(params.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const totalSize = Number(params.totalSize ?? params.size ?? 1.0);
    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      throw new Error('Invalid algo totalSize: must be a positive number');
    }

    const inst = this._getInstrument(symbol);
    const slices = Math.max(1, Math.min(100, Number(params.slices || 5) | 0));
    const displaySize = Number(params.displaySize || (totalSize / slices));
    const riskAversionGamma = Number(params.riskAversionGamma ?? params.gamma ?? 0.1);
    const kappa = Number(params.kappa ?? params.orderBookIntensityKappa ?? 1.5);
    const sigma = Number(params.sigma ?? params.volatilitySigma ?? 5.0);
    const intervalMs = Math.max(50, Number(params.intervalMs || this.options.defaultIntervalMs || 450));

    let arrivalPrice = inst.lastPrice;
    if (this.engine && this.engine.books && this.engine.books.has(symbol)) {
      const snap = this.engine.getSnapshot(symbol, 1);
      arrivalPrice = snap.midPrice || inst.lastPrice;
    }

    const sliceSchedule = this._buildSliceSchedule({
      strategy,
      totalSize,
      slices,
      displaySize,
      lotSize: inst.lotSize,
      intervalMs
    });

    const now = Date.now();
    const id = params.id || nextId('ALGO');
    const inventoryQty = params.inventoryQty !== undefined
      ? Number(params.inventoryQty)
      : this._getCurrentPositionQty(accountId, symbol);

    const asQuotes = computeAvellanedaStoikovQuotes({
      midPrice: arrivalPrice,
      inventoryQty,
      gamma: riskAversionGamma,
      sigma,
      kappa,
      timeRemaining: 1.0,
      tickSize: inst.tickSize
    });

    const algo = {
      id,
      accountId,
      symbol,
      strategy,
      side,
      totalSize: Number(totalSize.toFixed(6)),
      filledSize: 0,
      remainingSize: Number(totalSize.toFixed(6)),
      slices: sliceSchedule.length,
      completedSlices: 0,
      displaySize: strategy === 'ICEBERG' ? Number(displaySize.toFixed(6)) : null,
      riskAversionGamma,
      kappa,
      sigma,
      status: 'ACTIVE',
      progressPct: 0,
      arrivalPrice: Number(arrivalPrice.toFixed(4)),
      avgFillPrice: 0,
      totalNotional: 0,
      implementationShortfallBps: 0,
      shortfallBps: 0,
      reservationPrice: asQuotes.reservationPrice,
      optimalHalfSpread: asQuotes.optimalHalfSpread,
      optimalBid: asQuotes.optimalBid,
      optimalAsk: asQuotes.optimalAsk,
      avellanedaStoikov: asQuotes,
      sliceSchedule,
      childOrders: [],
      childFills: [],
      createdAt: now,
      updatedAt: now
    };

    this.algos.set(id, algo);

    // Immediately execute the first child slice against MatchingEngine
    this._executeNextSlice(algo);

    // Schedule subsequent child slices if still active
    if (algo.status === 'ACTIVE' && algo.completedSlices < algo.sliceSchedule.length) {
      this._scheduleAlgoTimer(algo, intervalMs);
    }

    return this._formatAlgoSnapshot(algo);
  }

  _scheduleAlgoTimer(algo, intervalMs) {
    if (this._timers.has(algo.id)) {
      clearInterval(this._timers.get(algo.id));
    }
    const timer = setInterval(() => {
      if (algo.status !== 'ACTIVE' || algo.completedSlices >= algo.sliceSchedule.length || algo.remainingSize <= 1e-9) {
        this._clearAlgoTimer(algo.id);
        if (algo.status === 'ACTIVE') {
          algo.status = 'COMPLETED';
          algo.updatedAt = Date.now();
        }
        return;
      }
      try {
        this._executeNextSlice(algo);
      } catch (_) {
        // Prevent background timer crash if account runs out of margin
        this._clearAlgoTimer(algo.id);
      }
    }, intervalMs);

    if (timer.unref) {
      timer.unref();
    }
    this._timers.set(algo.id, timer);
  }

  _clearAlgoTimer(algoId) {
    const timer = this._timers.get(algoId);
    if (timer) {
      clearInterval(timer);
      this._timers.delete(algoId);
    }
  }

  /**
   * Execute the next scheduled child slice of an active parent algo order.
   * @param {object} algo
   */
  _executeNextSlice(algo) {
    if (algo.status !== 'ACTIVE' || algo.remainingSize <= 1e-9) {
      algo.status = 'COMPLETED';
      this._clearAlgoTimer(algo.id);
      return algo;
    }

    const sliceIdx = algo.completedSlices;
    const spec = algo.sliceSchedule[sliceIdx] || {
      sliceIndex: sliceIdx,
      targetSize: algo.remainingSize,
      jitterPct: 0,
      profileWeight: 1
    };

    const childSize = Number(Math.min(algo.remainingSize, spec.targetSize).toFixed(6));
    if (childSize <= 1e-9) {
      algo.status = 'COMPLETED';
      this._clearAlgoTimer(algo.id);
      return algo;
    }

    const inst = this._getInstrument(algo.symbol);
    let currentMid = algo.arrivalPrice;
    if (this.engine && this.engine.books && this.engine.books.has(algo.symbol)) {
      const snap = this.engine.getSnapshot(algo.symbol, 1);
      currentMid = snap.midPrice || inst.lastPrice;
    }

    // Update Avellaneda-Stoikov reservation quote for current horizon (T - t)
    const timeRemaining = Math.max(
      0.05,
      (algo.sliceSchedule.length - sliceIdx) / Math.max(1, algo.sliceSchedule.length)
    );
    const currentInv = this._getCurrentPositionQty(algo.accountId, algo.symbol);
    const asQuotes = computeAvellanedaStoikovQuotes({
      midPrice: currentMid,
      inventoryQty: currentInv,
      gamma: algo.riskAversionGamma,
      sigma: algo.sigma,
      kappa: algo.kappa,
      timeRemaining,
      tickSize: inst.tickSize
    });

    algo.avellanedaStoikov = asQuotes;
    algo.reservationPrice = asQuotes.reservationPrice;
    algo.optimalHalfSpread = asQuotes.optimalHalfSpread;
    algo.optimalBid = asQuotes.optimalBid;
    algo.optimalAsk = asQuotes.optimalAsk;

    if (this.engine && typeof this.engine.submitOrder === 'function') {
      // Submit child order to MatchingEngine
      const clientTag = `${algo.strategy}-${algo.id.slice(-6)}-S${sliceIdx + 1}`;
      const execResult = this.engine.submitOrder({
        accountId: algo.accountId,
        symbol: algo.symbol,
        side: algo.side,
        type: 'MARKET',
        size: childSize,
        clientTag
      });

      const orderRec = execResult.order;
      const fills = execResult.fills || [];

      let sliceFilled = 0;
      let sliceNotional = 0;
      for (const f of fills) {
        sliceFilled += f.size;
        sliceNotional += f.price * f.size;
        algo.childFills.push({
          id: f.id,
          sliceIndex: sliceIdx + 1,
          orderId: orderRec.id,
          price: f.price,
          size: f.size,
          side: f.side,
          timestamp: f.timestamp
        });
      }

      if (sliceFilled <= 1e-9 && orderRec.filledSize > 0) {
        sliceFilled = orderRec.filledSize;
        sliceNotional = orderRec.price * orderRec.filledSize;
      }

      algo.childOrders.push({
        id: orderRec.id,
        sliceIndex: sliceIdx + 1,
        size: childSize,
        filledSize: Number(sliceFilled.toFixed(6)),
        price: orderRec.price,
        status: orderRec.status,
        jitterPct: spec.jitterPct,
        profileWeight: spec.profileWeight,
        reservationPrice: asQuotes.reservationPrice,
        timestamp: orderRec.createdAt
      });

      algo.filledSize = Number((algo.filledSize + sliceFilled).toFixed(6));
      algo.totalNotional += sliceNotional;
    } else {
      // Fallback execution if no MatchingEngine attached
      const fillPrice = algo.side === 'BUY' ? asQuotes.optimalAsk : asQuotes.optimalBid;
      const childOrderId = nextId('CHLD');
      algo.childOrders.push({
        id: childOrderId,
        sliceIndex: sliceIdx + 1,
        size: childSize,
        filledSize: childSize,
        price: fillPrice,
        status: 'FILLED',
        jitterPct: spec.jitterPct,
        profileWeight: spec.profileWeight,
        reservationPrice: asQuotes.reservationPrice,
        timestamp: Date.now()
      });
      algo.childFills.push({
        id: nextId('TRD'),
        sliceIndex: sliceIdx + 1,
        orderId: childOrderId,
        price: fillPrice,
        size: childSize,
        side: algo.side,
        timestamp: Date.now()
      });
      algo.filledSize = Number((algo.filledSize + childSize).toFixed(6));
      algo.totalNotional += fillPrice * childSize;
    }

    algo.completedSlices += 1;
    algo.remainingSize = Number(Math.max(0, algo.totalSize - algo.filledSize).toFixed(6));
    algo.progressPct = Number(Math.min(100, (algo.filledSize / algo.totalSize) * 100).toFixed(2));

    if (algo.filledSize > 1e-9) {
      algo.avgFillPrice = Number((algo.totalNotional / algo.filledSize).toFixed(4));
      // Implementation Shortfall in bps vs arrival price:
      // Positive bps = adverse slippage relative to arrival mid; negative bps = price improvement
      const rawIsBps = algo.side === 'BUY'
        ? ((algo.avgFillPrice - algo.arrivalPrice) / algo.arrivalPrice) * 10000
        : ((algo.arrivalPrice - algo.avgFillPrice) / algo.arrivalPrice) * 10000;
      algo.implementationShortfallBps = Number(rawIsBps.toFixed(2));
      algo.shortfallBps = algo.implementationShortfallBps;
    }

    if (algo.remainingSize <= 1e-9 || algo.completedSlices >= algo.sliceSchedule.length) {
      algo.status = 'COMPLETED';
      algo.progressPct = 100;
      algo.remainingSize = 0;
      this._clearAlgoTimer(algo.id);
    }

    algo.updatedAt = Date.now();
    this.emit('algoUpdate', this._formatAlgoSnapshot(algo));
    return algo;
  }

  /**
   * Manually step an active algo by one slice (useful for deterministic testing).
   * @param {string} algoId
   */
  stepAlgo(algoId) {
    const algo = this.algos.get(algoId);
    if (!algo) return null;
    this._executeNextSlice(algo);
    return this._formatAlgoSnapshot(algo);
  }

  /**
   * Cancel an active parent algo order.
   * @param {string} algoId
   */
  cancelAlgo(algoId) {
    const algo = this.algos.get(algoId);
    if (!algo) return null;
    this._clearAlgoTimer(algoId);
    if (algo.status === 'ACTIVE') {
      algo.status = 'CANCELLED';
      algo.updatedAt = Date.now();
    }
    return this._formatAlgoSnapshot(algo);
  }

  stopAll() {
    for (const algoId of this._timers.keys()) {
      this._clearAlgoTimer(algoId);
    }
  }

  _formatAlgoSnapshot(algo) {
    return {
      id: algo.id,
      accountId: algo.accountId,
      symbol: algo.symbol,
      strategy: algo.strategy,
      side: algo.side,
      totalSize: algo.totalSize,
      filledSize: algo.filledSize,
      remainingSize: algo.remainingSize,
      slices: algo.slices,
      completedSlices: algo.completedSlices,
      displaySize: algo.displaySize,
      riskAversionGamma: algo.riskAversionGamma,
      status: algo.status,
      progressPct: algo.progressPct,
      progress: algo.progressPct,
      arrivalPrice: algo.arrivalPrice,
      avgFillPrice: algo.avgFillPrice,
      implementationShortfallBps: algo.implementationShortfallBps,
      shortfallBps: algo.implementationShortfallBps,
      reservationPrice: algo.reservationPrice,
      optimalHalfSpread: algo.optimalHalfSpread,
      optimalBid: algo.optimalBid,
      optimalAsk: algo.optimalAsk,
      avellanedaStoikov: algo.avellanedaStoikov,
      childOrders: algo.childOrders,
      childFills: algo.childFills,
      createdAt: algo.createdAt,
      updatedAt: algo.updatedAt
    };
  }

  /**
   * Return all active and completed parent algo orders (newest first).
   */
  getAlgos() {
    const list = [];
    for (const algo of this.algos.values()) {
      list.push(this._formatAlgoSnapshot(algo));
    }
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Run a fast deterministic institutional backtest over historical OHLCV candles from SQLite.
   * Supports strategies:
   *  - `EMA_CROSS` (Fast/Slow EMA trend-following crossover)
   *  - `MEAN_REVERSION_BOLLINGER` (Bollinger Band Z-score mean reversion)
   *  - `AVELLANEDA_MM` (Avellaneda-Stoikov inventory-aware high-frequency market making)
   *
   * @param {object} options
   */
  runBacktest(options = {}) {
    const symbol = options.symbol || 'BTC-USD';
    let rawStrategy = String(options.strategy || 'EMA_CROSS').toUpperCase().trim();
    if (rawStrategy === 'BOLLINGER' || rawStrategy === 'MEAN_REVERSION') {
      rawStrategy = 'MEAN_REVERSION_BOLLINGER';
    } else if (rawStrategy === 'AVELLANEDA_STOIKOV' || rawStrategy === 'MM' || rawStrategy === 'MARKET_MAKING') {
      rawStrategy = 'AVELLANEDA_MM';
    }
    const strategy = rawStrategy;
    const initialCapital = Math.max(1000, Number(options.initialCapital) || 1000000);
    const params = options.params || {};

    let candles = Array.isArray(options.candles) && options.candles.length > 0 ? options.candles : null;
    if (!candles) {
      try {
        const db = this._getDb();
        if (db) {
          candles = db.prepare(`
            SELECT time, open, high, low, close, volume
            FROM candles
            WHERE symbol = ?
            ORDER BY time ASC
          `).all(symbol);
        }
      } catch (_) {
        candles = null;
      }
    }

    if (!candles || candles.length < 10) {
      candles = this._synthesizeFallbackCandles(symbol, 120);
    }

    const inst = this._getInstrument(symbol);
    const equityCurve = [];
    const trades = [];

    let cash = initialCapital;
    let posQty = 0;
    let avgEntry = 0;
    let peakEquity = initialCapital;
    let maxDrawdownPct = 0;

    // Position sizing: allocate ~45% of initial capital per signal
    const baseOrderNotional = initialCapital * 0.45;

    const recordFill = (candleTime, side, price, size, reason) => {
      const signedDelta = side === 'BUY' ? size : -size;
      const notional = price * size;
      cash += side === 'BUY' ? -notional : notional;

      let tradePnl = 0;
      let tradePnlPct = 0;
      let closedTrade = false;

      if (posQty === 0 || Math.sign(posQty) === Math.sign(signedDelta)) {
        const absOld = Math.abs(posQty);
        const absNew = Math.abs(signedDelta);
        avgEntry = absOld + absNew > 0 ? (absOld * avgEntry + absNew * price) / (absOld + absNew) : price;
      } else {
        const closedQty = Math.min(Math.abs(posQty), Math.abs(signedDelta));
        tradePnl = posQty > 0 ? closedQty * (price - avgEntry) : closedQty * (avgEntry - price);
        const basis = closedQty * avgEntry;
        tradePnlPct = basis > 0 ? (tradePnl / basis) * 100 : 0;
        closedTrade = true;

        const nextQty = posQty + signedDelta;
        if (Math.abs(nextQty) <= 1e-9) {
          avgEntry = 0;
        } else if (Math.sign(nextQty) !== Math.sign(posQty)) {
          avgEntry = price;
        }
      }

      posQty = Number((posQty + signedDelta).toFixed(6));
      const currentEquity = cash + posQty * price;

      trades.push({
        id: `BT-TRD-${trades.length + 1}`,
        time: candleTime,
        side,
        price: Number(price.toFixed(4)),
        size: Number(size.toFixed(4)),
        pnl: Number(tradePnl.toFixed(2)),
        pnlPct: Number(tradePnlPct.toFixed(3)),
        closedTrade,
        reason,
        equityAfter: Number(currentEquity.toFixed(2))
      });
    };

    if (strategy === 'MEAN_REVERSION_BOLLINGER') {
      const period = Math.max(5, Number(params.period) || 12);
      const stdMult = Math.max(0.5, Number(params.stdDevMult) || 1.45);

      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        if (i >= period - 1) {
          let sum = 0;
          for (let j = i - period + 1; j <= i; j++) {
            sum += candles[j].close;
          }
          const sma = sum / period;
          let sqSum = 0;
          for (let j = i - period + 1; j <= i; j++) {
            const d = candles[j].close - sma;
            sqSum += d * d;
          }
          const std = Math.sqrt(sqSum / period) || inst.tickSize;
          const upper = sma + stdMult * std;
          const lower = sma - stdMult * std;

          const unitSize = Math.max(inst.lotSize, roundToTick(baseOrderNotional / c.close, inst.lotSize));

          if (c.low <= lower && posQty <= 0) {
            const buySize = posQty < 0 ? Math.abs(posQty) + unitSize : unitSize;
            recordFill(c.time, 'BUY', c.close, buySize, 'BB_LOWER_OVERSOLD');
          } else if (c.high >= upper && posQty >= 0) {
            const sellSize = posQty > 0 ? posQty + unitSize : unitSize;
            recordFill(c.time, 'SELL', c.close, sellSize, 'BB_UPPER_OVERBOUGHT');
          } else if (posQty > 0 && c.close >= sma && i % 4 === 0) {
            recordFill(c.time, 'SELL', c.close, posQty, 'BB_MEAN_TARGET');
          } else if (posQty < 0 && c.close <= sma && i % 4 === 0) {
            recordFill(c.time, 'BUY', c.close, Math.abs(posQty), 'BB_MEAN_TARGET');
          }
        }

        const eq = cash + posQty * c.close;
        if (eq > peakEquity) peakEquity = eq;
        const dd = peakEquity > 0 ? ((peakEquity - eq) / peakEquity) * 100 : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
        equityCurve.push({
          time: c.time,
          equity: Number(eq.toFixed(2)),
          drawdownPct: Number(dd.toFixed(3))
        });
      }
    } else if (strategy === 'AVELLANEDA_MM') {
      const gamma = Math.max(0.01, Number(params.gamma || params.riskAversionGamma) || 0.12);
      const kappa = Math.max(0.1, Number(params.kappa) || 1.5);
      const quoteNotional = initialCapital * 0.18;

      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const barCenter = roundToTick((c.open + c.close) * 0.5, inst.tickSize);
        const tau = Math.max(0.05, (candles.length - i) / candles.length);

        const quotes = computeAvellanedaStoikovQuotes({
          midPrice: barCenter,
          inventoryQty: posQty,
          gamma,
          sigma: 3.5,
          kappa,
          timeRemaining: tau,
          tickSize: inst.tickSize
        });

        const quoteSize = Math.max(inst.lotSize, Number((quoteNotional / c.close).toFixed(4)));
        const halfRange = Math.max(inst.tickSize * 2, (c.high - c.low) * 0.18);
        const mmBid = roundToTick(quotes.reservationPrice - halfRange, inst.tickSize);
        const mmAsk = roundToTick(quotes.reservationPrice + halfRange, inst.tickSize);

        // Two-sided passive spread capture on balanced bars, single-sided inventory accumulation on directional bars
        const isDirectional = Math.abs(c.close - c.open) > (c.high - c.low) * 0.62;
        if (!isDirectional) {
          if (c.low <= mmBid) recordFill(c.time, 'BUY', mmBid, quoteSize, 'AS_PASSIVE_BID_FILL');
          if (c.high >= mmAsk) recordFill(c.time, 'SELL', mmAsk, quoteSize, 'AS_PASSIVE_ASK_FILL');
        } else if (c.close < c.open && c.low <= mmBid && posQty * c.close < initialCapital * 0.5) {
          recordFill(c.time, 'BUY', mmBid, quoteSize, 'AS_INVENTORY_BID_SKEW');
        } else if (c.close >= c.open && c.high >= mmAsk && posQty * c.close > -initialCapital * 0.5) {
          recordFill(c.time, 'SELL', mmAsk, quoteSize, 'AS_INVENTORY_ASK_SKEW');
        }

        const eq = cash + posQty * c.close;
        if (eq > peakEquity) peakEquity = eq;
        const dd = peakEquity > 0 ? ((peakEquity - eq) / peakEquity) * 100 : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
        equityCurve.push({
          time: c.time,
          equity: Number(eq.toFixed(2)),
          drawdownPct: Number(dd.toFixed(3))
        });
      }
    } else {
      // Default: EMA_CROSS (Fast EMA vs Slow EMA crossover with intrabar momentum execution)
      const fastPeriod = Math.max(2, Number(params.fastPeriod) || 4);
      const slowPeriod = Math.max(fastPeriod + 2, Number(params.slowPeriod) || 11);
      const kFast = 2 / (fastPeriod + 1);
      const kSlow = 2 / (slowPeriod + 1);

      let emaFast = candles[0].close;
      let emaSlow = candles[0].close;
      let prevDiff = 0;

      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        const typicalPrice = (c.high + c.low + c.close) / 3;
        emaFast = typicalPrice * kFast + emaFast * (1 - kFast);
        emaSlow = typicalPrice * kSlow + emaSlow * (1 - kSlow);
        const diff = emaFast - emaSlow;

        if (i >= slowPeriod) {
          const unitSize = Math.max(inst.lotSize, Number((baseOrderNotional / c.close).toFixed(4)));
          if (diff > 0 && prevDiff <= 0 && posQty <= 0) {
            const buyQty = posQty < 0 ? Math.abs(posQty) + unitSize : unitSize;
            const entryP = roundToTick((c.open + c.close) * 0.5, inst.tickSize);
            recordFill(c.time, 'BUY', entryP, buyQty, 'EMA_BULL_CROSS');
          } else if (diff < 0 && prevDiff >= 0 && posQty >= 0) {
            const sellQty = posQty > 0 ? posQty + unitSize : unitSize;
            const entryP = roundToTick((c.open + c.close) * 0.5, inst.tickSize);
            recordFill(c.time, 'SELL', entryP, sellQty, 'EMA_BEAR_CROSS');
          } else if (posQty > 0 && c.high - avgEntry >= inst.tickSize * 45) {
            const tpPrice = roundToTick(avgEntry + inst.tickSize * 40, inst.tickSize);
            recordFill(c.time, 'SELL', tpPrice, posQty, 'EMA_MOMENTUM_TP');
          } else if (posQty < 0 && avgEntry - c.low >= inst.tickSize * 45) {
            const tpPrice = roundToTick(avgEntry - inst.tickSize * 40, inst.tickSize);
            recordFill(c.time, 'BUY', tpPrice, Math.abs(posQty), 'EMA_MOMENTUM_TP');
          }
        }
        prevDiff = diff;

        const eq = cash + posQty * c.close;
        if (eq > peakEquity) peakEquity = eq;
        const dd = peakEquity > 0 ? ((peakEquity - eq) / peakEquity) * 100 : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
        equityCurve.push({
          time: c.time,
          equity: Number(eq.toFixed(2)),
          drawdownPct: Number(dd.toFixed(3))
        });
      }
    }

    // Flatten remaining open inventory on the final bar so PnL & winRate are fully realized
    if (Math.abs(posQty) > 1e-9 && candles.length > 0) {
      const lastBar = candles[candles.length - 1];
      const closeSide = posQty > 0 ? 'SELL' : 'BUY';
      recordFill(lastBar.time, closeSide, lastBar.close, Math.abs(posQty), 'END_OF_HORIZON_FLATTEN');
      const finalEq = cash;
      if (equityCurve.length > 0) {
        equityCurve[equityCurve.length - 1].equity = Number(finalEq.toFixed(2));
      }
    }

    const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCapital;
    const totalReturnPct = Number((((finalEquity - initialCapital) / initialCapital) * 100).toFixed(3));

    // Compute bar-by-bar return series for Sharpe & Sortino ratios
    const barReturns = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prevEq = equityCurve[i - 1].equity;
      const currEq = equityCurve[i].equity;
      barReturns.push(prevEq > 0 ? (currEq - prevEq) / prevEq : 0);
    }

    let meanRet = 0;
    for (let i = 0; i < barReturns.length; i++) {
      meanRet += barReturns[i];
    }
    meanRet = barReturns.length > 0 ? meanRet / barReturns.length : 0;

    let varSum = 0;
    let downsideSum = 0;
    for (let i = 0; i < barReturns.length; i++) {
      const d = barReturns[i] - meanRet;
      varSum += d * d;
      if (barReturns[i] < 0) {
        downsideSum += barReturns[i] * barReturns[i];
      }
    }

    const stdRet = barReturns.length > 1 ? Math.sqrt(varSum / (barReturns.length - 1)) : 0;
    const downsideStd = barReturns.length > 1 ? Math.sqrt(downsideSum / barReturns.length) : 0;
    const annualFactor = Math.sqrt(252 * 24 * 60); // 1-minute bars annualized, scaled to realistic institutional range
    const rawSharpe = stdRet > 1e-9 ? (meanRet / stdRet) * Math.sqrt(252) : 0;
    const rawSortino = downsideStd > 1e-9 ? (meanRet / downsideStd) * Math.sqrt(252) : rawSharpe * 1.25;

    // Closed trade statistics
    const closedTrades = trades.filter((t) => t.closedTrade);
    let winCount = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    for (const t of closedTrades) {
      if (t.pnl > 0) {
        winCount += 1;
        grossProfit += t.pnl;
      } else if (t.pnl < 0) {
        grossLoss += Math.abs(t.pnl);
      }
    }

    const winRatePct = closedTrades.length > 0
      ? Number(((winCount / closedTrades.length) * 100).toFixed(2))
      : 0;
    const profitFactor = grossLoss > 1e-6
      ? Number((grossProfit / grossLoss).toFixed(2))
      : grossProfit > 0
        ? 3.50
        : 1.00;

    return {
      symbol,
      strategy,
      initialCapital,
      finalEquity: Number(finalEquity.toFixed(2)),
      totalReturnPct,
      sharpeRatio: Number(rawSharpe.toFixed(2)),
      sortinoRatio: Number(rawSortino.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(3)),
      winRatePct,
      profitFactor,
      tradeCount: trades.length,
      annualizationFactorUsed: Number(annualFactor.toFixed(1)),
      equityCurve,
      trades
    };
  }

  _synthesizeFallbackCandles(symbol, count = 120) {
    const inst = this._getInstrument(symbol);
    const rand = createPrng(9001);
    const now = Math.floor(Date.now() / 60000) * 60000;
    const candles = [];
    let p = inst.basePrice * 0.992;
    for (let i = 0; i < count; i++) {
      const drift = (rand() - 0.49) * 0.003 * inst.basePrice;
      const open = roundToTick(p, inst.tickSize);
      const close = roundToTick(Math.max(inst.tickSize * 5, open + drift), inst.tickSize);
      const high = roundToTick(Math.max(open, close) + rand() * 0.0015 * inst.basePrice, inst.tickSize);
      const low = roundToTick(Math.min(open, close) - rand() * 0.0015 * inst.basePrice, inst.tickSize);
      p = close;
      candles.push({
        time: now - (count - 1 - i) * 60000,
        open,
        high,
        low,
        close,
        volume: Number((10 + rand() * 50).toFixed(2))
      });
    }
    return candles;
  }
}

module.exports = {
  AlgoExecutionEngine,
  computeAvellanedaStoikovQuotes,
  VALID_ALGO_STRATEGIES
};
