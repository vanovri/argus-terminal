'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { WebSocketServer, WebSocket } = require('ws');

const { initDatabase } = require('../db/database');
const { MatchingEngine } = require('../engine/orderbook');
const { MarketSimulator } = require('../engine/marketSim');
const { createApiRouter } = require('./routes');

const PUBLIC_DIR = path.resolve(__dirname, '../../public');

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

function serveStaticFile(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let relPath = decodeURIComponent(parsedUrl.pathname);
  if (relPath === '/' || relPath === '') {
    relPath = '/index.html';
  }

  const safePath = path.normalize(path.join(PUBLIC_DIR, relPath));
  if (!safePath.startsWith(PUBLIC_DIR)) {
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
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal Server Error');
    });
    stream.pipe(res);
  });
}

function createArgusServer(options = {}) {
  const requestedPort = options.port !== undefined ? Number(options.port) : Number(process.env.PORT || 3400);
  const dbMemory = options.dbMemory !== undefined ? Boolean(options.dbMemory) : process.env.ARGUS_DB_MEMORY === '1';
  const simIntervalMs = options.simIntervalMs || 400;

  const db = initDatabase({ memory: dbMemory });
  const engine = new MatchingEngine(db);
  const marketSim = new MarketSimulator(engine, db);

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

    // Send initial SNAPSHOT on connect
    ws.send(JSON.stringify({
      type: 'SNAPSHOT',
      tickers: marketSim.getTickers(),
      news: marketSim.getNews(20)
    }));

    // Also send initial BTC-USD orderbook snapshot
    ws.send(JSON.stringify({
      type: 'ORDERBOOK',
      symbol: 'BTC-USD',
      orderbook: engine.getSnapshot('BTC-USD', 15)
    }));

    ws.on('message', (raw) => {
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
      } catch (_) {
        // Ignore malformed client WS messages
      }
    });
  });

  // Forward MarketSimulator events to WebSocket clients
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
      if (wss) {
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch (_) {
            // ignore
          }
        }
        await new Promise((resolve) => wss.close(() => resolve()));
      }
      if (server.listening) {
        await new Promise((resolve) => server.close(() => resolve()));
      }
      listenPromise = null;
    },
    async close() {
      return controller.stop();
    }
  };

  if (options.autoStart !== false) {
    const p = controller.start();
    // Attach controller properties onto the Promise so both sync and awaited usage work seamlessly
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
  createArgusServer
};
