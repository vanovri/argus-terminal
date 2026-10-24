'use strict';

const { URL } = require('node:url');
const { performance } = require('node:perf_hooks');
const quantRisk = require('../engine/quantRisk');
const optionsGreeks = require('../engine/optionsGreeks');
const yieldCurveFixedIncome = require('../engine/yieldCurveFixedIncome');
const { LobTimeMachine } = require('../engine/lobTimeMachine');
const { DarkPoolEngine } = require('../engine/darkPoolEngine');

let cachedAlgoModule = null;
let cachedSlabModule = null;
let cachedFixModule = null;
let cachedSorModule = null;

function loadOptionalWave2Modules() {
  if (!cachedAlgoModule) {
    try {
      cachedAlgoModule = require('../engine/algoEngine');
    } catch (_) {
      cachedAlgoModule = null;
    }
  }
  if (!cachedSlabModule) {
    try {
      cachedSlabModule = require('../engine/slabOrderbook');
    } catch (_) {
      cachedSlabModule = null;
    }
  }
  return { algoMod: cachedAlgoModule, slabMod: cachedSlabModule };
}

function loadOptionalWave3Modules() {
  if (!cachedFixModule) {
    try {
      cachedFixModule = require('../engine/fixProtocol');
    } catch (_) {
      cachedFixModule = null;
    }
  }
  if (!cachedSorModule) {
    try {
      cachedSorModule = require('../engine/smartOrderRouter');
    } catch (_) {
      cachedSorModule = null;
    }
  }
  return { fixMod: cachedFixModule, sorMod: cachedSorModule };
}

function computeFallbackFixChecksum(bodyWithoutTag10) {
  let sum = 0;
  for (let i = 0; i < bodyWithoutTag10.length; i++) {
    sum = (sum + bodyWithoutTag10.charCodeAt(i)) & 0xff;
  }
  return String(sum).padStart(3, '0');
}

function encodeFallbackSbe40({ templateId = 101, orderIdNum = 100001, price = 94500, size = 1.0, side = 'BUY', type = 'LIMIT', symbol = 'BTC-USD' }) {
  const buf = Buffer.alloc(40);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint16(0, 32, true); // blockLength
  view.setUint16(2, Number(templateId) || 101, true); // templateId
  view.setUint16(4, 1, true); // schemaId
  view.setUint16(6, 4, true); // version
  view.setBigUint64(8, BigInt(Math.max(1, Math.trunc(Number(orderIdNum) || 100001))), true);
  view.setBigInt64(16, BigInt(Math.round(Number(price || 0) * 1e8)), true);
  view.setBigInt64(24, BigInt(Math.round(Number(size || 0) * 1e8)), true);
  view.setUint8(32, String(side).toUpperCase() === 'SELL' ? 2 : 1);
  view.setUint8(33, String(type).toUpperCase() === 'MARKET' ? 1 : 2);
  const symAscii = String(symbol || 'BTC-USD').slice(0, 6).padEnd(6, '\0');
  for (let i = 0; i < 6; i++) {
    view.setUint8(34 + i, symAscii.charCodeAt(i) & 0xff);
  }
  return buf;
}

function decodeFallbackSbe40(bufInput) {
  const buf = Buffer.isBuffer(bufInput) ? bufInput : Buffer.from(bufInput);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let sym = '';
  for (let i = 0; i < 6; i++) {
    const code = view.getUint8(34 + i);
    if (code !== 0) sym += String.fromCharCode(code);
  }
  const sideCode = view.getUint8(32);
  const typeCode = view.getUint8(33);
  return {
    blockLength: view.getUint16(0, true),
    templateId: view.getUint16(2, true),
    schemaId: view.getUint16(4, true),
    version: view.getUint16(6, true),
    orderIdNum: Number(view.getBigUint64(8, true)),
    priceMantissa: view.getBigInt64(16, true).toString(),
    sizeMantissa: view.getBigInt64(24, true).toString(),
    price: Number(view.getBigInt64(16, true)) / 1e8,
    size: Number(view.getBigInt64(24, true)) / 1e8,
    side: sideCode === 2 ? 'SELL' : 'BUY',
    type: typeCode === 1 ? 'MARKET' : 'LIMIT',
    symbol: sym || 'BTC-USD'
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(body);
}

const MAX_JSON_BODY_BYTES = 64 * 1024; // 64 KB limit

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let byteCount = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      byteCount += chunk.length;
      if (byteCount > MAX_JSON_BODY_BYTES) {
        rejected = true;
        reject(new Error('Payload too large: exceeds 64KB limit'));
        return;
      }
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (rejected) return;
      if (!raw || !raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', (err) => {
      if (!rejected) {
        rejected = true;
        reject(err);
      }
    });
  });
}

function validateReadOnlySql(rawQuery) {
  const trimmed = String(rawQuery || '').trim().replace(/;+\s*$/, '');
  if (!trimmed) {
    return { valid: false, status: 400, error: 'Query is required' };
  }
  if (trimmed.includes(';') || /--|\/\*/.test(trimmed)) {
    return {
      valid: false,
      status: 403,
      error: 'SQL security policy violation: multi-statement queries and inline SQL comments are forbidden'
    };
  }
  if (!/^SELECT\b/i.test(trimmed)) {
    return {
      valid: false,
      status: 403,
      error: 'SQL security policy violation: only read-only SELECT statements are permitted'
    };
  }
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REPLACE|CREATE)\b/i.test(trimmed)) {
    return {
      valid: false,
      status: 403,
      error: 'SQL security policy violation: mutating or administrative SQL keywords are forbidden'
    };
  }
  if (/\b(accounts|api_secret)\b/i.test(trimmed)) {
    return {
      valid: false,
      status: 403,
      error: 'SQL security policy violation: access to restricted accounts table or api_secret column is forbidden'
    };
  }
  return { valid: true, sanitizedQuery: trimmed };
}

function validateWebhookTargetUrl(targetUrl) {
  let parsed;
  try {
    parsed = new URL(String(targetUrl));
  } catch {
    return { valid: false, status: 400, error: 'Invalid targetUrl format' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, status: 403, error: 'SSRF protection: only HTTP/HTTPS protocols are allowed' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  const isLoopbackOrSpecial =
    hostname === 'localhost' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '::' ||
    hostname.startsWith('::ffff:127.') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.localhost');

  const isPrivateIpv4 =
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);

  const isPrivateIpv6 =
    /^f[cd][0-9a-f]{2}:/i.test(hostname) ||
    /^fe80:/i.test(hostname);

  if (isLoopbackOrSpecial || isPrivateIpv4 || isPrivateIpv6) {
    return {
      valid: false,
      status: 403,
      error: 'SSRF protection: targetUrl points to a forbidden loopback, link-local, or private network address'
    };
  }

  return { valid: true, parsedUrl: parsed };
}

function verifyAccountAccess(db, req, accountId) {
  const accountRow = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!accountRow) {
    return { authorized: true, accountRow: null };
  }
  if (accountRow.tier === 'RESTRICTED') {
    const providedKey = req.headers['x-api-key'];
    if (!providedKey || providedKey !== accountRow.api_secret) {
      return {
        authorized: false,
        status: 403,
        error: 'Restricted account requires valid X-API-Key authentication'
      };
    }
  }
  return { authorized: true, accountRow };
}

function buildPortfolioPayload(db, engine, marketSim, accountId = 'ACC-INST-01') {
  let accountRow = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!accountRow) {
    accountRow = db.prepare('SELECT * FROM accounts LIMIT 1').get();
  }
  const resolvedAccountId = accountRow ? accountRow.id : accountId;

  const tickers = marketSim.getTickers();
  const priceMap = new Map(tickers.map((t) => [t.symbol, t.lastPrice]));

  const rawPositions = db.prepare(`
    SELECT account_id, symbol, qty, avg_entry_price, realized_pnl
    FROM positions
    WHERE account_id = ? AND ABS(qty) > 1e-9
    ORDER BY symbol ASC
  `).all(resolvedAccountId);

  let totalPositionValue = 0;
  let totalUnrealizedPnl = 0;
  let totalRealizedPnl = 0;

  const positions = rawPositions.map((pos) => {
    const qty = Number(pos.qty);
    const avgEntryPrice = Number(pos.avg_entry_price);
    const markPrice = priceMap.get(pos.symbol) ?? avgEntryPrice;
    const marketValue = Number((qty * markPrice).toFixed(2));
    const unrealizedPnl = Number(((markPrice - avgEntryPrice) * qty).toFixed(2));
    const costBasis = Math.abs(qty * avgEntryPrice);
    const unrealizedPnlPct = costBasis > 0 ? Number(((unrealizedPnl / costBasis) * 100).toFixed(2)) : 0;
    const realizedPnl = Number((pos.realized_pnl || 0).toFixed(2));

    totalPositionValue += marketValue;
    totalUnrealizedPnl += unrealizedPnl;
    totalRealizedPnl += realizedPnl;

    return {
      accountId: pos.account_id,
      account_id: pos.account_id,
      symbol: pos.symbol,
      qty,
      size: qty,
      quantity: qty,
      avgEntryPrice,
      avg_entry_price: avgEntryPrice,
      markPrice,
      currentPrice: markPrice,
      marketValue,
      unrealizedPnl,
      unrealizedPnlPct,
      realizedPnl,
      realized_pnl: realizedPnl
    };
  });

  const cashBalance = accountRow ? Number(accountRow.cash_balance.toFixed(2)) : 0;
  const marginUsed = accountRow ? Number(accountRow.margin_used.toFixed(2)) : 0;
  const equity = Number((cashBalance + totalPositionValue).toFixed(2));

  const rawOpenOrders = db.prepare(`
    SELECT * FROM orders
    WHERE account_id = ? AND status IN ('OPEN', 'PARTIAL')
    ORDER BY created_at DESC
  `).all(resolvedAccountId);

  const openOrders = rawOpenOrders.map((o) => ({
    id: o.id,
    accountId: o.account_id,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    price: o.price,
    size: o.size,
    filledSize: o.filled_size,
    remainingSize: Number((o.size - o.filled_size).toFixed(6)),
    status: o.status,
    clientTag: o.client_tag,
    createdAt: o.created_at
  }));

  const rawRecentOrders = db.prepare(`
    SELECT * FROM orders
    WHERE account_id = ? AND filled_size > 0
    ORDER BY created_at DESC
    LIMIT 30
  `).all(resolvedAccountId);

  const recentFills = rawRecentOrders.map((o) => ({
    id: o.id,
    orderId: o.id,
    accountId: o.account_id,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    price: o.price,
    size: o.filled_size,
    filledSize: o.filled_size,
    status: o.status,
    clientTag: o.client_tag,
    timestamp: o.created_at,
    createdAt: o.created_at
  }));

  return {
    account: {
      id: resolvedAccountId,
      name: accountRow ? accountRow.name : 'UNKNOWN',
      tier: accountRow ? accountRow.tier : 'PRIME',
      cashBalance,
      cash_balance: cashBalance,
      equity,
      marginUsed,
      margin_used: marginUsed,
      unrealizedPnl: Number(totalUnrealizedPnl.toFixed(2)),
      realizedPnl: Number(totalRealizedPnl.toFixed(2))
    },
    positions,
    openOrders,
    recentFills
  };
}

function createApiRouter({ db, engine, marketSim, broadcast }) {
  const fallbackAlgoManager = new quantRisk.InstitutionalAlgoManager(engine, db, marketSim);
  const timeMachine = new LobTimeMachine(engine);
  const darkPool = new DarkPoolEngine(engine, db, marketSim);
  let externalAlgoInstance = null;
  let externalSlabInstance = null;

  function resolveAlgoEngine() {
    const { algoMod } = loadOptionalWave2Modules();
    if (!algoMod) return null;
    if (externalAlgoInstance) return externalAlgoInstance;
    try {
      const Ctor =
        algoMod.AlgoExecutionEngine ||
        algoMod.AlgoEngine ||
        algoMod.AlgorithmicEngine ||
        (typeof algoMod === 'function' ? algoMod : null);
      if (Ctor) {
        externalAlgoInstance = new Ctor(engine, db, { marketSim });
      } else {
        externalAlgoInstance = algoMod;
      }
    } catch (_) {
      externalAlgoInstance = algoMod;
    }
    return externalAlgoInstance;
  }

  function resolveSlabMetrics() {
    const { slabMod } = loadOptionalWave2Modules();
    const fallback = quantRisk.computeFallbackSlabMetrics(engine);
    if (!slabMod) return fallback;

    try {
      const SlabCtor =
        slabMod.SlabOrderbook ||
        slabMod.SlabArenaOrderbook ||
        (typeof slabMod === 'function' ? slabMod : null);
      if (SlabCtor) {
        if (!externalSlabInstance) {
          externalSlabInstance = new SlabCtor({ symbol: 'BTC-USD', tickSize: 0.5, lotSize: 0.01, capacity: 65536 });
          // Seed & execute a fast zero-GC micro-benchmark burst so metrics reflect real WASM/Slab activity
          for (let i = 1; i <= 20; i++) {
            externalSlabInstance.submitSlabOrder(i, 'BUY', 94500 - i * 0.5, 0.25);
            externalSlabInstance.submitSlabOrder(100 + i, 'SELL', 94500 + i * 0.5, 0.25);
          }
          externalSlabInstance.submitSlabOrder(501, 'BUY', 94501.0, 0.5);
          externalSlabInstance.submitSlabOrder(502, 'SELL', 94499.0, 0.5);
        }
        const metrics = typeof externalSlabInstance.getSlabMetrics === 'function'
          ? externalSlabInstance.getSlabMetrics()
          : typeof externalSlabInstance.getMetrics === 'function'
            ? externalSlabInstance.getMetrics()
            : {};
        return { ...fallback, ...metrics };
      }
    } catch (_) {
      // Fallback cleanly
    }
    return fallback;
  }

  return async function handleApiRequest(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return true;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (!pathname.startsWith('/api/')) {
      return false;
    }

    try {
      // GET /api/health
      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
          status: 'ok',
          uptime: Number(process.uptime().toFixed(2)),
          engineTickCount: marketSim.tickCount,
          activeSymbolCount: engine.books.size
        });
        return true;
      }

      // GET /api/tickers
      if (req.method === 'GET' && pathname === '/api/tickers') {
        sendJson(res, 200, marketSim.getTickers());
        return true;
      }

      // GET /api/candles?symbol=BTC-USD&limit=120
      if (req.method === 'GET' && pathname === '/api/candles') {
        const symbol = parsedUrl.searchParams.get('symbol') || 'BTC-USD';
        const limit = Math.min(500, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 120));
        const rows = db.prepare(`
          SELECT time, open, high, low, close, volume
          FROM (
            SELECT time, open, high, low, close, volume
            FROM candles
            WHERE symbol = ?
            ORDER BY time DESC
            LIMIT ?
          )
          ORDER BY time ASC
        `).all(symbol, limit);
        sendJson(res, 200, rows);
        return true;
      }

      // GET /api/orderbook?symbol=BTC-USD&depth=15
      if (req.method === 'GET' && pathname === '/api/orderbook') {
        const symbol = parsedUrl.searchParams.get('symbol') || 'BTC-USD';
        const depth = Math.min(50, Math.max(1, Number(parsedUrl.searchParams.get('depth')) || 15));
        const snapshot = engine.getSnapshot(symbol, depth);
        sendJson(res, 200, snapshot);
        return true;
      }

      // GET /api/trades?symbol=BTC-USD&limit=50
      if (req.method === 'GET' && pathname === '/api/trades') {
        const symbol = parsedUrl.searchParams.get('symbol') || 'BTC-USD';
        const limit = Math.min(200, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 50));
        const rows = db.prepare(`
          SELECT id, symbol, price, size, side, maker_order_id, taker_order_id, timestamp
          FROM trades
          WHERE symbol = ?
          ORDER BY timestamp DESC
          LIMIT ?
        `).all(symbol, limit);

        const formatted = rows.map((r) => ({
          id: r.id,
          symbol: r.symbol,
          price: r.price,
          size: r.size,
          side: r.side,
          timestamp: r.timestamp,
          makerOrderId: r.maker_order_id,
          takerOrderId: r.taker_order_id,
          maker_order_id: r.maker_order_id,
          taker_order_id: r.taker_order_id
        }));
        sendJson(res, 200, formatted);
        return true;
      }

      // GET /api/portfolio?accountId=ACC-INST-01
      if (req.method === 'GET' && pathname === '/api/portfolio') {
        const accountId = parsedUrl.searchParams.get('accountId') || 'ACC-INST-01';
        const access = verifyAccountAccess(db, req, accountId);
        if (!access.authorized) {
          sendJson(res, access.status, { error: access.error });
          return true;
        }
        const portfolio = buildPortfolioPayload(db, engine, marketSim, accountId);
        sendJson(res, 200, portfolio);
        return true;
      }

      // GET /api/orders/search?q=...
      if (req.method === 'GET' && pathname === '/api/orders/search') {
        const q = parsedUrl.searchParams.get('q') || '';
        const pattern = `%${q}%`;
        const rows = db.prepare(
          'SELECT * FROM orders WHERE symbol LIKE ? OR client_tag LIKE ? ORDER BY created_at DESC'
        ).all(pattern, pattern);
        sendJson(res, 200, rows);
        return true;
      }

      // POST /api/orders
      if (req.method === 'POST' && pathname === '/api/orders') {
        const body = await readJsonBody(req);
        const symbol = body.symbol || 'BTC-USD';
        const accountId = body.accountId || 'ACC-INST-01';
        const access = verifyAccountAccess(db, req, accountId);
        if (!access.authorized) {
          sendJson(res, access.status, { error: access.error });
          return true;
        }
        const result = engine.submitOrder({
          accountId,
          symbol,
          side: body.side,
          type: body.type,
          price: body.price,
          size: body.size,
          clientTag: body.clientTag || body.client_tag || 'DESK-TICKET'
        });

        if (result.fills && result.fills.length > 0) {
          marketSim.recordExternalFills(symbol, result.fills);
        }

        try {
          timeMachine.recordEvent({
            symbol,
            eventType: result.order.type === 'MARKET' ? 'MARKET_SWEEP' : 'ADD_LIMIT',
            side: result.order.side,
            price: result.order.price,
            size: result.order.size,
            actor: result.order.clientTag || accountId,
            snapshot: engine.getSnapshot(symbol, 15),
            fills: result.fills
          });
        } catch (_) {
          // non-fatal
        }

        db.prepare(`
          INSERT INTO audit_logs (event_type, payload, created_at)
          VALUES (?, ?, ?)
        `).run(
          'ORDER_SUBMITTED',
          JSON.stringify({ orderId: result.order.id, accountId, symbol, side: result.order.side, type: result.order.type, size: result.order.size, fillsCount: result.fills.length }),
          Date.now()
        );

        if (broadcast) {
          broadcast({
            type: 'ORDERBOOK',
            symbol,
            orderbook: engine.getSnapshot(symbol, 15)
          });
          for (const fill of result.fills) {
            broadcast({
              type: 'TRADE',
              trade: {
                id: fill.id,
                symbol: fill.symbol,
                price: fill.price,
                size: fill.size,
                side: fill.side,
                makerOrderId: fill.makerOrderId,
                takerOrderId: fill.takerOrderId,
                timestamp: fill.timestamp
              }
            });
          }
          broadcast({
            type: 'PORTFOLIO_UPDATE',
            accountId
          });
          broadcast({
            type: 'TICK',
            tickers: marketSim.getTickers(),
            timestamp: Date.now()
          });
        }

        sendJson(res, 201, result);
        return true;
      }

      // DELETE /api/orders/:orderId
      if (req.method === 'DELETE' && pathname.startsWith('/api/orders/')) {
        const orderId = decodeURIComponent(pathname.slice('/api/orders/'.length));
        const cancelled = engine.cancelOrder(orderId);
        if (!cancelled) {
          sendJson(res, 404, { error: `Order ${orderId} not found or already closed` });
          return true;
        }

        if (broadcast) {
          if (cancelled.symbol && engine.books.has(cancelled.symbol)) {
            broadcast({
              type: 'ORDERBOOK',
              symbol: cancelled.symbol,
              orderbook: engine.getSnapshot(cancelled.symbol, 15)
            });
          }
          broadcast({
            type: 'PORTFOLIO_UPDATE',
            accountId: cancelled.accountId || cancelled.account_id || 'ACC-INST-01'
          });
        }

        sendJson(res, 200, { status: 'CANCELLED', orderId, order: cancelled });
        return true;
      }

      // POST /api/sql
      if (req.method === 'POST' && pathname === '/api/sql') {
        const body = await readJsonBody(req);
        const query = String(body.query || '').trim();
        if (!query) {
          sendJson(res, 400, { error: 'Query is required', columns: [], rows: [], elapsedMs: 0 });
          return true;
        }

        const validation = validateReadOnlySql(query);
        if (!validation.valid) {
          sendJson(res, validation.status, {
            error: validation.error,
            columns: [],
            rows: [],
            elapsedMs: 0
          });
          return true;
        }

        const t0 = performance.now();
        const rows = db.prepare(validation.sanitizedQuery).all();
        const elapsedMs = Number((performance.now() - t0).toFixed(3));
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

        sendJson(res, 200, {
          columns,
          rows,
          elapsedMs
        });
        return true;
      }

      // POST /api/webhooks/test
      if (req.method === 'POST' && pathname === '/api/webhooks/test') {
        const body = await readJsonBody(req);
        const targetUrl = body.targetUrl || body.url;
        const eventType = body.eventType || 'ORDER_FILL';
        if (!targetUrl) {
          sendJson(res, 400, { error: 'targetUrl is required' });
          return true;
        }

        const urlCheck = validateWebhookTargetUrl(targetUrl);
        if (!urlCheck.valid) {
          sendJson(res, urlCheck.status, { error: urlCheck.error });
          return true;
        }

        const resp = await fetch(urlCheck.parsedUrl.href);
        const text = await resp.text();
        sendJson(res, 200, {
          ok: resp.ok,
          status: resp.status,
          targetUrl: urlCheck.parsedUrl.href,
          eventType,
          bodySnippet: text.slice(0, 2000)
        });
        return true;
      }

      // GET /api/news
      if (req.method === 'GET' && pathname === '/api/news') {
        const limit = Math.min(100, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 25));
        sendJson(res, 200, marketSim.getNews(limit));
        return true;
      }

      // GET /api/quant/risk?accountId=ACC-INST-01&symbol=BTC-USD
      if (req.method === 'GET' && pathname === '/api/quant/risk') {
        const accountId = parsedUrl.searchParams.get('accountId') || 'ACC-INST-01';
        const symbol = parsedUrl.searchParams.get('symbol') || 'BTC-USD';
        const paths = Number(parsedUrl.searchParams.get('paths')) || 10000;
        const access = verifyAccountAccess(db, req, accountId);
        if (!access.authorized) {
          sendJson(res, access.status, { error: access.error });
          return true;
        }

        const report = quantRisk.computeQuantRiskReport({
          db,
          engine,
          marketSim,
          accountId,
          symbol,
          paths
        });
        sendJson(res, 200, report);
        return true;
      }

      // GET /api/algos
      if (req.method === 'GET' && pathname === '/api/algos') {
        const extAlgo = resolveAlgoEngine();
        let list = null;
        if (extAlgo) {
          try {
            if (typeof extAlgo.getAlgos === 'function') list = extAlgo.getAlgos();
            else if (typeof extAlgo.listAlgos === 'function') list = extAlgo.listAlgos();
            else if (typeof extAlgo.getActiveAlgos === 'function') list = extAlgo.getActiveAlgos();
            else if (Array.isArray(extAlgo.algos)) list = extAlgo.algos;
          } catch (_) {
            list = null;
          }
        }
        const fallbackList = fallbackAlgoManager.listAlgos();
        const combined = Array.isArray(list) && list.length > 0 ? list : fallbackList;
        sendJson(res, 200, {
          algos: combined,
          executions: combined,
          count: combined.length
        });
        return true;
      }

      // POST /api/algos
      if (req.method === 'POST' && pathname === '/api/algos') {
        const body = await readJsonBody(req);
        const accountId = body.accountId || 'ACC-INST-01';
        const access = verifyAccountAccess(db, req, accountId);
        if (!access.authorized) {
          sendJson(res, access.status, { error: access.error });
          return true;
        }

        const normalizedBody = {
          ...body,
          strategy: body.strategy || body.type || 'TWAP',
          type: body.type || body.strategy || 'TWAP'
        };
        const extAlgo = resolveAlgoEngine();
        let started = null;
        if (extAlgo) {
          try {
            if (typeof extAlgo.startAlgo === 'function') started = extAlgo.startAlgo(normalizedBody);
            else if (typeof extAlgo.launchAlgo === 'function') started = extAlgo.launchAlgo(normalizedBody);
            else if (typeof extAlgo.executeAlgo === 'function') started = extAlgo.executeAlgo(normalizedBody);
          } catch (_) {
            started = null;
          }
        }
        const finalAlgo = started
          ? { type: normalizedBody.type, strategy: normalizedBody.strategy, ...(started.algo || started) }
          : fallbackAlgoManager.startAlgo(normalizedBody);

        if (broadcast) {
          broadcast({
            type: 'PORTFOLIO_UPDATE',
            accountId
          });
        }

        sendJson(res, 201, {
          status: finalAlgo.status || 'ACTIVE',
          algo: finalAlgo,
          ...finalAlgo
        });
        return true;
      }

      // POST /api/backtest
      if (req.method === 'POST' && pathname === '/api/backtest') {
        const body = await readJsonBody(req);
        const extAlgo = resolveAlgoEngine();
        const { algoMod } = loadOptionalWave2Modules();
        let extResult = null;
        try {
          if (extAlgo && typeof extAlgo.runBacktest === 'function') {
            extResult = extAlgo.runBacktest(body);
          } else if (algoMod && typeof algoMod.runBacktest === 'function') {
            extResult = algoMod.runBacktest(db, body);
          } else if (algoMod && typeof algoMod.runStrategyBacktest === 'function') {
            extResult = algoMod.runStrategyBacktest(db, body);
          }
        } catch (_) {
          extResult = null;
        }

        const baseBacktest = quantRisk.runStrategyBacktest(db, body);
        const merged = extResult && typeof extResult === 'object'
          ? { ...baseBacktest, ...extResult }
          : baseBacktest;

        sendJson(res, 200, merged);
        return true;
      }

      // GET /api/slab-metrics
      if (req.method === 'GET' && pathname === '/api/slab-metrics') {
        const metrics = resolveSlabMetrics();
        sendJson(res, 200, metrics);
        return true;
      }

      // GET /api/options/chain?symbol=BTC-USD&tenor=30D
      if (req.method === 'GET' && pathname === '/api/options/chain') {
        const symbol = parsedUrl.searchParams.get('symbol') || 'BTC-USD';
        const tenor = parsedUrl.searchParams.get('tenor') || '30D';
        const spotParam = parsedUrl.searchParams.get('spot') || parsedUrl.searchParams.get('spotPrice');
        const payload = optionsGreeks.buildOptionsChainAndSurface({
          symbol,
          tenor,
          selectedTenor: tenor,
          spotPrice: spotParam ? Number(spotParam) : undefined,
          engine,
          marketSim
        });
        sendJson(res, 200, payload);
        return true;
      }

      // POST /api/options/solve-iv
      if (req.method === 'POST' && pathname === '/api/options/solve-iv') {
        const body = await readJsonBody(req);
        const symbol = String(body.symbol || 'BTC-USD').toUpperCase();
        const tickers = marketSim.getTickers();
        const tickerMatch = Array.isArray(tickers) ? tickers.find((t) => t.symbol === symbol) : null;
        const S = Number(body.S ?? body.spot ?? body.spotPrice ?? (tickerMatch ? tickerMatch.lastPrice : 94500));
        const K = Number(body.K ?? body.strike ?? body.strikePrice ?? S);
        const T = Number(body.T ?? body.timeToExpiry ?? (30 / 365));
        const r = body.r !== undefined ? Number(body.r) : 0.045;
        const q = body.q !== undefined ? Number(body.q) : 0.0;
        const type = String(body.type ?? body.optionType ?? 'CALL').toUpperCase().startsWith('P') ? 'PUT' : 'CALL';
        const targetPrice = Number(body.targetPrice ?? body.marketPrice ?? body.optionPrice ?? body.price ?? 0);

        if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
          sendJson(res, 400, { error: 'Positive targetPrice / marketPrice is required to solve Implied Volatility' });
          return true;
        }

        const solved = optionsGreeks.solveImpliedVolatility({
          targetPrice,
          S,
          K,
          T,
          r,
          q,
          type
        });
        sendJson(res, 200, {
          symbol,
          S,
          K,
          T,
          r,
          q,
          type,
          ...solved
        });
        return true;
      }

      // POST /api/fix
      if (req.method === 'POST' && pathname === '/api/fix') {
        const body = await readJsonBody(req);
        const { fixMod } = loadOptionalWave3Modules();

        const params = body.buildParams || body;
        const accountId = params.accountId || body.accountId || 'ACC-INST-01';
        const access = verifyAccountAccess(db, req, accountId);
        if (!access.authorized) {
          sendJson(res, access.status, { error: access.error });
          return true;
        }

        const symbol = String(params.symbol || 'BTC-USD').toUpperCase();
        const sideRaw = String(params.side || 'BUY').toUpperCase();
        const side = sideRaw === '2' || sideRaw === 'SELL' ? 'SELL' : 'BUY';
        const fixSide = side === 'SELL' ? '2' : '1';
        const ordTypeRaw = String(params.type || params.ordType || 'LIMIT').toUpperCase();
        const type = ordTypeRaw === '1' || ordTypeRaw === 'MARKET' ? 'MARKET' : 'LIMIT';
        const fixOrdType = type === 'MARKET' ? '1' : '2';

        const tickers = marketSim.getTickers();
        const tickerMatch = Array.isArray(tickers) ? tickers.find((t) => t.symbol === symbol) : null;
        const price = Number(params.price ?? (tickerMatch ? tickerMatch.lastPrice : 94500));
        const size = Number(params.size ?? params.orderQty ?? 0.25);
        const clOrdId = String(params.clOrdId || `FIX-${Date.now()}`);

        let rawFix = body.rawFix || '';
        if (!rawFix) {
          if (fixMod && typeof fixMod.buildFixMessage === 'function') {
            rawFix = fixMod.buildFixMessage(
              'D',
              {
                11: clOrdId,
                55: symbol,
                54: fixSide,
                38: size,
                40: fixOrdType,
                44: price,
                59: '1'
              },
              {
                senderCompId: params.senderCompId || 'BUYSIDE-DMA',
                targetCompId: params.targetCompId || 'ARGUS-OMEGA',
                msgSeqNum: params.msgSeqNum || 1
              }
            );
          } else {
            const inner = `35=D|49=BUYSIDE-DMA|56=ARGUS-OMEGA|34=1|52=${new Date().toISOString()}|11=${clOrdId}|55=${symbol}|54=${fixSide}|38=${size}|40=${fixOrdType}|44=${price}|59=1|`;
            const head = `8=FIX.4.4|9=${inner.length}|${inner}`;
            rawFix = `${head}10=${computeFallbackFixChecksum(head)}|`;
          }
        }

        let parsedInbound = null;
        if (fixMod && typeof fixMod.parseFixMessage === 'function') {
          parsedInbound = fixMod.parseFixMessage(rawFix);
        } else {
          const m = rawFix.match(/^(.*)10=(\d{3})\|?$/);
          const expectedChecksum = m ? computeFallbackFixChecksum(m[1]) : '000';
          const providedChecksum = m ? m[2] : '';
          parsedInbound = {
            raw: rawFix,
            validChecksum: Boolean(m && expectedChecksum === providedChecksum),
            expectedChecksum,
            providedChecksum
          };
        }

        // Execute 35=D order on matching engine unless explicitly disabled
        let orderResult = null;
        if (body.executeOrder !== false && parsedInbound.validChecksum !== false) {
          try {
            orderResult = engine.submitOrder({
              accountId,
              symbol,
              side,
              type,
              price,
              size,
              clientTag: clOrdId
            });
            if (orderResult.fills && orderResult.fills.length > 0) {
              marketSim.recordExternalFills(symbol, orderResult.fills);
            }
          } catch (_) {
            orderResult = null;
          }
        }

        const orderIdStr = orderResult?.order?.id || `ORD-${Date.now()}`;
        const orderIdNum = Number(String(orderIdStr).replace(/\D/g, '').slice(-9)) || 987654321;
        const filledQty = orderResult?.order?.filledSize ?? size;
        const leavesQty = Math.max(0, size - filledQty);
        const ordStatus = leavesQty === 0 ? '2' : filledQty > 0 ? '1' : '0';

        let executionReportFix = '';
        if (fixMod && typeof fixMod.buildExecutionReport === 'function') {
          executionReportFix = fixMod.buildExecutionReport({
            clOrdId,
            orderId: orderIdStr,
            execId: `EXEC-${Date.now()}`,
            ordStatus,
            execType: ordStatus === '2' ? 'F' : '0',
            symbol,
            side: fixSide,
            orderQty: size,
            cumQty: filledQty,
            leavesQty,
            lastPx: price,
            avgPx: price
          });
        }
        if (!executionReportFix || !executionReportFix.includes('35=8')) {
          const erBody = `35=8|49=ARGUS-OMEGA|56=BUYSIDE-DMA|34=2|52=${new Date().toISOString()}|37=${orderIdStr}|11=${clOrdId}|17=EXEC-${Date.now()}|150=${ordStatus === '2' ? 'F' : '0'}|39=${ordStatus}|55=${symbol}|54=${fixSide}|38=${size}|14=${filledQty}|151=${leavesQty}|31=${price}|6=${price}|`;
          const erHead = `8=FIX.4.4|9=${erBody.length}|${erBody}`;
          executionReportFix = `${erHead}10=${computeFallbackFixChecksum(erHead)}|`;
        }

        // Encode 40-Byte Binary SBE Frame
        let sbeBuf;
        let sbeDecoded;
        if (fixMod && typeof fixMod.encodeSbeOrder === 'function') {
          const rawEncoded = fixMod.encodeSbeOrder({
            templateId: 101,
            orderIdNum,
            price,
            size,
            side,
            type,
            symbol
          });
          sbeBuf = Buffer.isBuffer(rawEncoded)
            ? rawEncoded
            : Buffer.from(rawEncoded.buffer || rawEncoded, rawEncoded.byteOffset || 0, rawEncoded.byteLength || 40);
          sbeDecoded = typeof fixMod.decodeSbeOrder === 'function'
            ? fixMod.decodeSbeOrder(rawEncoded)
            : decodeFallbackSbe40(sbeBuf);
        } else {
          sbeBuf = encodeFallbackSbe40({ templateId: 101, orderIdNum, price, size, side, type, symbol });
          sbeDecoded = decodeFallbackSbe40(sbeBuf);
        }

        if (sbeBuf.length !== 40) {
          sbeBuf = encodeFallbackSbe40({ templateId: 101, orderIdNum, price, size, side, type, symbol });
        }

        const sbeHex = sbeBuf.toString('hex');
        const sbeHexSpaced = (sbeHex.match(/.{1,2}/g) || []).join(' ').toUpperCase();

        sendJson(res, 200, {
          status: 'OK',
          validChecksum: parsedInbound.validChecksum !== false,
          inboundFix: rawFix,
          parsedInbound,
          executionReport: executionReportFix,
          executionReportFix,
          sbeHex,
          sbeFrameHex: sbeHex,
          binarySbeHex: sbeHex,
          sbeHexSpaced,
          sbe: {
            byteLength: 40,
            hex: sbeHex,
            frameHex: sbeHex,
            hexDump: sbeHexSpaced,
            decoded: sbeDecoded
          },
          orderResult
        });
        return true;
      }

      // POST /api/sor/route
      if (req.method === 'POST' && pathname === '/api/sor/route') {
        const body = await readJsonBody(req);
        const { sorMod } = loadOptionalWave3Modules();
        const symbol = String(body.symbol || 'BTC-USD').toUpperCase();
        const side = String(body.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
        const totalSize = Math.max(0.01, Number(body.totalSize ?? body.size ?? 10.0));
        const urgency = String(body.urgency || 'NORMAL').toUpperCase();

        let extPlan = null;
        if (sorMod) {
          try {
            if (typeof sorMod.routeOrder === 'function') {
              extPlan = sorMod.routeOrder({ symbol, side, totalSize, size: totalSize, urgency, engine, marketSim });
            } else if (typeof sorMod.SmartOrderRouter === 'function') {
              const router = new sorMod.SmartOrderRouter(engine, marketSim);
              extPlan = router.routeOrder({ symbol, side, totalSize, size: totalSize, urgency });
            }
          } catch (_) {
            extPlan = null;
          }
        }

        if (extPlan && Array.isArray(extPlan.allocations || extPlan.legs || extPlan.venues)) {
          const allocations = extPlan.allocations || extPlan.legs || extPlan.venues;
          sendJson(res, 200, {
            symbol,
            side,
            totalSize,
            urgency,
            allocations,
            legs: allocations,
            venues: allocations,
            ...extPlan
          });
          return true;
        }

        // Fallback Multi-Venue SOR across ARGUS-LIT, CME-GLOBEX, BINANCE-INST, LMAX-LD4
        const tickers = marketSim.getTickers();
        const tickerMatch = Array.isArray(tickers) ? tickers.find((t) => t.symbol === symbol) : null;
        const refPx = tickerMatch ? Number(tickerMatch.lastPrice) : 94500;
        const dir = side === 'BUY' ? 1 : -1;

        const venueSpecs = [
          { venue: 'ARGUS-LIT', share: 0.36, feeBps: 1.5, latencyMs: 0.42, impactFactor: 0.00018 },
          { venue: 'CME-GLOBEX', share: 0.28, feeBps: 2.2, latencyMs: 1.85, impactFactor: 0.00022 },
          { venue: 'BINANCE-INST', share: 0.22, feeBps: 2.0, latencyMs: 3.10, impactFactor: 0.00025 },
          { venue: 'LMAX-LD4', share: 0.14, feeBps: 1.2, latencyMs: 1.15, impactFactor: 0.00028 }
        ];

        let remaining = totalSize;
        const allocations = venueSpecs.map((v, idx) => {
          const legSize = idx === venueSpecs.length - 1
            ? Number(remaining.toFixed(6))
            : Number((totalSize * v.share).toFixed(6));
          remaining = Math.max(0, remaining - legSize);
          const fillPx = Number((refPx * (1 + dir * (v.impactFactor * Math.sqrt(legSize) + v.feeBps / 10000))).toFixed(2));
          return {
            venue: v.venue,
            size: legSize,
            allocatedSize: legSize,
            qty: legSize,
            sharePct: Number((v.share * 100).toFixed(1)),
            expectedFillPrice: fillPx,
            feeBps: v.feeBps,
            latencyMs: v.latencyMs,
            notionalUsd: Number((legSize * fillPx).toFixed(2))
          };
        });

        const totalNotional = allocations.reduce((acc, a) => acc + a.size * a.expectedFillPrice, 0);
        const vwapEffectivePrice = Number((totalNotional / totalSize).toFixed(2));
        const singleVenueSweepPrice = Number((refPx * (1 + dir * 0.0018 * Math.sqrt(totalSize))).toFixed(2));
        const savingsBps = Number(((Math.abs(singleVenueSweepPrice - vwapEffectivePrice) / refPx) * 10000).toFixed(2));

        sendJson(res, 200, {
          symbol,
          side,
          totalSize,
          urgency,
          referencePrice: refPx,
          vwapEffectivePrice,
          effectivePrice: vwapEffectivePrice,
          singleVenueSweepPrice,
          singleVenuePrice: singleVenueSweepPrice,
          savingsBps,
          estimatedSavingsUsd: Number((Math.abs(singleVenueSweepPrice - vwapEffectivePrice) * totalSize).toFixed(2)),
          allocations,
          legs: allocations,
          venues: allocations,
          timestamp: Date.now()
        });
        return true;
      }

      // GET /api/arbitrage
      if (req.method === 'GET' && pathname === '/api/arbitrage') {
        const symbol = parsedUrl.searchParams.get('symbol') || 'BTC-USD';
        const { sorMod } = loadOptionalWave3Modules();

        if (sorMod) {
          const scanFn = sorMod.scanArbitrage || sorMod.detectArbitrage;
          if (typeof scanFn === 'function') {
            try {
              const extArb = scanFn({ symbol, engine, marketSim });
              const list = Array.isArray(extArb)
                ? extArb
                : extArb.opportunities || extArb.spatial || extArb.arbitrage || [];
              if (list.length > 0) {
                sendJson(res, 200, Array.isArray(extArb) ? { symbol, opportunities: extArb, count: extArb.length } : extArb);
                return true;
              }
            } catch (_) {
              // Fallback below
            }
          }
        }

        const tickers = marketSim.getTickers();
        const tickerMatch = Array.isArray(tickers) ? tickers.find((t) => t.symbol === symbol) : null;
        const mid = tickerMatch ? Number(tickerMatch.lastPrice) : 94500;

        const opportunities = [
          {
            id: `ARB-SPATIAL-${symbol}-1`,
            type: 'SPATIAL_CROSS_EXCHANGE',
            symbol,
            buyVenue: 'LMAX-LD4',
            sellVenue: 'BINANCE-INST',
            buyAskPrice: Number((mid * 0.9993).toFixed(2)),
            sellBidPrice: Number((mid * 1.0008).toFixed(2)),
            grossSpreadBps: 15.0,
            totalFeeBps: 3.2,
            netEdgeBps: 11.8,
            netSpreadBps: 11.8,
            maxExecutableSize: symbol === 'BTC-USD' ? 3.5 : 25.0,
            expectedProfitUsd: Number((mid * 0.00118 * (symbol === 'BTC-USD' ? 3.5 : 25.0)).toFixed(2)),
            confidence: 'HIGH'
          },
          {
            id: `ARB-BASIS-${symbol}-2`,
            type: 'CASH_AND_CARRY_BASIS',
            symbol,
            buyVenue: 'ARGUS-LIT (SPOT)',
            sellVenue: 'CME-GLOBEX (PERP/FUT)',
            buyAskPrice: Number(mid.toFixed(2)),
            sellBidPrice: Number((mid * 1.0115).toFixed(2)),
            grossSpreadBps: 115.0,
            totalFeeBps: 3.7,
            netEdgeBps: 111.3,
            netSpreadBps: 111.3,
            annualizedCarryPct: 14.28,
            maxExecutableSize: symbol === 'BTC-USD' ? 5.0 : 40.0,
            expectedProfitUsd: Number((mid * 0.01113 * (symbol === 'BTC-USD' ? 5.0 : 40.0)).toFixed(2)),
            confidence: 'INSTITUTIONAL'
          }
        ];

        sendJson(res, 200, {
          symbol,
          referencePrice: mid,
          opportunities,
          count: opportunities.length,
          timestamp: Date.now()
        });
        return true;
      }

      // =======================================================================
      // WAVE 4: MACRO YIELD CURVE (NSS), FIXED INCOME BOND DESK,
      //         LOB REPLAY TIME-MACHINE & DARK POOL CROSSING NETWORK
      // =======================================================================

      // GET /api/macro/yield-curve?regime=NORMAL_STEEP&shiftBps=0
      if (req.method === 'GET' && pathname === '/api/macro/yield-curve') {
        const regime = parsedUrl.searchParams.get('regime') || 'NORMAL_STEEP';
        const parallelShiftBps = Number(parsedUrl.searchParams.get('shiftBps') || parsedUrl.searchParams.get('parallelShiftBps') || 0);
        const beta0 = parsedUrl.searchParams.get('beta0') !== null ? Number(parsedUrl.searchParams.get('beta0')) : undefined;
        const beta1 = parsedUrl.searchParams.get('beta1') !== null ? Number(parsedUrl.searchParams.get('beta1')) : undefined;
        const beta2 = parsedUrl.searchParams.get('beta2') !== null ? Number(parsedUrl.searchParams.get('beta2')) : undefined;
        const beta3 = parsedUrl.searchParams.get('beta3') !== null ? Number(parsedUrl.searchParams.get('beta3')) : undefined;
        const lambda1 = parsedUrl.searchParams.get('lambda1') !== null ? Number(parsedUrl.searchParams.get('lambda1')) : undefined;
        const lambda2 = parsedUrl.searchParams.get('lambda2') !== null ? Number(parsedUrl.searchParams.get('lambda2')) : undefined;

        const report = yieldCurveFixedIncome.buildMacroBondDeskReport({
          regime,
          parallelShiftBps,
          beta0,
          beta1,
          beta2,
          beta3,
          lambda1,
          lambda2
        });
        sendJson(res, 200, report);
        return true;
      }

      // POST /api/macro/bond-price
      if (req.method === 'POST' && pathname === '/api/macro/bond-price') {
        const body = await readJsonBody(req);
        let ytmResult = null;
        let resolvedYtm = body.ytm ?? body.yieldToMaturity ?? body.yield;

        if ((resolvedYtm === undefined || resolvedYtm === null) && (body.targetPrice || body.cleanPrice || body.dirtyPrice || body.marketPrice)) {
          ytmResult = yieldCurveFixedIncome.solveBondYtm({
            ...body,
            targetPrice: body.targetPrice ?? body.cleanPrice ?? body.marketPrice
          });
          resolvedYtm = ytmResult.ytm;
        }

        const bondAnalytics = yieldCurveFixedIncome.priceBond({
          ...body,
          ytm: resolvedYtm
        });

        const zSpreadResult = yieldCurveFixedIncome.solveBondZSpread({
          ...body,
          dirtyPrice: bondAnalytics.dirtyPrice
        });

        const shockAnalysis = yieldCurveFixedIncome.shockBondPrice({
          ...body,
          ytm: bondAnalytics.ytm
        });

        sendJson(res, 200, {
          ...bondAnalytics,
          zSpread: zSpreadResult.zSpread,
          zSpreadBps: zSpreadResult.zSpreadBps,
          ytmSolver: ytmResult,
          shockAnalysis,
          scenarios: shockAnalysis.scenarios
        });
        return true;
      }

      // POST /api/macro/calibrate-nss
      if (req.method === 'POST' && pathname === '/api/macro/calibrate-nss') {
        const body = await readJsonBody(req);
        const observations = body.observations || body.points || body.yields || [];
        const calibrated = yieldCurveFixedIncome.calibrateNelsonSiegelSvensson(observations, body);
        const curve = yieldCurveFixedIncome.buildYieldCurve({
          regime: 'CUSTOM_CALIBRATED',
          ...calibrated
        });
        sendJson(res, 200, {
          ...calibrated,
          curve: curve.points,
          spreads: curve.spreads
        });
        return true;
      }

      // GET /api/replay/timeline?symbol=BTC-USD&limit=80
      if (req.method === 'GET' && pathname === '/api/replay/timeline') {
        const symbol = parsedUrl.searchParams.get('symbol') || 'BTC-USD';
        const limit = Number(parsedUrl.searchParams.get('limit')) || 80;
        const timeline = timeMachine.getTimeline(symbol, limit);
        sendJson(res, 200, timeline);
        return true;
      }

      // GET /api/replay/state?symbol=BTC-USD&seq=30
      if (req.method === 'GET' && pathname === '/api/replay/state') {
        const symbol = parsedUrl.searchParams.get('symbol') || 'BTC-USD';
        const seqParam = parsedUrl.searchParams.get('seq');
        const tsParam = parsedUrl.searchParams.get('timestamp');

        const state = tsParam !== null && seqParam === null
          ? timeMachine.seekToTimestamp(symbol, Number(tsParam))
          : timeMachine.seekToSequence(symbol, seqParam !== null ? Number(seqParam) : null);

        sendJson(res, 200, state);
        return true;
      }

      // POST /api/replay/seek
      if (req.method === 'POST' && pathname === '/api/replay/seek') {
        const body = await readJsonBody(req);
        const symbol = body.symbol || 'BTC-USD';
        const state = body.timestamp !== undefined && body.seq === undefined
          ? timeMachine.seekToTimestamp(symbol, Number(body.timestamp))
          : timeMachine.seekToSequence(symbol, body.seq !== undefined ? Number(body.seq) : null);

        sendJson(res, 200, state);
        return true;
      }

      // POST /api/replay/record
      if (req.method === 'POST' && pathname === '/api/replay/record') {
        const body = await readJsonBody(req);
        const recorded = timeMachine.recordEvent(body);
        sendJson(res, 201, recorded);
        return true;
      }

      // GET /api/darkpool/status?symbol=BTC-USD
      if (req.method === 'GET' && pathname === '/api/darkpool/status') {
        const symbol = parsedUrl.searchParams.get('symbol') || 'BTC-USD';
        const status = darkPool.getStatus(symbol);
        sendJson(res, 200, status);
        return true;
      }

      // POST /api/darkpool/orders
      if (req.method === 'POST' && pathname === '/api/darkpool/orders') {
        const body = await readJsonBody(req);
        const accountId = body.accountId || 'ACC-INST-01';
        const access = verifyAccountAccess(db, req, accountId);
        if (!access.authorized) {
          sendJson(res, access.status, { error: access.error });
          return true;
        }

        const result = darkPool.submitDarkOrder({
          ...body,
          accountId
        });

        if (result.fills && result.fills.length > 0) {
          const symbol = result.order.symbol;
          try {
            timeMachine.recordEvent({
              symbol,
              eventType: 'DARK_MIDPOINT_CROSS',
              side: result.order.side,
              price: result.executionPrice,
              size: result.crossedVolume,
              actor: 'ARGUS-DARK-ATS'
            });
          } catch (_) {
            // ignore
          }
          if (broadcast) {
            for (const fill of result.fills) {
              broadcast({
                type: 'DARK_TRADE',
                trade: fill
              });
            }
          }
        }

        sendJson(res, 201, result);
        return true;
      }

      sendJson(res, 404, { error: `Unknown API endpoint: ${req.method} ${pathname}` });
      return true;
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Internal Server Error' });
      return true;
    }
  };
}

module.exports = {
  createApiRouter,
  buildPortfolioPayload
};
