'use strict';

const EventEmitter = require('node:events');
const { getDb, INITIAL_INSTRUMENTS, roundToTick } = require('../db/database');
const { nextId } = require('./orderbook');

const SEED_HEADLINES = [
  {
    source: 'ARGUS MACRO WIRE',
    category: 'MACRO',
    symbol: 'BTC-USD',
    sentiment: 'BULLISH',
    priority: 'FLASH',
    headline: 'US SPOT BTC ETF NET INFLOWS SURPASS $640M IN NY SESSION AS SOVEREIGN DESKS ACCUMULATE',
    summary: 'Prime brokerage custody flows indicate sustained institutional bid across CME basis and spot venues.'
  },
  {
    source: 'FOMC WATCH',
    category: 'MACRO',
    symbol: 'XAU-USD',
    sentiment: 'BULLISH',
    priority: 'HIGH',
    headline: 'CENTRAL BANK GOLD RESERVES EXPAND FOR 14TH CONSECUTIVE MONTH; XAU-USD TESTS 2,745 RESISTANCE',
    summary: 'EM sovereign reserve managers continue diversifying duration exposure into physical bullion.'
  },
  {
    source: 'SEMI DESK',
    category: 'EQUITY',
    symbol: 'NVDA-EQ',
    sentiment: 'BULLISH',
    priority: 'HIGH',
    headline: 'HYPERSCALER CAPEX GUIDANCE REVISED UP +18% YOY ON NEXT-GEN BLACKWELL RACK DEPLOYMENTS',
    summary: 'Supply chain checks confirm Q4 HBM3e allocation fully booked across tier-1 cloud providers.'
  },
  {
    source: 'ASIA FX DESK',
    category: 'FX',
    symbol: 'IDR-USD',
    sentiment: 'NEUTRAL',
    priority: 'NORMAL',
    headline: 'BANK INDONESIA HOLDS 7-DAY REVERSE REPO RATE STEADY; USD/IDR NDF SPREADS TIGHTEN AT 15,680',
    summary: 'Domestic bond auctions attract $1.4B foreign inflows, stabilizing front-end FX swap points.'
  },
  {
    source: 'DEFI FLOWS',
    category: 'CRYPTO',
    symbol: 'ETH-USD',
    sentiment: 'BULLISH',
    priority: 'NORMAL',
    headline: 'ETHEREUM L2 BLOB THROUGHPUT HITS RECORD HIGH AS INSTITUTIONAL TOKENIZED TREASURY AUM TOPS $3.2B',
    summary: 'Staking yield compression offset by rising settlement volume from RWA institutional pools.'
  },
  {
    source: 'DERIVATIVES DESK',
    category: 'CRYPTO',
    symbol: 'SOL-USD',
    sentiment: 'BULLISH',
    priority: 'HIGH',
    headline: 'SOL-USD PERPETUAL OPEN INTEREST CLIMBS 11% AS HIGH-FREQUENCY DEX VOLUMES OUTPACE LEGACY VENUES',
    summary: 'Market makers report tight 5bps top-of-book spreads across major institutional liquidity pools.'
  },
  {
    source: 'RATES & CREDIT',
    category: 'MACRO',
    symbol: 'BTC-USD',
    sentiment: 'NEUTRAL',
    priority: 'NORMAL',
    headline: 'US 10Y TREASURY AUCTION TAILS 0.8 BPS; CROSS-ASSET VOLATILITY INDEX (MOVE) RETREATS TO 98.4',
    summary: 'Systematic risk-parity desks rebalance into high-beta digital assets and mega-cap tech.'
  },
  {
    source: 'OPTIONS FLOOR',
    category: 'EQUITY',
    symbol: 'NVDA-EQ',
    sentiment: 'BULLISH',
    priority: 'HIGH',
    headline: 'HEAVY CALL SWEEP DETECTED IN NVDA-EQ 155 STRIKE EXPIRING FRIDAY; DEALER GAMMA FLIPS POSITIVE',
    summary: 'Over 42,000 contracts traded at ask on institutional block crossing network.'
  },
  {
    source: 'COMMODITIES WIRE',
    category: 'COMMODITY',
    symbol: 'XAU-USD',
    sentiment: 'NEUTRAL',
    priority: 'NORMAL',
    headline: 'LONDON BULLION LEASE RATES EASE 12 BPS AS COMEX WAREHOUSE DELIVERIES NORMALIZE',
    summary: 'Physical EFP spreads narrow following brisk Asian physical settlement window.'
  },
  {
    source: 'PRIME BROKERAGE',
    category: 'CRYPTO',
    symbol: 'BTC-USD',
    sentiment: 'BULLISH',
    priority: 'HIGH',
    headline: 'CME BITCOIN FUTURES ANNUALIZED BASIS EXPANDS TO 13.4% AMID MULTI-STRATEGY CASH-AND-CARRY DEMAND',
    summary: 'Leveraged funds increase arbitrage positions while spot orderbook depth strengthens.'
  },
  {
    source: 'EM MACRO WIRE',
    category: 'FX',
    symbol: 'IDR-USD',
    sentiment: 'BEARISH',
    priority: 'NORMAL',
    headline: 'DXY DOLLAR INDEX FIRMS 0.25% FOLLOWING STRONG US ISM SERVICES PRINT; EM FX IN TIGHT RANGE',
    summary: 'State-owned banks seen offering USD liquidity near 15,695 handle to cap upside volatility.'
  },
  {
    source: 'QUANT RESEARCH',
    category: 'CRYPTO',
    symbol: 'ETH-USD',
    sentiment: 'NEUTRAL',
    priority: 'NORMAL',
    headline: 'ETH/BTC RATIO STABILIZES NEAR 0.0336 AS CROSS-EXCHANGE FUNDING RATES RESET TO NEUTRAL',
    summary: 'Statistical arbitrage desks note mean-reversion signals triggering across L1 basket.'
  }
];

const BREAKING_TEMPLATES = [
  {
    source: 'ARGUS FLASH',
    category: 'FLOW',
    symbol: 'BTC-USD',
    sentiment: 'BULLISH',
    priority: 'FLASH',
    headline: 'LARGE TWAP EXECUTION DETECTED ON BTC-USD: 145 BTC ACCUMULATED ACROSS L2 BIDS IN 90 SECONDS'
  },
  {
    source: 'OPTIONS ALERT',
    category: 'EQUITY',
    symbol: 'NVDA-EQ',
    sentiment: 'BULLISH',
    priority: 'HIGH',
    headline: 'INSTITUTIONAL DARK POOL PRINT: 480,000 SHARES NVDA-EQ CROSSED AT MID-MARKET'
  },
  {
    source: 'LIQUIDITY MONITOR',
    category: 'CRYPTO',
    symbol: 'SOL-USD',
    sentiment: 'BULLISH',
    priority: 'NORMAL',
    headline: 'SOL-USD L2 ORDERBOOK BID DEPTH INCREASES +24% AS MARKET MAKERS TIGHTEN QUOTES'
  },
  {
    source: 'SOVEREIGN DESK',
    category: 'COMMODITY',
    symbol: 'XAU-USD',
    sentiment: 'BULLISH',
    priority: 'HIGH',
    headline: 'BIS FIXING SEES UNUSUALLY LARGE PHYSICAL GOLD ALLOCATION BID AT 2,745 HANDLE'
  },
  {
    source: 'FX DEALER WIRE',
    category: 'FX',
    symbol: 'IDR-USD',
    sentiment: 'NEUTRAL',
    priority: 'NORMAL',
    headline: 'JAKARTA INTERBANK SPOT USD/IDR VOLUME SURGES 35% ABOVE 30-DAY MOVING AVERAGE'
  },
  {
    source: 'PRIME FLOW',
    category: 'CRYPTO',
    symbol: 'ETH-USD',
    sentiment: 'BEARISH',
    priority: 'NORMAL',
    headline: 'SYSTEMATIC CTA DESK REBALANCES ETH-USD EXPOSURE FOLLOWING VOLATILITY TARGET ADJUSTMENT'
  }
];

function formatClock(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(11, 19);
}

class MarketSimulator extends EventEmitter {
  constructor(matchingEngine, dbInstance = null) {
    super();
    this.engine = matchingEngine;
    this.db = dbInstance;
    this.tickCount = 0;
    this.timer = null;
    this.running = false;
    this.tickerState = new Map();
    this.newsWire = [];
    this.trades = [];

    this._initTickerState();
    this._initNewsWire();
  }

  get news() {
    return this.newsWire;
  }

  _getDb() {
    return this.db || getDb();
  }

  _initTickerState() {
    const db = this._getDb();
    let instruments = INITIAL_INSTRUMENTS;
    if (db) {
      try {
        const rows = db.prepare('SELECT * FROM instruments').all();
        if (rows && rows.length > 0) instruments = rows;
      } catch (_) {
        // fallback
      }
    }

    const baselineOffsets = {
      'BTC-USD': -0.0142, // +1.42% 24h change
      'ETH-USD': -0.0085, // +0.85% 24h change
      'SOL-USD': -0.0315, // +3.15% 24h change
      'NVDA-EQ': -0.0220, // +2.20% 24h change
      'XAU-USD': -0.0045, // +0.45% 24h change
      'IDR-USD': 0.0018   // -0.18% 24h change
    };

    const baseVolumes = {
      'BTC-USD': 18420.5,
      'ETH-USD': 142800.0,
      'SOL-USD': 1890400.0,
      'NVDA-EQ': 41250000.0,
      'XAU-USD': 94200.0,
      'IDR-USD': 850000000.0
    };

    for (const inst of instruments) {
      const offsetRatio = baselineOffsets[inst.symbol] ?? -0.01;
      const open24h = roundToTick(inst.base_price * (1 + offsetRatio), inst.tick_size);
      const high24h = roundToTick(Math.max(inst.base_price, open24h) * 1.012, inst.tick_size);
      const low24h = roundToTick(Math.min(inst.base_price, open24h) * 0.989, inst.tick_size);
      const volume24h = baseVolumes[inst.symbol] || 50000;
      const notional24h = volume24h * ((inst.base_price + open24h) / 2);

      this.tickerState.set(inst.symbol, {
        symbol: inst.symbol,
        name: inst.name,
        assetClass: inst.asset_class,
        tickSize: inst.tick_size,
        lotSize: inst.lot_size,
        basePrice: inst.base_price,
        open24h,
        lastPrice: inst.base_price,
        high24h,
        low24h,
        volume24h,
        notional24h,
        vwap: roundToTick(notional24h / volume24h, inst.tick_size)
      });
    }
  }

  _initNewsWire() {
    const now = Date.now();
    this.newsWire = SEED_HEADLINES.map((item, idx) => {
      const ts = now - (SEED_HEADLINES.length - idx) * 45000;
      return {
        id: `NWS-SEED-${100 + idx}`,
        timestamp: ts,
        time: formatClock(ts),
        source: item.source,
        category: item.category,
        tag: item.category,
        symbol: item.symbol,
        sentiment: item.sentiment,
        priority: item.priority,
        headline: item.headline,
        title: item.headline,
        summary: item.summary
      };
    }).reverse();
  }

  start(intervalMs = 400) {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      try {
        this.step();
      } catch (_) {
        // prevent unhandled interval error
      }
    }, intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  step() {
    this.tickCount += 1;
    const now = Date.now();
    const symbols = Array.from(this.tickerState.keys());

    // Pick 2 instruments per 400ms tick to experience active orderflow + trade execution
    const activeIdx1 = this.tickCount % symbols.length;
    const activeIdx2 = (this.tickCount * 3 + 1) % symbols.length;

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      const state = this.tickerState.get(symbol);
      const book = this.engine.getBook(symbol);

      // Gentle mean-reverting Geometric Brownian Motion around basePrice
      const reversionPull = (state.basePrice - state.lastPrice) / state.basePrice;
      const shock = (Math.random() - 0.498 + reversionPull * 0.15) * 2.2;
      const tickDelta = Math.round(shock) * state.tickSize;
      const targetMid = Math.max(
        state.tickSize * 5,
        roundToTick(state.lastPrice + tickDelta, state.tickSize)
      );

      // Maintain healthy synthetic resting orderbook depth around targetMid
      this._maintainBookAroundMid(book, state, targetMid, now);

      // Execute synthetic taker trade on selected symbols
      if (i === activeIdx1 || i === activeIdx2) {
        const side = shock >= 0 ? 'BUY' : 'SELL';
        const sizeMult = 1 + Math.floor(Math.random() * 8);
        const tradeSize = Number((state.lotSize * sizeMult).toFixed(4));

        const { fills } = book.submitOrder({
          accountId: 'ACC-INST-02',
          symbol,
          side,
          type: 'MARKET',
          size: tradeSize,
          clientTag: 'SIM-FLOW',
          isSynthetic: true
        });

        for (const fill of fills) {
          this._recordTradeMetrics(state, fill.price, fill.size, fill.timestamp);
          const candle = this._updateCurrentCandle(symbol, state, fill.price, fill.size, fill.timestamp);
          const tradePayload = {
            id: fill.id,
            symbol: fill.symbol,
            price: fill.price,
            size: fill.size,
            side: fill.side,
            makerOrderId: fill.makerOrderId,
            takerOrderId: fill.takerOrderId,
            timestamp: fill.timestamp
          };
          this.trades.unshift(tradePayload);
          if (this.trades.length > 100) {
            this.trades.pop();
          }
          this.emit('trade', tradePayload);
          if (candle) {
            this.emit('candle', { symbol, candle });
          }
        }
      }

      const obSnapshot = book.getSnapshot(15);
      this.emit('orderbook', { symbol, orderbook: obSnapshot });
    }

    const tickers = this.getTickers();
    this.emit('tick', {
      tickers,
      timestamp: now,
      tickCount: this.tickCount
    });

    // Every 25 ticks (~10s), emit a fresh breaking institutional news flash
    if (this.tickCount % 25 === 0) {
      const tpl = BREAKING_TEMPLATES[(this.tickCount / 25) % BREAKING_TEMPLATES.length];
      const item = {
        id: nextId('NWS'),
        timestamp: now,
        time: formatClock(now),
        source: tpl.source,
        category: tpl.category,
        tag: tpl.category,
        symbol: tpl.symbol,
        sentiment: tpl.sentiment,
        priority: tpl.priority,
        headline: tpl.headline,
        title: tpl.headline,
        summary: `Automated institutional desk alert logged at ${formatClock(now)} UTC.`
      };
      this.newsWire.unshift(item);
      if (this.newsWire.length > 40) {
        this.newsWire.pop();
      }
      this.emit('news', item);
    }
  }

  _maintainBookAroundMid(book, state, targetMid, now) {
    // Prune synthetic orders that are too far from targetMid or crossed, while never touching real user orders
    book.bids = book.bids.filter((o) => {
      if (!o.isSynthetic) return true;
      return o.price < targetMid && o.price >= targetMid - state.tickSize * 28;
    });
    book.asks = book.asks.filter((o) => {
      if (!o.isSynthetic) return true;
      return o.price > targetMid && o.price <= targetMid + state.tickSize * 28;
    });

    // Ensure 18 distinct price levels on both bid and ask sides
    const bidPrices = new Set(book.bids.map((o) => o.price));
    const askPrices = new Set(book.asks.map((o) => o.price));

    for (let lvl = 1; lvl <= 18; lvl++) {
      const bPrice = roundToTick(targetMid - lvl * state.tickSize, state.tickSize);
      const aPrice = roundToTick(targetMid + lvl * state.tickSize, state.tickSize);
      const baseMult = state.symbol === 'BTC-USD' ? 28 : state.symbol === 'IDR-USD' ? 120 : 45;
      const jitter = 0.6 + Math.random() * 0.9;

      if (bPrice > 0 && !bidPrices.has(bPrice)) {
        const size = Number((state.lotSize * Math.max(1, Math.round(baseMult * jitter))).toFixed(4));
        book._insertResting({
          id: nextId('MM-B'),
          accountId: 'ACC-INST-02',
          symbol: state.symbol,
          side: 'BUY',
          type: 'LIMIT',
          price: bPrice,
          size,
          filledSize: 0,
          remainingSize: size,
          status: 'OPEN',
          clientTag: 'MM-QUOTE',
          createdAt: now,
          isSynthetic: true
        });
      }

      if (!askPrices.has(aPrice)) {
        const size = Number((state.lotSize * Math.max(1, Math.round(baseMult * jitter))).toFixed(4));
        book._insertResting({
          id: nextId('MM-A'),
          accountId: 'ACC-INST-02',
          symbol: state.symbol,
          side: 'SELL',
          type: 'LIMIT',
          price: aPrice,
          size,
          filledSize: 0,
          remainingSize: size,
          status: 'OPEN',
          clientTag: 'MM-QUOTE',
          createdAt: now,
          isSynthetic: true
        });
      }
    }
  }

  _recordTradeMetrics(state, price, size) {
    state.lastPrice = price;
    if (price > state.high24h) state.high24h = price;
    if (price < state.low24h) state.low24h = price;
    state.volume24h = Number((state.volume24h + size).toFixed(4));
    state.notional24h = state.notional24h + price * size;
    state.vwap = roundToTick(state.notional24h / state.volume24h, state.tickSize);
  }

  recordExternalFills(symbol, fills) {
    const state = this.tickerState.get(symbol);
    if (!state || !fills || fills.length === 0) return;
    for (const fill of fills) {
      this._recordTradeMetrics(state, fill.price, fill.size, fill.timestamp);
      const candle = this._updateCurrentCandle(symbol, state, fill.price, fill.size, fill.timestamp);
      if (candle) {
        this.emit('candle', { symbol, candle });
      }
    }
  }

  _updateCurrentCandle(symbol, state, price, size, timestamp) {
    const db = this._getDb();
    if (!db) return null;

    const candleTime = Math.floor(timestamp / 60000) * 60000;
    const existing = db.prepare(`
      SELECT time, open, high, low, close, volume
      FROM candles
      WHERE symbol = ? AND time = ?
    `).get(symbol, candleTime);

    if (!existing) {
      const prev = db.prepare(`
        SELECT close FROM candles WHERE symbol = ? ORDER BY time DESC LIMIT 1
      `).get(symbol);
      const open = prev ? prev.close : price;
      const high = Math.max(open, price);
      const low = Math.min(open, price);
      const close = price;
      const volume = Number(size.toFixed(4));
      db.prepare(`
        INSERT INTO candles (symbol, time, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(symbol, candleTime, open, high, low, close, volume);
      return { time: candleTime, open, high, low, close, volume };
    }

    const high = Math.max(existing.high, price);
    const low = Math.min(existing.low, price);
    const close = price;
    const volume = Number((existing.volume + size).toFixed(4));

    db.prepare(`
      UPDATE candles
      SET high = ?, low = ?, close = ?, volume = ?
      WHERE symbol = ? AND time = ?
    `).run(high, low, close, volume, symbol, candleTime);

    return {
      time: candleTime,
      open: existing.open,
      high,
      low,
      close,
      volume
    };
  }

  getTickers() {
    const result = [];
    for (const [symbol, state] of this.tickerState.entries()) {
      const book = this.engine.getBook(symbol);
      const snap = book.getSnapshot(1);
      const lastPrice = book.lastPrice || state.lastPrice;
      state.lastPrice = lastPrice;

      const change24h = roundToTick(lastPrice - state.open24h, state.tickSize);
      const changePct24h = Number(((change24h / state.open24h) * 100).toFixed(2));
      const bid = snap.bids[0]?.price ?? roundToTick(lastPrice - state.tickSize, state.tickSize);
      const ask = snap.asks[0]?.price ?? roundToTick(lastPrice + state.tickSize, state.tickSize);
      const spread = Number(Math.max(0, ask - bid).toFixed(4));

      result.push({
        symbol: state.symbol,
        name: state.name,
        assetClass: state.assetClass,
        tickSize: state.tickSize,
        lotSize: state.lotSize,
        lastPrice,
        change24h,
        changePct24h,
        high24h: state.high24h,
        low24h: state.low24h,
        volume24h: state.volume24h,
        vwap: state.vwap,
        bid,
        ask,
        spread
      });
    }
    return result;
  }

  getNews(limit = 25) {
    return this.newsWire.slice(0, limit);
  }
}

module.exports = {
  MarketSimulator
};
