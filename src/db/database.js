'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(__dirname, '../../data');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'argus.sqlite');

const INITIAL_INSTRUMENTS = [
  { symbol: 'BTC-USD', name: 'Bitcoin Spot', asset_class: 'CRYPTO', base_price: 94500.00, tick_size: 0.50, lot_size: 0.01 },
  { symbol: 'ETH-USD', name: 'Ethereum Spot', asset_class: 'CRYPTO', base_price: 3180.00, tick_size: 0.10, lot_size: 0.10 },
  { symbol: 'SOL-USD', name: 'Solana Spot', asset_class: 'CRYPTO', base_price: 212.50, tick_size: 0.05, lot_size: 1.00 },
  { symbol: 'NVDA-EQ', name: 'NVIDIA Corp', asset_class: 'EQUITY', base_price: 148.20, tick_size: 0.01, lot_size: 1.00 },
  { symbol: 'XAU-USD', name: 'Gold Spot', asset_class: 'COMMODITY', base_price: 2745.00, tick_size: 0.10, lot_size: 0.10 },
  { symbol: 'IDR-USD', name: 'USD/IDR FX Futures', asset_class: 'FX', base_price: 15680.00, tick_size: 1.00, lot_size: 100.00 }
];

const INITIAL_ACCOUNTS = [
  {
    id: 'ACC-INST-01',
    name: 'ALPHA-DESK-01',
    tier: 'PRIME',
    cash_balance: 2500000.00,
    margin_used: 184500.00,
    api_secret: 'demo_key_alpha_9981a'
  },
  {
    id: 'ACC-INST-02',
    name: 'MM-DESK-02',
    tier: 'MARKET_MAKER',
    cash_balance: 10000000.00,
    margin_used: 620000.00,
    api_secret: 'demo_key_mm_7742b'
  },
  {
    id: 'ACC-VAULT-99',
    name: 'SOVEREIGN-RESERVE-TREASURY',
    tier: 'RESTRICTED',
    cash_balance: 95000000.00,
    margin_used: 0.00,
    api_secret: 'demo_key_vault_0001x'
  }
];

const INITIAL_POSITIONS = [
  { account_id: 'ACC-INST-01', symbol: 'BTC-USD', qty: 4.5, avg_entry_price: 91200.00, realized_pnl: 14250.00 },
  { account_id: 'ACC-INST-01', symbol: 'ETH-USD', qty: 40.0, avg_entry_price: 3050.00, realized_pnl: 3800.00 },
  { account_id: 'ACC-INST-01', symbol: 'NVDA-EQ', qty: 1200.0, avg_entry_price: 139.50, realized_pnl: 6420.00 },
  { account_id: 'ACC-INST-01', symbol: 'XAU-USD', qty: 25.0, avg_entry_price: 2710.00, realized_pnl: 1150.00 },
  { account_id: 'ACC-INST-02', symbol: 'BTC-USD', qty: 18.0, avg_entry_price: 93800.00, realized_pnl: 82400.00 },
  { account_id: 'ACC-INST-02', symbol: 'SOL-USD', qty: 1500.0, avg_entry_price: 208.00, realized_pnl: 9100.00 }
];

let activeDb = null;

function roundToTick(price, tickSize) {
  const inv = 1 / tickSize;
  return Math.round(price * inv) / inv;
}

function createPrng(seed) {
  let state = seed >>> 0;
  return function nextRand() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function initSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS instruments (
      symbol TEXT PRIMARY KEY,
      name TEXT,
      asset_class TEXT,
      base_price REAL,
      tick_size REAL,
      lot_size REAL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT,
      tier TEXT,
      cash_balance REAL,
      margin_used REAL,
      api_secret TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS positions (
      account_id TEXT,
      symbol TEXT,
      qty REAL,
      avg_entry_price REAL,
      realized_pnl REAL,
      PRIMARY KEY (account_id, symbol)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      symbol TEXT,
      side TEXT,
      type TEXT,
      price REAL,
      size REAL,
      filled_size REAL,
      status TEXT,
      client_tag TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      symbol TEXT,
      price REAL,
      size REAL,
      side TEXT,
      maker_order_id TEXT,
      taker_order_id TEXT,
      timestamp INTEGER
    );

    CREATE TABLE IF NOT EXISTS candles (
      symbol TEXT,
      time INTEGER,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      PRIMARY KEY (symbol, time)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT,
      payload TEXT,
      created_at INTEGER
    );
  `);
}

function seedDatabase(db) {
  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM instruments').get();
  if (countRow && countRow.cnt > 0) {
    return;
  }

  const now = Date.now();
  const currentMinute = Math.floor(now / 60000) * 60000;

  db.exec('BEGIN');
  try {
    const insertInstrument = db.prepare(`
      INSERT INTO instruments (symbol, name, asset_class, base_price, tick_size, lot_size)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const inst of INITIAL_INSTRUMENTS) {
      insertInstrument.run(
        inst.symbol,
        inst.name,
        inst.asset_class,
        inst.base_price,
        inst.tick_size,
        inst.lot_size
      );
    }

    const insertAccount = db.prepare(`
      INSERT INTO accounts (id, name, tier, cash_balance, margin_used, api_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < INITIAL_ACCOUNTS.length; i++) {
      const acc = INITIAL_ACCOUNTS[i];
      insertAccount.run(
        acc.id,
        acc.name,
        acc.tier,
        acc.cash_balance,
        acc.margin_used,
        acc.api_secret,
        now - (90 + i * 30) * 86400000
      );
    }

    const insertPosition = db.prepare(`
      INSERT INTO positions (account_id, symbol, qty, avg_entry_price, realized_pnl)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const pos of INITIAL_POSITIONS) {
      insertPosition.run(pos.account_id, pos.symbol, pos.qty, pos.avg_entry_price, pos.realized_pnl);
    }

    // Seed 120 1-minute historical candles per instrument leading cleanly up to base_price
    const insertCandle = db.prepare(`
      INSERT INTO candles (symbol, time, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (let idx = 0; idx < INITIAL_INSTRUMENTS.length; idx++) {
      const inst = INITIAL_INSTRUMENTS[idx];
      const rand = createPrng(9001 + idx * 7919);

      // Generate a forward random walk of 120 steps, then scale/shift so the final close equals base_price
      const rawSteps = [];
      let p = inst.base_price * 0.992;
      for (let i = 0; i < 120; i++) {
        const drift = (rand() - 0.492) * 0.0028 * inst.base_price;
        const open = p;
        const close = Math.max(inst.tick_size * 10, open + drift);
        rawSteps.push({ open, close });
        p = close;
      }

      const finalDelta = inst.base_price - rawSteps[rawSteps.length - 1].close;
      for (let i = 0; i < 120; i++) {
        const weight = (i + 1) / 120;
        const step = rawSteps[i];
        const candleTime = currentMinute - (119 - i) * 60000;
        const open = roundToTick(step.open + finalDelta * ((i) / 120), inst.tick_size);
        const close = i === 119
          ? inst.base_price
          : roundToTick(step.close + finalDelta * weight, inst.tick_size);
        const wickUp = (0.0005 + rand() * 0.0018) * inst.base_price;
        const wickDown = (0.0005 + rand() * 0.0018) * inst.base_price;
        const high = roundToTick(Math.max(open, close) + wickUp, inst.tick_size);
        const low = roundToTick(Math.max(inst.tick_size, Math.min(open, close) - wickDown), inst.tick_size);
        const baseVol = inst.symbol === 'BTC-USD' ? 42 : inst.symbol === 'ETH-USD' ? 380 : inst.symbol === 'IDR-USD' ? 125000 : 2400;
        const volume = Number((baseVol * (0.4 + rand() * 1.4)).toFixed(2));

        insertCandle.run(inst.symbol, candleTime, open, high, low, close, volume);
      }
    }

    // Seed initial historical filled orders & trades so blotter/search/tape have rich data on startup
    const insertOrder = db.prepare(`
      INSERT INTO orders (id, account_id, symbol, side, type, price, size, filled_size, status, client_tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTrade = db.prepare(`
      INSERT INTO trades (id, symbol, price, size, side, maker_order_id, taker_order_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const seedOrders = [
      { id: 'ORD-SEED-1001', account_id: 'ACC-INST-01', symbol: 'BTC-USD', side: 'BUY', type: 'LIMIT', price: 94420.00, size: 1.25, filled_size: 1.25, status: 'FILLED', client_tag: 'TWAP-ALPHA-01', created_at: now - 320000 },
      { id: 'ORD-SEED-1002', account_id: 'ACC-INST-01', symbol: 'ETH-USD', side: 'BUY', type: 'LIMIT', price: 3175.50, size: 15.0, filled_size: 15.0, status: 'FILLED', client_tag: 'VWAP-CORE-02', created_at: now - 240000 },
      { id: 'ORD-SEED-1003', account_id: 'ACC-INST-01', symbol: 'NVDA-EQ', side: 'BUY', type: 'LIMIT', price: 147.90, size: 300.0, filled_size: 300.0, status: 'FILLED', client_tag: 'GAMMA-HEDGE-03', created_at: now - 180000 },
      { id: 'ORD-SEED-1004', account_id: 'ACC-INST-02', symbol: 'SOL-USD', side: 'SELL', type: 'LIMIT', price: 212.75, size: 120.0, filled_size: 120.0, status: 'FILLED', client_tag: 'MM-QUOTE-04', created_at: now - 120000 }
    ];

    for (const o of seedOrders) {
      insertOrder.run(o.id, o.account_id, o.symbol, o.side, o.type, o.price, o.size, o.filled_size, o.status, o.client_tag, o.created_at);
    }

    for (let idx = 0; idx < INITIAL_INSTRUMENTS.length; idx++) {
      const inst = INITIAL_INSTRUMENTS[idx];
      const rand = createPrng(4411 + idx * 313);
      for (let t = 0; t < 20; t++) {
        const side = rand() > 0.48 ? 'BUY' : 'SELL';
        const offsetTicks = Math.floor((rand() - 0.5) * 8);
        const price = roundToTick(inst.base_price + offsetTicks * inst.tick_size, inst.tick_size);
        const size = Number((inst.lot_size * (1 + Math.floor(rand() * 35))).toFixed(4));
        const ts = now - (20 - t) * 4500;
        insertTrade.run(
          `TRD-SEED-${inst.symbol.slice(0, 3)}-${100 + t}`,
          inst.symbol,
          price,
          size,
          side,
          `ORD-MM-${idx}-${t}`,
          t % 4 === 0 ? 'ORD-SEED-1001' : `ORD-TAKER-${idx}-${t}`,
          ts
        );
      }
    }

    const insertAudit = db.prepare(`
      INSERT INTO audit_logs (event_type, payload, created_at)
      VALUES (?, ?, ?)
    `);
    insertAudit.run('ENGINE_BOOT', JSON.stringify({ engine: 'ARGUS-MATCH-V2', mode: 'FIFO_L2', symbols: INITIAL_INSTRUMENTS.length }), now - 600000);
    insertAudit.run('SESSION_AUTH', JSON.stringify({ accountId: 'ACC-INST-01', desk: 'ALPHA-DESK-01', status: 'ACTIVE' }), now - 300000);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function initDatabase(options = {}) {
  const useMemory = Boolean(options.memory || process.env.ARGUS_DB_MEMORY === '1');
  let dbPath = ':memory:';
  if (!useMemory) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    dbPath = options.dbPath || DEFAULT_DB_PATH;
  }

  const db = new DatabaseSync(dbPath);
  initSchema(db);
  seedDatabase(db);
  activeDb = db;
  return db;
}

function getDb() {
  if (!activeDb) {
    return initDatabase();
  }
  return activeDb;
}

module.exports = {
  initDatabase,
  getDb,
  INITIAL_INSTRUMENTS,
  INITIAL_ACCOUNTS,
  INITIAL_POSITIONS,
  roundToTick
};
