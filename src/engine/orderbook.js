'use strict';

const crypto = require('node:crypto');
const { getDb, INITIAL_INSTRUMENTS, roundToTick } = require('../db/database');
const { isFiniteNumber, logDiagnostic } = require('./validation');

/**
 * @typedef {Object} RestingOrder
 * @property {string} id
 * @property {string} accountId
 * @property {string} symbol
 * @property {'BUY'|'SELL'} side
 * @property {'LIMIT'|'MARKET'} type
 * @property {number} price
 * @property {number} size
 * @property {number} filledSize
 * @property {number} remainingSize
 * @property {string} status
 * @property {string} clientTag
 * @property {number} createdAt
 * @property {boolean} [isSynthetic]
 * @property {number} [_seq]
 */

/**
 * @typedef {Object} OrderFill
 * @property {string} id
 * @property {string} symbol
 * @property {number} price
 * @property {number} size
 * @property {'BUY'|'SELL'} side
 * @property {string} makerOrderId
 * @property {string} takerOrderId
 * @property {string} makerAccountId
 * @property {string} takerAccountId
 * @property {boolean} restingWasSynthetic
 * @property {string} restingStatus
 * @property {number} restingFilledSize
 * @property {number} timestamp
 */

let seqCounter = 1000;

/**
 * Generates a unique monotonic order or trade identifier.
 * @param {string} [prefix='ORD']
 * @returns {string}
 */
function nextId(prefix = 'ORD') {
  seqCounter += 1;
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${seqCounter}-${rand}`;
}

/**
 * Compares two resting orders under strict Price-Time Priority (FIFO).
 * Returns < 0 if `a` has higher priority than `b`, > 0 if lower priority.
 * @param {RestingOrder} a
 * @param {RestingOrder} b
 * @param {boolean} isBuy
 * @returns {number}
 */
function compareFifoPriority(a, b, isBuy) {
  if (a.price !== b.price) {
    return isBuy ? b.price - a.price : a.price - b.price;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return (a._seq || 0) - (b._seq || 0);
}

/**
 * Binary-search upper-bound insertion index in O(log N) preserving strict Price-Time FIFO priority.
 * @param {RestingOrder[]} book
 * @param {RestingOrder} order
 * @param {boolean} isBuy
 * @returns {number}
 */
function findBinaryInsertIndex(book, order, isBuy) {
  let lo = 0;
  let hi = book.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareFifoPriority(book[mid], order, isBuy) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

class Orderbook {
  /**
   * @param {import('../db/database').InstrumentRecord} instrument
   * @param {import('node:sqlite').DatabaseSync | null} [dbInstance=null]
   */
  constructor(instrument, dbInstance = null) {
    if (!instrument || typeof instrument !== 'object' || !instrument.symbol) {
      throw new Error('Invalid instrument configuration');
    }
    this.symbol = instrument.symbol;
    this.instrument = instrument;
    this.tickSize = instrument.tick_size || 0.01;
    this.lotSize = instrument.lot_size || 0.01;
    this.basePrice = instrument.base_price;
    this.lastPrice = instrument.base_price;
    this.db = dbInstance;

    // Individual resting orders sorted by Price-Time Priority (FIFO)
    // Bids: highest price first, then earliest timestamp (createdAt), then seq
    /** @type {RestingOrder[]} */
    this.bids = [];
    // Asks: lowest price first, then earliest timestamp (createdAt), then seq
    /** @type {RestingOrder[]} */
    this.asks = [];

    this._seq = 0;
    this.seedRestingBook(this.basePrice);
  }

  _getDb() {
    return this.db || getDb();
  }

  /**
   * Seeds initial institutional L2 resting depth around `centerPrice`.
   * @param {number} [centerPrice=this.lastPrice]
   */
  seedRestingBook(centerPrice = this.lastPrice) {
    this.bids = [];
    this.asks = [];
    const now = Date.now();

    for (let level = 1; level <= 18; level++) {
      const bidPrice = roundToTick(centerPrice - level * this.tickSize, this.tickSize);
      const askPrice = roundToTick(centerPrice + level * this.tickSize, this.tickSize);

      // Deterministic-looking institutional liquidity profile (deeper liquidity further from mid)
      const levelMultiplier = 1 + Math.sin(level * 1.7) * 0.45 + (level > 8 ? 0.6 : 0);
      const baseMultiple = this.symbol === 'BTC-USD' ? 35 : this.symbol === 'ETH-USD' ? 45 : this.symbol === 'IDR-USD' ? 150 : 60;
      const bidSize = Number((this.lotSize * Math.max(1, Math.round(baseMultiple * levelMultiplier))).toFixed(4));
      const askSize = Number((this.lotSize * Math.max(1, Math.round(baseMultiple * (levelMultiplier + 0.12)))).toFixed(4));

      if (bidPrice > 0) {
        this._insertResting({
          id: `MM-BID-${this.symbol}-${level}`,
          accountId: 'ACC-INST-02',
          symbol: this.symbol,
          side: 'BUY',
          type: 'LIMIT',
          price: bidPrice,
          size: bidSize,
          filledSize: 0,
          remainingSize: bidSize,
          status: 'OPEN',
          clientTag: 'MM-SEED-LIQ',
          createdAt: now - (20 - level) * 1000,
          isSynthetic: true
        });
      }

      this._insertResting({
        id: `MM-ASK-${this.symbol}-${level}`,
        accountId: 'ACC-INST-02',
        symbol: this.symbol,
        side: 'SELL',
        type: 'LIMIT',
        price: askPrice,
        size: askSize,
        filledSize: 0,
        remainingSize: askSize,
        status: 'OPEN',
        clientTag: 'MM-SEED-LIQ',
        createdAt: now - (20 - level) * 1000,
        isSynthetic: true
      });
    }
  }

  /**
   * Inserts a resting order into `this.bids` or `this.asks` using O(log N) binary search
   * instead of O(N log N) full-array sort, preserving strict (price, createdAt, _seq) FIFO priority.
   * @param {RestingOrder} order
   */
  _insertResting(order) {
    this._seq += 1;
    order._seq = this._seq;
    const isBuy = order.side === 'BUY';
    const targetBook = isBuy ? this.bids : this.asks;
    const insertIdx = findBinaryInsertIndex(targetBook, order, isBuy);
    targetBook.splice(insertIdx, 0, order);
  }

  /**
   * Validates and normalizes incoming order parameters.
   * @param {Record<string, any>} params
   */
  _normalizeAndValidateOrder(params) {
    if (!params || typeof params !== 'object') {
      throw new Error('Invalid order payload: expected object');
    }
    const now = Date.now();
    const side = String(params.side || 'BUY').toUpperCase();
    const type = String(params.type || 'LIMIT').toUpperCase();

    if (typeof params.size === 'boolean' || !isFiniteNumber(params.size) || Number(params.size) <= 0) {
      throw new Error('Invalid order size: must be a positive number');
    }
    const size = Number(params.size);

    if (side !== 'BUY' && side !== 'SELL') {
      throw new Error('Invalid order side: must be BUY or SELL');
    }
    if (type !== 'LIMIT' && type !== 'MARKET') {
      throw new Error('Invalid order type: must be LIMIT or MARKET');
    }

    const snap = this.getSnapshot(5);
    let price = null;
    if (type === 'LIMIT') {
      if (typeof params.price === 'boolean' || !isFiniteNumber(params.price) || Number(params.price) <= 0) {
        throw new Error('Invalid limit price: must be a positive number');
      }
      price = roundToTick(Number(params.price), this.tickSize);
    } else {
      price = side === 'BUY'
        ? (snap.asks[0]?.price || this.lastPrice)
        : (snap.bids[0]?.price || this.lastPrice);
    }

    const accountId = String(params.accountId || 'ACC-INST-01');
    const id = params.id || nextId('ORD');
    const clientTag = String(params.clientTag || params.client_tag || 'MANUAL-TICKET');
    const isSynthetic = Boolean(params.isSynthetic);
    const preventSelfTrade = Boolean(params.preventSelfTrade || params.stpMode);
    const stpMode = String(params.stpMode || 'CANCEL_TAKER').toUpperCase();

    return {
      incoming: {
        id,
        accountId,
        symbol: this.symbol,
        side: /** @type {'BUY'|'SELL'} */ (side),
        type: /** @type {'LIMIT'|'MARKET'} */ (type),
        price,
        size,
        filledSize: 0,
        remainingSize: size,
        status: 'OPEN',
        clientTag,
        createdAt: isFiniteNumber(params.createdAt) ? Number(params.createdAt) : now,
        isSynthetic
      },
      preventSelfTrade,
      stpMode
    };
  }

  /**
   * Enforces 5x cash buying-power margin check on non-synthetic orders.
   * @param {RestingOrder} incoming
   */
  _verifyBuyingPower(incoming) {
    if (incoming.isSynthetic) return;
    const db = this._getDb();
    if (!db) return;

    const accountRow = db.prepare('SELECT cash_balance, margin_used FROM accounts WHERE id = ?').get(incoming.accountId);
    if (!accountRow) {
      throw new Error(`Unknown account: ${incoming.accountId}`);
    }
    const orderNotional = incoming.price * incoming.size;
    const maxBuyingPower = Number(accountRow.cash_balance) * 5;
    if (accountRow.cash_balance <= 0 || orderNotional > maxBuyingPower) {
      throw new Error(
        `Insufficient buying power / margin limit exceeded: notional $${orderNotional.toFixed(2)} exceeds 5x buying power limit ($${Math.max(0, maxBuyingPower).toFixed(2)})`
      );
    }
  }

  /**
   * Executes FIFO price-time priority matching sweep against the opposite book.
   * Uses cursor advancement + batch head splice instead of O(N) per-match `.splice(idx, 1)`.
   * @param {RestingOrder} incoming
   * @param {boolean} preventSelfTrade
   * @param {string} stpMode
   * @returns {{ fills: OrderFill[], stpTriggered: boolean }}
   */
  _executeMatchSweep(incoming, preventSelfTrade, stpMode) {
    /** @type {OrderFill[]} */
    const fills = [];
    const oppositeBook = incoming.side === 'BUY' ? this.asks : this.bids;
    let cursor = 0;
    let contiguousHeadConsumed = 0;
    let hasNonContiguousRemoval = false;
    let stpTriggered = false;

    while (cursor < oppositeBook.length && incoming.remainingSize > 1e-9) {
      const resting = oppositeBook[cursor];
      if (resting.remainingSize <= 1e-9) {
        cursor += 1;
        continue;
      }

      const priceCrosses =
        incoming.type === 'MARKET' ||
        (incoming.side === 'BUY' && incoming.price >= resting.price) ||
        (incoming.side === 'SELL' && incoming.price <= resting.price);

      if (!priceCrosses) {
        break;
      }

      // Self-Trade Prevention (STP) when enabled and accounts match
      if (preventSelfTrade && incoming.accountId && incoming.accountId === resting.accountId) {
        stpTriggered = true;
        if (stpMode === 'CANCEL_MAKER') {
          resting.remainingSize = 0;
          resting.status = 'CANCELLED';
          if (cursor === contiguousHeadConsumed) {
            contiguousHeadConsumed += 1;
          } else {
            hasNonContiguousRemoval = true;
          }
          cursor += 1;
          continue;
        }
        if (stpMode === 'SKIP') {
          hasNonContiguousRemoval = true;
          cursor += 1;
          continue;
        }
        // Default CANCEL_TAKER: cancel remaining incoming taker qty immediately
        incoming.remainingSize = 0;
        incoming.status = incoming.filledSize > 1e-9 ? 'PARTIAL' : 'CANCELLED';
        break;
      }

      const matchSize = Number(Math.min(incoming.remainingSize, resting.remainingSize).toFixed(6));
      const matchPrice = resting.price;

      incoming.remainingSize = Number((incoming.remainingSize - matchSize).toFixed(6));
      incoming.filledSize = Number((incoming.filledSize + matchSize).toFixed(6));

      resting.remainingSize = Number((resting.remainingSize - matchSize).toFixed(6));
      resting.filledSize = Number((resting.filledSize + matchSize).toFixed(6));
      resting.status = resting.remainingSize <= 1e-9 ? 'FILLED' : 'PARTIAL';

      this.lastPrice = matchPrice;

      fills.push({
        id: nextId('TRD'),
        symbol: this.symbol,
        price: matchPrice,
        size: matchSize,
        side: incoming.side,
        makerOrderId: resting.id,
        takerOrderId: incoming.id,
        makerAccountId: resting.accountId,
        takerAccountId: incoming.accountId,
        restingWasSynthetic: Boolean(resting.isSynthetic),
        restingStatus: resting.status,
        restingFilledSize: resting.filledSize,
        timestamp: Date.now()
      });

      if (resting.remainingSize <= 1e-9) {
        if (!hasNonContiguousRemoval && cursor === contiguousHeadConsumed) {
          contiguousHeadConsumed += 1;
        } else {
          hasNonContiguousRemoval = true;
        }
      }
      cursor += 1;
    }

    // Batch-evict consumed resting orders in a single operation after the matching loop
    if (contiguousHeadConsumed > 0) {
      oppositeBook.splice(0, contiguousHeadConsumed);
    }
    if (hasNonContiguousRemoval) {
      for (let i = oppositeBook.length - 1; i >= 0; i--) {
        if (oppositeBook[i].remainingSize <= 1e-9) {
          oppositeBook.splice(i, 1);
        }
      }
    }

    return { fills, stpTriggered };
  }

  /**
   * Submits a LIMIT or MARKET order to the FIFO Orderbook.
   * @param {Record<string, any>} params
   */
  submitOrder(params) {
    const { incoming, preventSelfTrade, stpMode } = this._normalizeAndValidateOrder(params);
    this._verifyBuyingPower(incoming);

    const { fills, stpTriggered } = this._executeMatchSweep(incoming, preventSelfTrade, stpMode);

    if (stpTriggered && stpMode === 'CANCEL_TAKER' && incoming.remainingSize <= 1e-9 && incoming.filledSize <= 1e-9) {
      incoming.status = 'CANCELLED';
    } else if (incoming.filledSize <= 1e-9) {
      incoming.status = incoming.type === 'MARKET' ? 'CANCELLED' : 'OPEN';
    } else if (incoming.remainingSize <= 1e-9) {
      incoming.status = stpTriggered && stpMode === 'CANCEL_TAKER' && incoming.filledSize < incoming.size ? 'PARTIAL' : 'FILLED';
      incoming.remainingSize = 0;
    } else {
      incoming.status = incoming.type === 'MARKET' ? 'FILLED' : 'PARTIAL';
    }

    if (incoming.type === 'LIMIT' && incoming.remainingSize > 1e-9 && incoming.status !== 'CANCELLED') {
      this._insertResting(incoming);
    }

    // Ensure book never runs completely dry during heavy testing or market orders
    if (this.bids.length < 6 || this.asks.length < 6) {
      this._replenishBookLiquidity();
    }

    this._persistExecution(incoming, fills);

    const orderRecord = {
      id: incoming.id,
      accountId: incoming.accountId,
      symbol: incoming.symbol,
      side: incoming.side,
      type: incoming.type,
      price: incoming.price,
      size: incoming.size,
      filledSize: incoming.filledSize,
      remainingSize: incoming.remainingSize,
      status: incoming.status,
      clientTag: incoming.clientTag,
      createdAt: incoming.createdAt
    };

    return { order: orderRecord, fills, stpTriggered };
  }

  /**
   * Amends an active resting order's price and/or total size.
   * - Decreasing size at the same price preserves existing queue time priority.
   * - Changing price or increasing size loses time priority and re-inserts at the back of the level.
   * @param {string} orderId
   * @param {{ price?: number, size?: number }} updates
   * @returns {RestingOrder | null}
   */
  amendOrder(orderId, updates = {}) {
    if (!orderId || !updates || typeof updates !== 'object') {
      throw new Error('Invalid amendOrder arguments');
    }

    let book = this.bids;
    let idx = this.bids.findIndex((o) => o.id === orderId);
    if (idx === -1) {
      book = this.asks;
      idx = this.asks.findIndex((o) => o.id === orderId);
    }
    if (idx === -1) {
      return null;
    }

    const existing = book[idx];
    let newPrice = existing.price;
    let newSize = existing.size;

    if (updates.price !== undefined && updates.price !== null) {
      if (typeof updates.price === 'boolean' || !isFiniteNumber(updates.price) || Number(updates.price) <= 0) {
        throw new Error('Invalid amended price: must be a positive finite number');
      }
      newPrice = roundToTick(Number(updates.price), this.tickSize);
    }

    if (updates.size !== undefined && updates.size !== null) {
      if (typeof updates.size === 'boolean' || !isFiniteNumber(updates.size) || Number(updates.size) <= existing.filledSize) {
        throw new Error('Invalid amended size: must be a finite number greater than filledSize');
      }
      newSize = Number(updates.size);
    }

    const priceChanged = Math.abs(newPrice - existing.price) > 1e-9;
    const sizeIncreased = newSize > existing.size + 1e-9;

    existing.price = newPrice;
    existing.size = newSize;
    existing.remainingSize = Number((newSize - existing.filledSize).toFixed(6));

    if (priceChanged || sizeIncreased) {
      book.splice(idx, 1);
      existing.createdAt = Date.now();
      this._insertResting(existing);
    }

    const db = this._getDb();
    if (db && !existing.isSynthetic) {
      db.prepare('UPDATE orders SET price = ?, size = ? WHERE id = ?').run(existing.price, existing.size, orderId);
    }

    return existing;
  }

  _replenishBookLiquidity() {
    const refPrice = this.lastPrice || this.basePrice;
    const now = Date.now();
    const existingBidPrices = new Set(this.bids.map((b) => b.price));
    const existingAskPrices = new Set(this.asks.map((a) => a.price));

    const bidAnchor =
      this.asks.length > 0 ? Math.min(refPrice, this.asks[0].price) : refPrice;
    const askAnchor =
      this.bids.length > 0 ? Math.max(refPrice, this.bids[0].price) : refPrice;

    for (let level = 1; level <= 18; level++) {
      const bidP = roundToTick(bidAnchor - level * this.tickSize, this.tickSize);
      const askP = roundToTick(askAnchor + level * this.tickSize, this.tickSize);
      const size = Number((this.lotSize * (15 + level * 3)).toFixed(4));

      if (
        bidP > 0 &&
        (this.asks.length === 0 || bidP < this.asks[0].price) &&
        !existingBidPrices.has(bidP) &&
        this.bids.length < 18
      ) {
        existingBidPrices.add(bidP);
        this._insertResting({
          id: nextId('MM-BID'),
          accountId: 'ACC-INST-02',
          symbol: this.symbol,
          side: 'BUY',
          type: 'LIMIT',
          price: bidP,
          size,
          filledSize: 0,
          remainingSize: size,
          status: 'OPEN',
          clientTag: 'MM-AUTO-REPLENISH',
          createdAt: now,
          isSynthetic: true
        });
      }

      if (
        (this.bids.length === 0 || askP > this.bids[0].price) &&
        !existingAskPrices.has(askP) &&
        this.asks.length < 18
      ) {
        existingAskPrices.add(askP);
        this._insertResting({
          id: nextId('MM-ASK'),
          accountId: 'ACC-INST-02',
          symbol: this.symbol,
          side: 'SELL',
          type: 'LIMIT',
          price: askP,
          size,
          filledSize: 0,
          remainingSize: size,
          status: 'OPEN',
          clientTag: 'MM-AUTO-REPLENISH',
          createdAt: now,
          isSynthetic: true
        });
      }
    }
  }

  /**
   * Persists non-synthetic order states, fills, and position updates in an atomic SQLite transaction.
   * @param {RestingOrder} incoming
   * @param {OrderFill[]} fills
   */
  _persistExecution(incoming, fills) {
    const db = this._getDb();
    if (!db) return;

    // If synthetic order had zero fills, skip SQLite I/O to keep DB fast and clean
    if (incoming.isSynthetic && fills.length === 0) {
      return;
    }

    try {
      db.exec('BEGIN');

      if (!incoming.isSynthetic) {
        db.prepare(`
          INSERT OR REPLACE INTO orders (
            id, account_id, symbol, side, type, price, size, filled_size, status, client_tag, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          incoming.id,
          incoming.accountId,
          incoming.symbol,
          incoming.side,
          incoming.type,
          incoming.price,
          incoming.size,
          incoming.filledSize,
          incoming.status,
          incoming.clientTag,
          incoming.createdAt
        );
      }

      const insertTrade = db.prepare(`
        INSERT INTO trades (id, symbol, price, size, side, maker_order_id, taker_order_id, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateRestingOrder = db.prepare(`
        UPDATE orders SET filled_size = ?, status = ? WHERE id = ?
      `);

      for (const fill of fills) {
        insertTrade.run(
          fill.id,
          fill.symbol,
          fill.price,
          fill.size,
          fill.side,
          fill.makerOrderId,
          fill.takerOrderId,
          fill.timestamp
        );

        if (!fill.restingWasSynthetic) {
          updateRestingOrder.run(fill.restingFilledSize, fill.restingStatus, fill.makerOrderId);
          const makerSide = fill.side === 'BUY' ? 'SELL' : 'BUY';
          this._applyAccountAndPositionUpdate(db, fill.makerAccountId, fill.symbol, makerSide, fill.price, fill.size);
        }

        if (!incoming.isSynthetic) {
          this._applyAccountAndPositionUpdate(db, incoming.accountId, fill.symbol, incoming.side, fill.price, fill.size);
        }
      }

      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackErr) {
        logDiagnostic('orderbook', 'persist_rollback_error', rollbackErr);
      }
      throw err;
    }
  }

  /**
   * Updates account cash balance and position average entry / realized PnL on trade fill.
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {string} accountId
   * @param {string} symbol
   * @param {'BUY'|'SELL'} side
   * @param {number} fillPrice
   * @param {number} fillSize
   */
  _applyAccountAndPositionUpdate(db, accountId, symbol, side, fillPrice, fillSize) {
    if (!accountId) return;
    const notional = fillPrice * fillSize;
    const cashDelta = side === 'BUY' ? -notional : notional;

    db.prepare(`
      UPDATE accounts
      SET cash_balance = ROUND(cash_balance + ?, 4)
      WHERE id = ?
    `).run(cashDelta, accountId);

    const existing = db.prepare(`
      SELECT qty, avg_entry_price, realized_pnl
      FROM positions
      WHERE account_id = ? AND symbol = ?
    `).get(accountId, symbol);

    if (!existing) {
      const signedQty = side === 'BUY' ? fillSize : -fillSize;
      db.prepare(`
        INSERT INTO positions (account_id, symbol, qty, avg_entry_price, realized_pnl)
        VALUES (?, ?, ?, ?, 0)
      `).run(accountId, symbol, signedQty, fillPrice);
      return;
    }

    const oldQty = Number(existing.qty);
    const oldAvg = Number(existing.avg_entry_price);
    let realizedPnl = Number(existing.realized_pnl || 0);
    const signedDelta = side === 'BUY' ? fillSize : -fillSize;
    const newQty = Number((oldQty + signedDelta).toFixed(6));
    let newAvg = oldAvg;

    if (oldQty === 0 || Math.sign(oldQty) === Math.sign(signedDelta)) {
      const absOld = Math.abs(oldQty);
      const absDelta = Math.abs(signedDelta);
      newAvg = absOld + absDelta > 0
        ? (absOld * oldAvg + absDelta * fillPrice) / (absOld + absDelta)
        : fillPrice;
    } else {
      const closedQty = Math.min(Math.abs(oldQty), Math.abs(signedDelta));
      if (oldQty > 0) {
        realizedPnl += closedQty * (fillPrice - oldAvg);
      } else {
        realizedPnl += closedQty * (oldAvg - fillPrice);
      }
      if (Math.abs(newQty) <= 1e-9) {
        newAvg = 0;
      } else if (Math.sign(newQty) !== Math.sign(oldQty)) {
        newAvg = fillPrice;
      }
    }

    db.prepare(`
      UPDATE positions
      SET qty = ?, avg_entry_price = ?, realized_pnl = ?
      WHERE account_id = ? AND symbol = ?
    `).run(newQty, Number(newAvg.toFixed(4)), Number(realizedPnl.toFixed(4)), accountId, symbol);
  }

  /**
   * Cancels a resting order by ID.
   * @param {string} orderId
   * @returns {RestingOrder | null}
   */
  cancelOrder(orderId) {
    let removed = null;
    const bidIdx = this.bids.findIndex((o) => o.id === orderId);
    if (bidIdx !== -1) {
      removed = this.bids.splice(bidIdx, 1)[0];
    } else {
      const askIdx = this.asks.findIndex((o) => o.id === orderId);
      if (askIdx !== -1) {
        removed = this.asks.splice(askIdx, 1)[0];
      }
    }

    if (removed) {
      removed.status = 'CANCELLED';
      const db = this._getDb();
      if (db && !removed.isSynthetic) {
        db.prepare(`UPDATE orders SET status = 'CANCELLED' WHERE id = ?`).run(orderId);
      }
    }
    return removed;
  }

  /**
   * Aggregates resting orders into an L2 price-level snapshot up to `depth` levels.
   * @param {number} [depth=15]
   */
  getSnapshot(depth = 15) {
    const aggregateLevels = (orders, maxLevels) => {
      const levels = [];
      for (const o of orders) {
        if (o.remainingSize <= 1e-9) continue;
        const last = levels[levels.length - 1];
        if (last && Math.abs(last.price - o.price) < 1e-9) {
          last.size = Number((last.size + o.remainingSize).toFixed(4));
        } else {
          if (levels.length >= maxLevels) break;
          levels.push({
            price: o.price,
            size: Number(o.remainingSize.toFixed(4)),
            total: 0
          });
        }
      }
      let runningTotal = 0;
      for (const lvl of levels) {
        runningTotal = Number((runningTotal + lvl.size).toFixed(4));
        lvl.total = runningTotal;
      }
      return levels;
    };

    const bids = aggregateLevels(this.bids, depth);
    const asks = aggregateLevels(this.asks, depth);

    const bestBid = bids[0]?.price ?? roundToTick(this.lastPrice - this.tickSize, this.tickSize);
    const bestAsk = asks[0]?.price ?? roundToTick(this.lastPrice + this.tickSize, this.tickSize);
    const spread = Number(Math.max(0, bestAsk - bestBid).toFixed(4));
    const midPrice = roundToTick((bestBid + bestAsk) / 2, this.tickSize / 2);

    return {
      symbol: this.symbol,
      bids,
      asks,
      spread,
      midPrice
    };
  }
}

class MatchingEngine {
  /**
   * @param {import('node:sqlite').DatabaseSync | null} [dbInstance=null]
   */
  constructor(dbInstance = null) {
    this.db = dbInstance;
    /** @type {Map<string, Orderbook>} */
    this.books = new Map();
    this.initBooks();
  }

  _getDb() {
    return this.db || getDb();
  }

  initBooks() {
    const db = this._getDb();
    let instruments = INITIAL_INSTRUMENTS;
    if (db) {
      try {
        const rows = db.prepare('SELECT * FROM instruments').all();
        if (rows && rows.length > 0) {
          instruments = /** @type {import('../db/database').InstrumentRecord[]} */ (rows);
        }
      } catch (err) {
        logDiagnostic('matchingEngine', 'initBooks_fallback', err);
      }
    }
    for (const inst of instruments) {
      this.books.set(inst.symbol, new Orderbook(inst, this.db));
    }
  }

  /**
   * @param {string} symbol
   * @returns {Orderbook}
   */
  getBook(symbol) {
    const book = this.books.get(symbol);
    if (!book) {
      throw new Error(`Unknown instrument symbol: ${symbol}`);
    }
    return book;
  }

  /**
   * @param {Record<string, any>} orderParams
   */
  submitOrder(orderParams) {
    if (!orderParams || typeof orderParams !== 'object') {
      throw new Error('Invalid orderParams: expected object');
    }
    const symbol = orderParams.symbol || 'BTC-USD';
    const book = this.getBook(symbol);
    return book.submitOrder(orderParams);
  }

  /**
   * @param {string} orderId
   * @param {{ price?: number, size?: number, symbol?: string }} updates
   */
  amendOrder(orderId, updates = {}) {
    if (updates && updates.symbol && this.books.has(updates.symbol)) {
      return this.books.get(updates.symbol).amendOrder(orderId, updates);
    }
    for (const book of this.books.values()) {
      const amended = book.amendOrder(orderId, updates);
      if (amended) return amended;
    }
    return null;
  }

  /**
   * @param {string} orderId
   * @param {string | null} [symbol=null]
   */
  cancelOrder(orderId, symbol = null) {
    if (symbol && this.books.has(symbol)) {
      const cancelled = this.books.get(symbol).cancelOrder(orderId);
      if (cancelled) return cancelled;
    }
    for (const book of this.books.values()) {
      const cancelled = book.cancelOrder(orderId);
      if (cancelled) return cancelled;
    }
    const db = this._getDb();
    if (db) {
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (row && (row.status === 'OPEN' || row.status === 'PARTIAL')) {
        db.prepare(`UPDATE orders SET status = 'CANCELLED' WHERE id = ?`).run(orderId);
        return { ...row, status: 'CANCELLED' };
      }
    }
    return null;
  }

  /**
   * @param {string} symbol
   * @param {number} [depth=15]
   */
  getSnapshot(symbol, depth = 15) {
    return this.getBook(symbol).getSnapshot(depth);
  }
}

module.exports = {
  Orderbook,
  MatchingEngine,
  nextId,
  findBinaryInsertIndex,
  compareFifoPriority
};
