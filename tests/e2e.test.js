/**
 * ARGUS TERMINAL — Automated End-to-End QA & Verification Suite
 * Covers:
 *   1. Server Bootstrap (createArgusServer import + child_process fallback)
 *   2. Static & Modern Web UI Compliance (index.html, CSS, JS, <dialog closedby="any">, role="region", <canvas>)
 *   3. REST Market Data & Seeded SQLite State (/api/health, /api/tickers, /api/candles, /api/orderbook)
 *   4. Matching Engine & Order Lifecycle (/api/portfolio, LIMIT order rest & cancel, MARKET order fill & trade/position update)
 *   5. SQL Analytics Console & Macro News Wire (/api/sql, /api/news)
 *   6. Real-Time WebSocket Multiplexer (ws://localhost:<port>/ws SNAPSHOT + TICK/ORDERBOOK streaming)
 */

(async () => {
  const assert = (await import('node:assert/strict')).default;
  const http = (await import('node:http')).default;
  const path = (await import('node:path')).default;
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const wsModule = await import('ws');
  const WebSocket = wsModule.WebSocket || wsModule.default;

  const __filenameResolved =
    typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const __dirnameResolved =
    typeof __dirname !== 'undefined' ? __dirname : path.dirname(__filenameResolved);
  const ROOT_DIR = path.resolve(__dirnameResolved, '..');
  const SERVER_ENTRY = path.join(ROOT_DIR, 'src', 'server', 'index.js');

  let baseUrl = '';
  let wsUrl = '';
  let activePort = Number(process.env.TEST_PORT || 3499);
  let serverInstance = null;
  let childProc = null;

  let passCount = 0;
  let failCount = 0;

  async function runTest(name, fn) {
    try {
      await fn();
      passCount++;
      console.log(`[PASS] ${name}`);
    } catch (err) {
      failCount++;
      console.error(`[FAIL] ${name}`);
      console.error(`       ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : err}`);
    }
  }

  function httpRequest(method, urlPath, body = null) {
    return new Promise((resolve, reject) => {
      const target = new URL(urlPath, baseUrl);
      const payload = body !== null ? JSON.stringify(body) : null;
      const headers = {
        Accept: 'application/json, text/html, text/css, application/javascript, */*',
      };
      if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.pathname + target.search,
          method,
          headers,
          timeout: 5000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = JSON.parse(raw);
            } catch {
              // Non-JSON response
            }
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text: raw,
              json,
            });
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`HTTP request timeout: ${method} ${urlPath}`));
      });

      if (payload !== null) {
        req.write(payload);
      }
      req.end();
    });
  }

  async function isServerHealthy(port) {
    try {
      const prevBase = baseUrl;
      baseUrl = `http://127.0.0.1:${port}`;
      const res = await httpRequest('GET', '/api/health');
      baseUrl = prevBase;
      return res.status === 200 && res.json && String(res.json.status).toLowerCase() === 'ok';
    } catch {
      return false;
    }
  }

  async function waitForHealth(port, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isServerHealthy(port)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }

  async function startArgusTestServer() {
    process.env.ARGUS_DB_MEMORY = '1';
    process.env.PORT = String(activePort);

    try {
      const serverUrl = new URL(`file:///${SERVER_ENTRY.replace(/\\/g, '/')}`).href;
      const mod = await import(serverUrl);
      const createArgusServer =
        mod.createArgusServer || (mod.default && mod.default.createArgusServer);

      // Check if importing the module already started the server on activePort
      if (await waitForHealth(activePort, 600)) {
        baseUrl = `http://127.0.0.1:${activePort}`;
        wsUrl = `ws://127.0.0.1:${activePort}/ws`;
        serverInstance = mod.server || (mod.default && mod.default.server) || null;
        return;
      }

      if (typeof createArgusServer === 'function') {
        let created = null;
        try {
          created = await createArgusServer({
            port: activePort,
            inMemory: true,
            dbPath: ':memory:',
          });
        } catch {
          created = await createArgusServer(activePort);
        }

        serverInstance = created;
        const rawHttpServer =
          created && created.server
            ? created.server
            : created && typeof created.listen === 'function'
            ? created
            : null;

        if (created && typeof created.start === 'function') {
          const started = await created.start(activePort);
          if (started && typeof started.port === 'number') {
            activePort = started.port;
          }
        } else if (rawHttpServer && !rawHttpServer.listening) {
          await new Promise((resolve, reject) => {
            rawHttpServer.once('error', reject);
            rawHttpServer.listen(activePort, '127.0.0.1', resolve);
          });
        }

        if (rawHttpServer && typeof rawHttpServer.address === 'function') {
          const addr = rawHttpServer.address();
          if (addr && typeof addr === 'object' && addr.port) {
            activePort = addr.port;
          }
        } else if (created && typeof created.port === 'number') {
          activePort = created.port;
        }

        if (await waitForHealth(activePort, 4000)) {
          baseUrl = `http://127.0.0.1:${activePort}`;
          wsUrl = `ws://127.0.0.1:${activePort}/ws`;
          return;
        }
      }
    } catch {
      // Fallback to child process spawn below
    }

    // Fallback: spawn src/server/index.js as a child process
    activePort = Number(process.env.TEST_PORT || 3499);
    childProc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PORT: String(activePort),
        ARGUS_DB_MEMORY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const healthy = await waitForHealth(activePort, 8000);
    if (!healthy) {
      throw new Error(`Argus server failed to become healthy on port ${activePort}`);
    }
    baseUrl = `http://127.0.0.1:${activePort}`;
    wsUrl = `ws://127.0.0.1:${activePort}/ws`;
  }

  async function stopArgusTestServer() {
    try {
      if (serverInstance) {
        if (typeof serverInstance.close === 'function') {
          await serverInstance.close();
        } else if (typeof serverInstance.stop === 'function') {
          await serverInstance.stop();
        } else if (serverInstance.server && typeof serverInstance.server.close === 'function') {
          await new Promise((resolve) => serverInstance.server.close(resolve));
        }
      }
    } catch {
      // Ignore shutdown errors
    }

    if (childProc && !childProc.killed) {
      try {
        childProc.kill('SIGTERM');
      } catch {
        // Ignore
      }
    }
  }

  console.log('================================================================');
  console.log(' ARGUS TERMINAL — E2E VERIFICATION SUITE');
  console.log('================================================================');

  try {
    await runTest('1. Server Bootstrap (createArgusServer / Test Server Startup)', async () => {
      await startArgusTestServer();
      assert.ok(baseUrl.startsWith('http://'), 'Expected valid baseUrl');
    });

    // -------------------------------------------------------------------------
    // 2. Static & Modern Web UI Compliance
    // -------------------------------------------------------------------------
    await runTest('2.1 GET / returns 200 OK HTML with <dialog closedby="any">, role="region", <canvas>, and Bloomberg panes', async () => {
      const res = await httpRequest('GET', '/');
      assert.equal(res.status, 200, `Expected 200 OK from GET /, got ${res.status}`);
      assert.ok(res.text.includes('<dialog'), 'HTML must contain native <dialog> element');
      assert.ok(
        res.text.includes('closedby="any"') || res.text.includes("closedby='any'"),
        'HTML <dialog> must include closedby="any" attribute'
      );
      assert.ok(
        res.text.includes('role="region"') || res.text.includes("role='region'"),
        'HTML must contain role="region" landmarks for terminal panes'
      );
      assert.ok(res.text.includes('<canvas'), 'HTML must contain <canvas> element for charts');
      // Verify core terminal panes / workspace elements exist
      const lower = res.text.toLowerCase();
      assert.ok(lower.includes('orderbook') || lower.includes('order book'), 'HTML should contain Orderbook pane');
      assert.ok(lower.includes('portfolio') || lower.includes('blotter') || lower.includes('positions'), 'HTML should contain Portfolio/Positions pane');
    });

    await runTest('2.2 Static assets (/css/terminal.css, /js/app.js, /js/charts.js, /js/components.js) return 200 OK', async () => {
      const assets = [
        '/css/terminal.css',
        '/js/app.js',
        '/js/charts.js',
        '/js/components.js',
      ];
      for (const assetPath of assets) {
        const res = await httpRequest('GET', assetPath);
        assert.equal(res.status, 200, `Expected 200 OK for ${assetPath}, got ${res.status}`);
        assert.ok(res.text.length > 50, `Expected non-empty content for ${assetPath}`);
      }
    });

    // -------------------------------------------------------------------------
    // 3. REST Market Data & Seeded SQLite State
    // -------------------------------------------------------------------------
    await runTest('3.1 GET /api/health returns { status: "ok" }', async () => {
      const res = await httpRequest('GET', '/api/health');
      assert.equal(res.status, 200, `Expected 200 OK from /api/health, got ${res.status}`);
      assert.ok(res.json, 'Expected JSON body from /api/health');
      assert.equal(res.json.status, 'ok', `Expected status === "ok", got ${res.json.status}`);
    });

    await runTest('3.2 GET /api/tickers returns all 6 seeded instruments with numeric lastPrice, bid, ask', async () => {
      const res = await httpRequest('GET', '/api/tickers');
      assert.equal(res.status, 200, `Expected 200 OK from /api/tickers, got ${res.status}`);
      const tickers = Array.isArray(res.json) ? res.json : res.json?.tickers;
      assert.ok(Array.isArray(tickers), 'Expected tickers array');

      const expectedSymbols = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'NVDA-EQ', 'XAU-USD', 'IDR-USD'];
      const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));

      for (const sym of expectedSymbols) {
        const item = bySymbol.get(sym);
        assert.ok(item, `Missing seeded instrument ${sym} in /api/tickers`);
        assert.equal(typeof item.lastPrice, 'number', `${sym} lastPrice must be a number`);
        assert.ok(Number.isFinite(item.lastPrice) && item.lastPrice > 0, `${sym} lastPrice must be > 0`);
        assert.equal(typeof item.bid, 'number', `${sym} bid must be a number`);
        assert.equal(typeof item.ask, 'number', `${sym} ask must be a number`);
      }
    });

    await runTest('3.3 GET /api/candles?symbol=BTC-USD&limit=60 returns 60 valid OHLCV candles', async () => {
      const res = await httpRequest('GET', '/api/candles?symbol=BTC-USD&limit=60');
      assert.equal(res.status, 200, `Expected 200 OK from /api/candles, got ${res.status}`);
      const candles = Array.isArray(res.json) ? res.json : res.json?.candles;
      assert.ok(Array.isArray(candles), 'Expected candles array');
      assert.equal(candles.length, 60, `Expected 60 candles, got ${candles.length}`);

      for (const c of candles) {
        assert.equal(typeof c.open, 'number', 'Candle open must be numeric');
        assert.equal(typeof c.high, 'number', 'Candle high must be numeric');
        assert.equal(typeof c.low, 'number', 'Candle low must be numeric');
        assert.equal(typeof c.close, 'number', 'Candle close must be numeric');
        assert.equal(typeof c.volume, 'number', 'Candle volume must be numeric');
        assert.ok(c.high >= c.low, `Candle high (${c.high}) must be >= low (${c.low})`);
      }
    });

    await runTest('3.4 GET /api/orderbook?symbol=BTC-USD&depth=15 returns sorted bids and asks with spread >= 0', async () => {
      const res = await httpRequest('GET', '/api/orderbook?symbol=BTC-USD&depth=15');
      assert.equal(res.status, 200, `Expected 200 OK from /api/orderbook, got ${res.status}`);
      const ob = res.json?.orderbook || res.json;
      assert.ok(ob, 'Expected orderbook payload');
      assert.ok(Array.isArray(ob.bids) && ob.bids.length > 0, 'Expected non-empty bids array');
      assert.ok(Array.isArray(ob.asks) && ob.asks.length > 0, 'Expected non-empty asks array');

      for (let i = 0; i < ob.bids.length - 1; i++) {
        assert.ok(
          ob.bids[i].price >= ob.bids[i + 1].price,
          `Bids must be sorted descending: ${ob.bids[i].price} < ${ob.bids[i + 1].price}`
        );
      }
      for (let i = 0; i < ob.asks.length - 1; i++) {
        assert.ok(
          ob.asks[i].price <= ob.asks[i + 1].price,
          `Asks must be sorted ascending: ${ob.asks[i].price} > ${ob.asks[i + 1].price}`
        );
      }
      assert.equal(typeof ob.spread, 'number', 'Orderbook spread must be numeric');
      assert.ok(ob.spread >= 0, `Orderbook spread must be >= 0, got ${ob.spread}`);
    });

    // -------------------------------------------------------------------------
    // 4. Matching Engine & Order Lifecycle
    // -------------------------------------------------------------------------
    let initialBtcPositionSize = 0;

    await runTest('4.1 GET /api/portfolio?accountId=ACC-INST-01 returns seeded cash balance and positions', async () => {
      const res = await httpRequest('GET', '/api/portfolio?accountId=ACC-INST-01');
      assert.equal(res.status, 200, `Expected 200 OK from /api/portfolio, got ${res.status}`);
      const p = res.json;
      assert.ok(p, 'Expected portfolio JSON');
      const account = p.account || p;
      const cashBalance = account.cashBalance ?? account.cash_balance;
      assert.equal(typeof cashBalance, 'number', 'Expected numeric cashBalance on account');
      assert.ok(cashBalance > 0, `Expected positive seeded cashBalance, got ${cashBalance}`);
      assert.ok(Array.isArray(p.positions), 'Expected positions array');

      const btcPos = p.positions.find((pos) => pos.symbol === 'BTC-USD');
      initialBtcPositionSize = btcPos ? Number(btcPos.size ?? btcPos.quantity ?? 0) : 0;
    });

    await runTest('4.2 POST /api/orders with resting LIMIT BUY adds to openOrders & DELETE /api/orders/:orderId cancels it cleanly', async () => {
      // Determine current midPrice/bid for BTC-USD so our limit buy rests far below market
      const obRes = await httpRequest('GET', '/api/orderbook?symbol=BTC-USD&depth=5');
      const ob = obRes.json?.orderbook || obRes.json;
      const bestBid = ob?.bids?.[0]?.price || 90000;
      const restingBidPrice = Math.max(1000, Math.floor(bestBid * 0.5));

      const createRes = await httpRequest('POST', '/api/orders', {
        accountId: 'ACC-INST-01',
        symbol: 'BTC-USD',
        side: 'BUY',
        type: 'LIMIT',
        price: restingBidPrice,
        size: 0.5,
      });

      assert.ok(
        createRes.status === 200 || createRes.status === 201,
        `Expected 200/201 from POST /api/orders, got ${createRes.status}: ${createRes.text}`
      );
      const orderObj = createRes.json?.order || createRes.json;
      const orderId = orderObj?.id || orderObj?.orderId || createRes.json?.orderId;
      assert.ok(orderId, `Expected orderId from POST /api/orders, got ${createRes.text}`);

      // Verify order appears in openOrders of ACC-INST-01
      const portAfterCreate = await httpRequest('GET', '/api/portfolio?accountId=ACC-INST-01');
      const openOrders = portAfterCreate.json?.openOrders || [];
      const foundOpen = openOrders.some((o) => (o.id || o.orderId) === orderId);
      assert.ok(foundOpen, `Expected resting order ${orderId} to be in openOrders`);

      // Cancel the resting order
      const delRes = await httpRequest('DELETE', `/api/orders/${encodeURIComponent(orderId)}`);
      assert.ok(
        delRes.status === 200 || delRes.status === 204,
        `Expected 200/204 from DELETE /api/orders/${orderId}, got ${delRes.status}`
      );

      // Verify order is removed from openOrders
      const portAfterCancel = await httpRequest('GET', '/api/portfolio?accountId=ACC-INST-01');
      const openOrdersAfter = portAfterCancel.json?.openOrders || [];
      const stillOpen = openOrdersAfter.some(
        (o) => (o.id || o.orderId) === orderId && o.status !== 'CANCELLED' && o.status !== 'CANCELED'
      );
      assert.equal(stillOpen, false, `Expected cancelled order ${orderId} to be removed from openOrders`);
    });

    await runTest('4.3 POST /api/orders with MARKET BUY executes immediately, produces fills, records trade, and updates positions', async () => {
      const buySize = 0.25;
      const mktRes = await httpRequest('POST', '/api/orders', {
        accountId: 'ACC-INST-01',
        symbol: 'BTC-USD',
        side: 'BUY',
        type: 'MARKET',
        size: buySize,
      });

      assert.ok(
        mktRes.status === 200 || mktRes.status === 201,
        `Expected 200/201 from MARKET BUY POST /api/orders, got ${mktRes.status}: ${mktRes.text}`
      );
      const fills = mktRes.json?.fills || mktRes.json?.order?.fills || [];
      assert.ok(Array.isArray(fills) && fills.length >= 1, 'Expected at least 1 fill for MARKET BUY order');

      const orderId = mktRes.json?.order?.id || mktRes.json?.order?.orderId || mktRes.json?.orderId;

      // Verify trade recorded in /api/trades?symbol=BTC-USD
      const tradesRes = await httpRequest('GET', '/api/trades?symbol=BTC-USD&limit=50');
      assert.equal(tradesRes.status, 200, 'Expected 200 OK from /api/trades');
      const trades = Array.isArray(tradesRes.json) ? tradesRes.json : tradesRes.json?.trades;
      assert.ok(Array.isArray(trades) && trades.length >= 1, 'Expected non-empty trades list for BTC-USD');
      if (orderId) {
        const matchedTrade = trades.some(
          (t) =>
            t.takerOrderId === orderId ||
            t.taker_order_id === orderId ||
            t.orderId === orderId ||
            Number(t.size) === buySize
        );
        assert.ok(matchedTrade, 'Expected MARKET BUY execution to appear in /api/trades?symbol=BTC-USD');
      }

      // Verify updated position in /api/portfolio?accountId=ACC-INST-01
      const portRes = await httpRequest('GET', '/api/portfolio?accountId=ACC-INST-01');
      assert.equal(portRes.status, 200, 'Expected 200 OK from /api/portfolio');
      const btcPos = (portRes.json?.positions || []).find((pos) => pos.symbol === 'BTC-USD');
      assert.ok(btcPos, 'Expected BTC-USD position in portfolio after MARKET BUY');
      const newBtcSize = Number(btcPos.size ?? btcPos.quantity ?? 0);
      assert.ok(
        Math.abs(newBtcSize - (initialBtcPositionSize + buySize)) < 1e-6,
        `Expected BTC-USD position size to increase from ${initialBtcPositionSize} to ${
          initialBtcPositionSize + buySize
        }, got ${newBtcSize}`
      );
    });

    // -------------------------------------------------------------------------
    // 5. SQL Analytics Console & News Wire
    // -------------------------------------------------------------------------
    await runTest('5.1 POST /api/sql executes analytical query on instruments and returns 6 rows', async () => {
      const res = await httpRequest('POST', '/api/sql', {
        query: 'SELECT symbol, base_price FROM instruments ORDER BY symbol',
      });
      assert.equal(res.status, 200, `Expected 200 OK from POST /api/sql, got ${res.status}: ${res.text}`);
      const rows = res.json?.rows || (Array.isArray(res.json) ? res.json : []);
      assert.equal(rows.length, 6, `Expected 6 rows from instruments table, got ${rows.length}`);
    });

    await runTest('5.2 GET /api/news returns macro wire items', async () => {
      const res = await httpRequest('GET', '/api/news');
      assert.equal(res.status, 200, `Expected 200 OK from GET /api/news, got ${res.status}`);
      const news = Array.isArray(res.json) ? res.json : res.json?.news || res.json?.items;
      assert.ok(Array.isArray(news) && news.length > 0, 'Expected non-empty macro news wire items');
    });

    // -------------------------------------------------------------------------
    // 6. Real-Time WebSocket Multiplexer
    // -------------------------------------------------------------------------
    await runTest('6. Real-Time WebSocket Multiplexer receives SNAPSHOT and TICK/ORDERBOOK within 2500ms', async () => {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let gotSnapshot = false;
        let gotStreamBroadcast = false;
        let settled = false;

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try {
              ws.close();
            } catch {}
            reject(
              new Error(
                `WebSocket timed out after 2500ms (gotSnapshot=${gotSnapshot}, gotStreamBroadcast=${gotStreamBroadcast})`
              )
            );
          }
        }, 2500);

        ws.on('open', () => {
          try {
            ws.send(JSON.stringify({ type: 'SUBSCRIBE', symbol: 'BTC-USD' }));
          } catch {
            // Ignore send errors if server doesn't require explicit subscription
          }
        });

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'SNAPSHOT') {
              gotSnapshot = true;
            }
            if (msg.type === 'TICK' || msg.type === 'ORDERBOOK') {
              gotStreamBroadcast = true;
            }
            if (gotSnapshot && gotStreamBroadcast && !settled) {
              settled = true;
              clearTimeout(timer);
              const closeFallback = setTimeout(() => {
                try {
                  ws.terminate();
                } catch {}
                resolve();
              }, 300);
              ws.once('close', () => {
                clearTimeout(closeFallback);
                resolve();
              });
              ws.close();
            }
          } catch (err) {
            // Ignore malformed messages
          }
        });

        ws.on('close', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(
              new Error(
                `WebSocket closed prematurely before receiving SNAPSHOT + TICK/ORDERBOOK (gotSnapshot=${gotSnapshot}, gotStreamBroadcast=${gotStreamBroadcast})`
              )
            );
          }
        });

        ws.on('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
      });

      // Allow close handshake to finish cleanly
      await new Promise((r) => setTimeout(r, 50));
    });
  } finally {
    await stopArgusTestServer();
  }

  console.log('================================================================');
  console.log(` E2E SUMMARY: ${passCount} PASSED | ${failCount} FAILED`);
  console.log('================================================================');

  process.exit(failCount === 0 ? 0 : 1);
})();
