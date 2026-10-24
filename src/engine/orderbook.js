'use strict';

const crypto = require('node:crypto');
const { getDb, INITIAL_INSTRUMENTS, roundToTick } = require('../db/database');

let seqCounter = 1000;
function nextId(prefix = 'ORD') {
  seqCounter += 1;
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${seqCounter}-${rand}`;
}

class Orderbook {
  constructor(instrument, dbInstance = null) {
    this.symbol = instrument.symbol;
    this.instrument = instrument;
    this.tickSize = instrument.tick_size || 0.01;
    this.lotSize = instrument.lot_size || 0.01;
    this.basePrice = instrument.base_price;
    this.lastPrice = instrument.base_price;
    this.db = dbInstance;

    // Individual resting orders sorted by Price-Time Priority (FIFO)
    // Bids: highest price first, then earliest timestamp (createdAt), then seq
    this.bids = [];
    // Asks: lowest price first, then earliest timestamp (createdAt), then seq
    this.asks = [];

    this._seq = 0;
    this.seedRestingBook(this.basePrice);
  }

  _getDb() {
    return this.db || getDb();
  }

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

  _insertResting(order) {
    this._seq += 1;
    order._seq = this._seq;
    if (order.side === 'BUY') {
      this.bids.push(order);
      this.bids.sort((a, b) => {
        if (b.price !== a.price) return b.price - a.price;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a._seq - b._seq;
      });
    } else {
      this.asks.push(order);
      this.asks.sort((a, b) => {
        if (a.price !== b.price) return a.price - b.price;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a._seq - b._seq;
      });
    }
  }

  submitOrder(params) {
    const now = Date.now();
    const side = String(params.side || 'BUY').toUpperCase();
    const type = String(params.type || 'LIMIT').toUpperCase();
    const size = Number(params.size);
    const accountId = params.accountId || 'ACC-INST-01';
    const id = params.id || nextId('ORD');
    const clientTag = params.clientTag || params.client_tag || 'MANUAL-TICKET';
    const isSynthetic = Boolean(params.isSynthetic);

    if (!Number.isFinite(size) || size <= 0) {
      throw new Error('Invalid order size: must be a positive number');
    }
    if (side !== 'BUY' && side !== 'SELL') {
      throw new Error('Invalid order side: must be BUY or SELL');
    }
    if (type !== 'LIMIT' && type !== 'MARKET') {
      throw new Error('Invalid order type: must be LIMIT or MARKET');
    }

    const snap = this.getSnapshot(5);
    let price = params.price !== undefined && params.price !== null ? Number(params.price) : null;
    if (type === 'LIMIT') {
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error('Invalid limit price: must be a positive number');
      }
      price = roundToTick(price, this.tickSize);
    } else {
      price = side === 'BUY'
        ? (snap.asks[0]?.price || this.lastPrice)
        : (snap.bids[0]?.price || this.lastPrice);
    }

    if (!isSynthetic) {
      const db = this._getDb();
      if (db) {
        const accountRow = db.prepare('SELECT cash_balance, margin_used FROM accounts WHERE id = ?').get(accountId);
        if (!accountRow) {
          throw new Error(`Unknown account: ${accountId}`);
        }
        const orderNotional = price * size;
        const maxBuyingPower = Number(accountRow.cash_balance) * 5;
        if (accountRow.cash_balance <= 0 || orderNotional > maxBuyingPower) {
          throw new Error(
            `Insufficient buying power / margin limit exceeded: notional $${orderNotional.toFixed(2)} exceeds 5x buying power limit ($${Math.max(0, maxBuyingPower).toFixed(2)})`
          );
        }
      }
    }

    const incoming = {
      id,
      accountId,
      symbol: this.symbol,
      side,
      type,
      price,
      size,
      filledSize: 0,
      remainingSize: size,
      status: 'OPEN',
      clientTag,
      createdAt: params.createdAt || now,
      isSynthetic
    };

    const fills = [];
    const oppositeBook = side === 'BUY' ? this.asks : this.bids;

    let idx = 0;
    while (idx < oppositeBook.length && incoming.remainingSize > 1e-9) {
      const resting = oppositeBook[idx];
      const priceCrosses =
        type === 'MARKET' ||
        (side === 'BUY' && incoming.price >= resting.price) ||
        (side === 'SELL' && incoming.price <= resting.price);

      if (!priceCrosses) {
        // Because oppositeBook is sorted by best price first, no subsequent order can match
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

      const fill = {
        id: nextId('TRD'),
        symbol: this.symbol,
        price: matchPrice,
        size: matchSize,
        side,
        makerOrderId: resting.id,
        takerOrderId: incoming.id,
        makerAccountId: resting.accountId,
        takerAccountId: incoming.accountId,
        restingWasSynthetic: Boolean(resting.isSynthetic),
        restingStatus: resting.status,
        restingFilledSize: resting.filledSize,
        timestamp: Date.now()
      };
      fills.push(fill);

      if (resting.remainingSize <= 1e-9) {
        oppositeBook.splice(idx, 1);
      } else {
        idx += 1;
      }
    }

    if (incoming.filledSize <= 1e-9) {
      incoming.status = type === 'MARKET' ? 'CANCELLED' : 'OPEN';
    } else if (incoming.remainingSize <= 1e-9) {
      incoming.status = 'FILLED';
      incoming.remainingSize = 0;
    } else {
      incoming.status = type === 'MARKET' ? 'FILLED' : 'PARTIAL';
    }

    if (type === 'LIMIT' && incoming.remainingSize > 1e-9) {
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

    return { order: orderRecord, fills };
  }

  _replenishBookLiquidity() {
    const refPrice = this.lastPrice || this.basePrice;
    const now = Date.now();
    const existingBidPrices = new Set(this.bids.map((b) => b.price));
    const existingAskPrices = new Set(this.asks.map((a) => a.price));

    for (let level = 1; level <= 18; level++) {
      const bidP = roundToTick(refPrice - level * this.tickSize, this.tickSize);
      const askP = roundToTick(refPrice + level * this.tickSize, this.tickSize);
      const size = Number((this.lotSize * (15 + level * 3)).toFixed(4));

      if (bidP > 0 && !existingBidPrices.has(bidP) && this.bids.length < 18) {
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

      if (!existingAskPrices.has(askP) && this.asks.length < 18) {
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
      } catch (_) {
        // ignore rollback error
      }
      throw err;
    }
  }

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
  constructor(dbInstance = null) {
    this.db = dbInstance;
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
          instruments = rows;
        }
      } catch (_) {
        // fallback to INITIAL_INSTRUMENTS
      }
    }
    for (const inst of instruments) {
      this.books.set(inst.symbol, new Orderbook(inst, this.db));
    }
  }

  getBook(symbol) {
    const book = this.books.get(symbol);
    if (!book) {
      throw new Error(`Unknown instrument symbol: ${symbol}`);
    }
    return book;
  }

  submitOrder(orderParams) {
    const symbol = orderParams.symbol || 'BTC-USD';
    const book = this.getBook(symbol);
    return book.submitOrder(orderParams);
  }

  cancelOrder(orderId, symbol = null) {
    if (symbol && this.books.has(symbol)) {
      const cancelled = this.books.get(symbol).cancelOrder(orderId);
      if (cancelled) return cancelled;
    }
    for (const book of this.books.values()) {
      const cancelled = book.cancelOrder(orderId);
      if (cancelled) return cancelled;
    }
    // Also check if order exists in SQLite and mark CANCELLED if it was OPEN/PARTIAL
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

  getSnapshot(symbol, depth = 15) {
    return this.getBook(symbol).getSnapshot(depth);
  }
}

module.exports = {
  Orderbook,
  MatchingEngine,
  nextId
};
