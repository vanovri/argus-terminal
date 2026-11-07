'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { WebSocketServer, WebSocket } = require('ws');

const { initDatabase } = require('../db/database');
const { MatchingEngine } = require('../engine/orderbook');
const { MarketSimulator } = require('../engine/marketSim');
const { logDiagnostic } = require('../engine/validation');
const { createApiRouter } = require('./routes');

const PUBLIC_DIR = path.resolve(__dirname, '../../public');

/** @type {Record<string, string>} */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/**
 * Serves static files from `PUBLIC_DIR` with strict path-traversal containment and URIError protection.
 * @param {any} req
 * @param {any} res
 */
function serveStaticFile(req, res) {
  let parsedUrl;
  let relPath;
  try {
    parsedUrl = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
    relPath = decodeURIComponent(parsedUrl.pathname);
  } catch (err) {
    logDiagnostic('server', 'malformed_static_url', err);
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request: malformed URL or percent-encoding');
    return;
  }

  if (relPath.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  if (relPath === '/' || relPath === '') {
    relPath = '/index.html';
  }

  // Resolve against PUBLIC_DIR and enforce strict path.sep boundary to block sibling-prefix traversal (e.g. /../public-evil)
  const normalizedRel = relPath.replace(/^[/\\]+/, '');
  const safePath = path.resolve(PUBLIC_DIR, normalizedRel);
  if (safePath !== PUBLIC_DIR && !safePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(safePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    const stream = fs.createReadStream(safePath);
    stream.on('error', (streamErr) => {
      logDiagnostic('server', 'static_stream_error', streamErr);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal Server Error');
    });
    stream.pipe(res);
  });
}

/**
 * Handles an incoming WebSocket message from a terminal client.
 * @param {any} ws
 * @param {Buffer|string} raw
 * @param {Record<string, any>} engine
 */
function handleWsClientMessage(ws, raw, engine) {
  try {
    const msg = JSON.parse(raw.toString('utf8'));
    if (msg.type === 'SUBSCRIBE' && msg.symbol && engine.books.has(msg.symbol)) {
      ws.subscribedSymbol = msg.symbol;
      ws.send(JSON.stringify({
        type: 'ORDERBOOK',
        symbol: msg.symbol,
        orderbook: engine.getSnapshot(msg.symbol, 15)
      }));
    } else if (msg.type === 'COMMAND' && typeof msg.command === 'string') {
      const cleaned = msg.command.replace(/<GO>/gi, '').trim().toUpperCase();
      const token = cleaned.split(/\s+/)[0];
      if (engine.books.has(token)) {
        ws.subscribedSymbol = token;
        ws.send(JSON.stringify({
          type: 'ORDERBOOK',
          symbol: token,
          orderbook: engine.getSnapshot(token, 15)
        }));
      }
      ws.send(JSON.stringify({
        type: 'COMMAND_ACK',
        command: msg.command,
        symbol: engine.books.has(token) ? token : null,
        timestamp: Date.now()
      }));
    }
  } catch (err) {
    logDiagnostic('ws', 'invalid_client_message', err);
  }
}

/**
 * Attaches MarketSimulator event listeners to broadcast real-time updates to WebSocket clients.
 * @param {Record<string, any>} marketSim
 * @param {(payload: any, filterFn?: ((client: any) => boolean) | null) => void} broadcast
 */
function attachMarketSimBroadcasters(marketSim, broadcast) {
  marketSim.on('tick', ({ tickers, timestamp }) => {
    broadcast({ type: 'TICK', tickers, timestamp });
  });

  marketSim.on('orderbook', ({ symbol, orderbook }) => {
    broadcast(
      { type: 'ORDERBOOK', symbol, orderbook },
      (client) => !client.subscribedSymbol || client.subscribedSymbol === symbol
    );
  });

  marketSim.on('trade', (trade) => {
    broadcast({ type: 'TRADE', trade });
  });

  marketSim.on('candle', ({ symbol, candle }) => {
    broadcast({ type: 'CANDLE', symbol, candle });
  });

  marketSim.on('news', (item) => {
    broadcast({ type: 'NEWS', item });
  });
}

/**
 * Creates and starts (unless `autoStart === false`) an Argus Terminal HTTP + WebSocket server instance.
 * @param {{ port?: number, dbMemory?: boolean, simIntervalMs?: number, autoStart?: boolean }} [options={}]
 */
function createArgusServer(options = {}) {
  const requestedPort = options.port !== undefined ? Number(options.port) : Number(process.env.PORT || 3400);
  const dbMemory = options.dbMemory !== undefined ? Boolean(options.dbMemory) : process.env.ARGUS_DB_MEMORY === '1';
  const simIntervalMs = options.simIntervalMs || 400;

  const db = initDatabase({ memory: dbMemory });
  const engine = new MatchingEngine(db);
  const marketSim = new MarketSimulator(engine, db);

  /** @type {WebSocketServer | null} */
  let wss = null;

  function broadcast(payload, filterFn = null) {
    if (!wss) return;
    const message = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        if (!filterFn || filterFn(client)) {
          client.send(message);
        }
      }
    }
  }

  const handleApiRequest = createApiRouter({
    db,
    engine,
    marketSim,
    broadcast
  });

  const server = http.createServer(async (req, res) => {
    const handled = await handleApiRequest(req, res);
    if (!handled) {
      serveStaticFile(req, res);
    }
  });

  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.subscribedSymbol = null;

    ws.send(JSON.stringify({
      type: 'SNAPSHOT',
      tickers: marketSim.getTickers(),
      news: marketSim.getNews(20)
    }));

    ws.send(JSON.stringify({
      type: 'ORDERBOOK',
      symbol: 'BTC-USD',
      orderbook: engine.getSnapshot('BTC-USD', 15)
    }));

    ws.on('message', (raw) => handleWsClientMessage(ws, raw, engine));
  });

  attachMarketSimBroadcasters(marketSim, broadcast);

  let listenPromise = null;

  const controller = {
    server,
    wss,
    db,
    engine,
    marketSim,
    port: requestedPort,
    get url() {
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : controller.port;
      return `http://127.0.0.1:${actualPort}`;
    },
    start() {
      if (listenPromise) return listenPromise;
      listenPromise = new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            controller.port = addr.port;
          }
          marketSim.start(simIntervalMs);
          resolve(controller);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(requestedPort, '127.0.0.1');
      });
      return listenPromise;
    },
    async stop() {
      marketSim.stop();
      if (typeof handleApiRequest.close === 'function') {
        handleApiRequest.close();
      }
      if (wss) {
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch (err) {
            logDiagnostic('ws', 'client_terminate_error', err);
          }
        }
        await new Promise((resolve) => wss.close(() => resolve(undefined)));
      }
      if (server.listening) {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
      }
      listenPromise = null;
    },
    async close() {
      return controller.stop();
    }
  };

  if (options.autoStart !== false) {
    const p = controller.start();
    Object.assign(p, controller);
    return p;
  }

  return controller;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3400);
  createArgusServer({ port }).then((app) => {
    console.log(`[ARGUS TERMINAL] Local server & simulated matching engine online at http://localhost:${app.port}`);
  }).catch((err) => {
    console.error('[ARGUS TERMINAL] Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = {
  createArgusServer,
  serveStaticFile,
  PUBLIC_DIR
};
