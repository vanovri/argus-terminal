/**
 * ARGUS TERMINAL // MAIN APPLICATION ORCHESTRATOR, WEBSOCKET CLIENT & <GO> ROUTER
 * Coordinates:
 *  - Initial REST API hydration & Real-Time WebSocket multiplexing
 *  - Bloomberg <GO> Command Bar parser & <dialog closedby="any"> Command Palette
 *  - Keyboard Function Hotkeys (F1-F7, /, Cmd+K) & Multi-Pane Tiling Layout Manager
 *  - DMA Order Entry Ticket, Position Flattening, Order Cancellation & SQL Console
 */

(function () {
  'use strict';

  const DEFAULT_INSTRUMENTS = [
    { symbol: 'BTC-USD', name: 'Bitcoin Spot', assetClass: 'CRYPTO', lastPrice: 94500.0, change24h: 1320.0, changePct24h: 1.42, high24h: 95420.0, low24h: 93110.0, volume24h: 14820.5, vwap: 94485.2, bid: 94499.5, ask: 94500.5, spread: 1.0 },
    { symbol: 'ETH-USD', name: 'Ethereum Spot', assetClass: 'CRYPTO', lastPrice: 3180.0, change24h: 64.5, changePct24h: 2.07, high24h: 3225.0, low24h: 3095.0, volume24h: 84310.0, vwap: 3174.8, bid: 3179.9, ask: 3180.1, spread: 0.2 },
    { symbol: 'SOL-USD', name: 'Solana Spot', assetClass: 'CRYPTO', lastPrice: 212.5, change24h: -3.4, changePct24h: -1.57, high24h: 218.0, low24h: 208.2, volume24h: 312400.0, vwap: 213.1, bid: 212.45, ask: 212.55, spread: 0.1 },
    { symbol: 'NVDA-EQ', name: 'NVIDIA Corp', assetClass: 'EQUITY', lastPrice: 148.2, change24h: 4.15, changePct24h: 2.88, high24h: 149.5, low24h: 143.8, volume24h: 489200.0, vwap: 147.65, bid: 148.19, ask: 148.21, spread: 0.02 },
    { symbol: 'XAU-USD', name: 'Gold Spot', assetClass: 'COMMODITY', lastPrice: 2745.0, change24h: 18.4, changePct24h: 0.67, high24h: 2758.0, low24h: 2721.0, volume24h: 62150.0, vwap: 2742.3, bid: 2744.9, ask: 2745.1, spread: 0.2 },
    { symbol: 'IDR-USD', name: 'USD/IDR FX Futures', assetClass: 'FX', lastPrice: 15680.0, change24h: -45.0, changePct24h: -0.29, high24h: 15740.0, low24h: 15630.0, volume24h: 915000.0, vwap: 15685.0, bid: 15679.0, ask: 15681.0, spread: 2.0 }
  ];

  const SQL_PRESETS = {
    notional: 'SELECT symbol, count(*) AS trades, round(sum(size * price), 2) AS notional, round(avg(price), 2) AS avg_px FROM trades GROUP BY symbol ORDER BY notional DESC;',
    instruments: 'SELECT symbol, name, asset_class, base_price, tick_size, lot_size FROM instruments ORDER BY base_price DESC;',
    positions: 'SELECT p.account_id, p.symbol, p.qty, round(p.avg_entry_price, 2) AS avg_entry, i.base_price AS ref_px, round(p.realized_pnl, 2) AS realized_pnl FROM positions p JOIN instruments i ON p.symbol = i.symbol;',
    orders: 'SELECT id, symbol, side, type, price, size, filled_size, status, client_tag FROM orders ORDER BY created_at DESC LIMIT 25;',
    candles: 'SELECT symbol, count(*) AS bars, round(min(low), 2) AS session_low, round(max(high), 2) AS session_high, round(sum(volume), 2) AS total_vol FROM candles GROUP BY symbol;'
  };

  const PALETTE_COMMANDS = [
    { code: 'BTC-USD <GO>', desc: 'Load Bitcoin Spot OHLCV Chart, L2 Depth & Execution Ladder', category: 'INSTRUMENT', action: () => selectSymbol('BTC-USD') },
    { code: 'ETH-USD <GO>', desc: 'Load Ethereum Spot OHLCV Chart, L2 Depth & Execution Ladder', category: 'INSTRUMENT', action: () => selectSymbol('ETH-USD') },
    { code: 'SOL-USD <GO>', desc: 'Load Solana Spot OHLCV Chart, L2 Depth & Execution Ladder', category: 'INSTRUMENT', action: () => selectSymbol('SOL-USD') },
    { code: 'NVDA-EQ <GO>', desc: 'Load NVIDIA Corp Equity Spot Chart & Orderbook', category: 'INSTRUMENT', action: () => selectSymbol('NVDA-EQ') },
    { code: 'XAU-USD <GO>', desc: 'Load Gold Spot Commodity Chart & Orderbook', category: 'INSTRUMENT', action: () => selectSymbol('XAU-USD') },
    { code: 'IDR-USD <GO>', desc: 'Load USD/IDR NDF FX Futures Chart & Orderbook', category: 'INSTRUMENT', action: () => selectSymbol('IDR-USD') },
    { code: 'CANDLES <GO>', desc: 'Switch Center Canvas to OHLCV Candlesticks + EMA 9/21 + VWAP', category: 'CHART VIEW', action: () => setChartMode('CANDLES') },
    { code: 'DEPTH <GO>', desc: 'Switch Center Canvas to Live L2 Cumulative Liquidity Depth Wall', category: 'CHART VIEW', action: () => setChartMode('DEPTH') },
    { code: 'SPLIT <GO>', desc: 'Split Center Canvas: Dual OHLCV Candles + L2 Market Depth Wall', category: 'CHART VIEW', action: () => setChartMode('SPLIT') },
    { code: 'PORT <GO>', desc: 'Open Institutional Positions & Mark-to-Market PnL Blotter', category: 'BLOTTER', action: () => switchBlotterTab('positions') },
    { code: 'ORDERS <GO>', desc: 'Open Working Limit Orders & Execution Fills Blotter', category: 'BLOTTER', action: () => switchBlotterTab('orders') },
    { code: 'SQL <GO>', desc: 'Open In-Process SQLite Institutional Analytics Console (F4)', category: 'ANALYTICS', action: () => switchBlotterTab('sql') },
    { code: 'NEWS <GO>', desc: 'Open Real-Time Breaking Macro & Institutional News Wire (F5)', category: 'WIRE', action: () => switchBlotterTab('news') },
    { code: 'QUANT <GO>', desc: 'Open 10,000-Path Monte Carlo VaR/CVaR, VPIN Toxicity & AI Quant Copilot (F8)', category: 'QUANT RISK', action: () => { switchBlotterTab('quant'); loadQuantAndAlgoTelemetry(false); } },
    { code: 'ALGO <GO>', desc: 'Launch TWAP, VWAP, Iceberg, or Avellaneda-Stoikov Market Making Algo (F8)', category: 'EXECUTION', action: () => { switchBlotterTab('quant'); launchAlgoExecution('TWAP'); } },
    { code: 'BACKTEST <GO>', desc: 'Run Historical OHLCV Strategy Backtest (Sharpe, Sortino, Max Drawdown)', category: 'QUANT RISK', action: () => { switchBlotterTab('quant'); runStrategyBacktestUi(); } },
    { code: 'OPT <GO>', desc: 'Open 3D SVI Volatility Surface, BSM Greeks & Options Chain Workstation (/options.html)', category: 'DERIVATIVES', action: () => openOptionsWorkstation('surface') },
    { code: 'FIX <GO>', desc: 'Open FIX 4.4 Wire Protocol & 40-Byte Binary SBE Frame Inspector (/options.html#fix)', category: 'PROTOCOL', action: () => openOptionsWorkstation('fix') },
    { code: 'ARB <GO>', desc: 'Open Multi-Venue Smart Order Router & Cross-Exchange Arbitrage Scanner (/options.html#sor)', category: 'EXECUTION', action: () => openOptionsWorkstation('sor') },
    { code: 'YIELD <GO>', desc: 'Open Nelson-Siegel-Svensson Macro Yield Curve & Fixed Income Bond Desk (/macro.html)', category: 'MACRO & RATES', action: () => { window.location.href = '/macro.html#pane-yield-curve'; } },
    { code: 'BOND <GO>', desc: 'Open Fixed Income Bond Pricing, YTM, Duration, DV01, Convexity & Z-Spread Desk (/macro.html)', category: 'MACRO & RATES', action: () => { window.location.href = '/macro.html#pane-bond-desk'; } },
    { code: 'REPLAY <GO>', desc: 'Open Limit Order Book (LOB) Replay Time-Machine & SHA-256 State Scrubber (/macro.html)', category: 'MICROSTRUCTURE', action: () => { window.location.href = '/macro.html#pane-replay'; } },
    { code: 'DARK <GO>', desc: 'Open Dark Pool Crossing Network (ARGUS-DARK-ATS) Midpoint Peg & VPIN Shield (/macro.html)', category: 'EXECUTION', action: () => { window.location.href = '/macro.html#pane-darkpool'; } },
    { code: 'DECK <GO>', desc: 'Open Institutional Pitch Deck & Architecture Presentation (/deck.html)', category: 'EXECUTIVE', action: () => openExecutiveDeck() },
    { code: 'BUY <GO>', desc: 'Configure DMA Order Ticket for BUY Limit Execution (F3)', category: 'EXECUTION', action: () => focusOrderTicket('BUY') },
    { code: 'SELL <GO>', desc: 'Configure DMA Order Ticket for SELL Limit Execution (F3)', category: 'EXECUTION', action: () => focusOrderTicket('SELL') },
    { code: 'CANCEL ALL <GO>', desc: 'Cancel All Open Resting Limit Orders for Active Account', category: 'RISK', action: () => cancelAllOpenOrders() },
    { code: 'LAYOUT <GO>', desc: 'Cycle Multi-Pane Workspace Tiling Proportions (F6)', category: 'WORKSPACE', action: () => cycleWorkspaceLayout() },
    { code: 'WEBHOOK <GO>', desc: 'Dispatch Test Institutional Execution Webhook Ping (F7)', category: 'SYSTEM', action: () => triggerWebhookTest() }
  ];

  const state = {
    activeSymbol: 'BTC-USD',
    activeAccountId: 'ACC-INST-01',
    assetFilter: 'ALL',
    tickersMap: new Map(),
    orderbook: { bids: [], asks: [], midPrice: 94500, spread: 1.0 },
    trades: [],
    portfolio: {
      account: { id: 'ACC-INST-01', name: 'Alpha Desk 01', cashBalance: 8500000, equity: 10000000, marginUsed: 1500000 },
      positions: [],
      openOrders: [],
      recentFills: []
    },
    news: [],
    orderSide: 'BUY',
    orderType: 'LIMIT',
    ws: null,
    wsTickCount: 0,
    layouts: ['standard', 'chart-focus', 'analytics-focus'],
    layoutIdx: 0,
    paletteSelectedIdx: 0,
    paletteFiltered: PALETTE_COMMANDS
  };

  let chartEngine = null;

  // ==========================================================================
  // 1. INITIALIZATION & DIALOG LIGHT-DISMISS FALLBACK
  // ==========================================================================

  function init() {
    // Seed initial instruments so UI is immediately interactive
    DEFAULT_INSTRUMENTS.forEach((inst) => {
      state.tickersMap.set(inst.symbol, ArgusComponents.normalizeTicker(inst));
    });

    chartEngine = new window.ArgusChartEngine('primary-chart-canvas');

    setupLightDismissDialogFallback();
    setupClocks();
    bindHeaderAndCommandEvents();
    bindChartToolbarEvents();
    bindOrderTicketEvents();
    bindBlotterEvents();
    bindGlobalKeyboardShortcuts();

    // Initial UI render from seeded state
    ArgusComponents.renderWatchlist(state.tickersMap, state.activeSymbol, state.assetFilter, selectSymbol);
    ArgusComponents.renderActiveInstrumentHeader(state.tickersMap.get(state.activeSymbol));
    updateOrderTicketCalculations();

    // Hydrate from REST API endpoints & connect WebSocket
    hydrateAllFromRest();
    connectWebSocket();
  }

  /**
   * Mandatory Fallback for <dialog closedby="any"> (modern-web-guidance: light-dismiss-a-dialog)
   */
  function setupLightDismissDialogFallback() {
    const dialog = document.getElementById('cmd-dialog');
    if (!dialog) return;

    // Fallback for browsers without closedby support
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      dialog.addEventListener('click', (event) => {
        // 1. When clicking the backdrop, the event target is the dialog element itself.
        // Ignore clicks where the target is a child element inside the dialog.
        if (event.target !== dialog) return;

        // 2. Check if the click coordinates fall within the dialog's content box.
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;

        if (isDialogContent) return;

        // 3. Since the click was outside the content area (on the backdrop), manually close the dialog.
        dialog.close();
      });
    }
  }

  function openCommandPalette(initialQuery = '') {
    const dialog = document.getElementById('cmd-dialog');
    const searchInput = document.getElementById('palette-search-input');
    if (!dialog) return;

    state.paletteSelectedIdx = 0;
    if (searchInput) {
      searchInput.value = initialQuery;
    }
    refreshPaletteList();

    if (!dialog.open) {
      dialog.showModal();
    }
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }

  function refreshPaletteList() {
    const searchInput = document.getElementById('palette-search-input');
    const q = searchInput ? searchInput.value : '';
    state.paletteFiltered = ArgusComponents.renderCommandPalette(
      PALETTE_COMMANDS,
      q,
      state.paletteSelectedIdx,
      (cmdItem) => {
        const dialog = document.getElementById('cmd-dialog');
        if (dialog && dialog.open) dialog.close();
        if (cmdItem && typeof cmdItem.action === 'function') {
          cmdItem.action();
        }
      }
    );
  }

  // ==========================================================================
  // 2. REST API HYDRATION
  // ==========================================================================

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        if (errBody && errBody.error) errMsg = errBody.error;
      } catch (_) {
        // ignore JSON parse error
      }
      throw new Error(errMsg);
    }
    return res.json();
  }

  async function hydrateAllFromRest() {
    await Promise.allSettled([
      loadTickers(),
      loadSymbolMarketData(state.activeSymbol, true),
      loadPortfolio(),
      loadNews(),
      executeSqlQuery(SQL_PRESETS.notional, true),
      loadQuantAndAlgoTelemetry(true)
    ]);
  }

  async function loadTickers() {
    try {
      const data = await fetchJson('/api/tickers');
      const list = Array.isArray(data) ? data : data.tickers || [];
      list.forEach((raw) => {
        const norm = ArgusComponents.normalizeTicker(raw);
        if (norm) state.tickersMap.set(norm.symbol, norm);
      });
      ArgusComponents.renderWatchlist(state.tickersMap, state.activeSymbol, state.assetFilter, selectSymbol);
      const activeTicker = state.tickersMap.get(state.activeSymbol);
      if (activeTicker) {
        ArgusComponents.renderActiveInstrumentHeader(activeTicker);
      }
    } catch (_) {
      // Keep fallback seeded state if server is starting up
    }
  }

  async function loadSymbolMarketData(symbol, syncOrderPrice = false) {
    try {
      const [candlesRes, obRes, tradesRes] = await Promise.allSettled([
        fetchJson(`/api/candles?symbol=${encodeURIComponent(symbol)}&limit=120`),
        fetchJson(`/api/orderbook?symbol=${encodeURIComponent(symbol)}&depth=15`),
        fetchJson(`/api/trades?symbol=${encodeURIComponent(symbol)}&limit=50`)
      ]);

      if (candlesRes.status === 'fulfilled') {
        const candles = Array.isArray(candlesRes.value) ? candlesRes.value : candlesRes.value.candles || [];
        chartEngine.setSymbol(symbol);
        chartEngine.setCandles(candles);
      }

      if (obRes.status === 'fulfilled' && obRes.value) {
        state.orderbook = obRes.value;
        ArgusComponents.renderOrderbook(state.orderbook, symbol, prefillOrderTicketPrice);
        chartEngine.setOrderbook(state.orderbook);

        if (syncOrderPrice) {
          const pxInput = document.getElementById('order-price');
          const t = state.tickersMap.get(symbol);
          const defaultPx = state.orderbook.midPrice || (t ? t.lastPrice : 0);
          if (pxInput && defaultPx > 0) {
            pxInput.value = Number(defaultPx).toFixed(symbol === 'NVDA-EQ' ? 2 : symbol === 'IDR-USD' ? 1 : 2);
            updateOrderTicketCalculations();
          }
        }
      }

      if (tradesRes.status === 'fulfilled') {
        const trades = Array.isArray(tradesRes.value) ? tradesRes.value : tradesRes.value.trades || [];
        state.trades = trades;
        ArgusComponents.renderTradesTape(state.trades, symbol);
      }
    } catch (_) {
      // Handled gracefully
    }
  }

  async function loadPortfolio() {
    try {
      const data = await fetchJson(`/api/portfolio?accountId=${encodeURIComponent(state.activeAccountId)}`);
      if (data) {
        state.portfolio = data;
        ArgusComponents.renderPortfolioAndPositions(
          state.portfolio,
          state.tickersMap,
          flattenPositionMarket,
          selectSymbol
        );
        ArgusComponents.renderOrdersBlotter(
          state.portfolio.openOrders || [],
          state.portfolio.recentFills || [],
          cancelOrderById
        );
      }
    } catch (_) {
      // Keep existing state
    }
  }

  async function loadNews() {
    try {
      const data = await fetchJson('/api/news');
      const items = Array.isArray(data) ? data : data.news || data.items || [];
      state.news = items;
      ArgusComponents.renderNewsWire(state.news);
    } catch (_) {
      // Ignore error
    }
  }

  // ==========================================================================
  // 3. REAL-TIME WEBSOCKET MULTIPLEXER
  // ==========================================================================

  function connectWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;

    const dotEl = document.getElementById('ws-status-dot');
    const txtEl = document.getElementById('ws-status-text');
    const tickEl = document.getElementById('ws-tick-counter');

    try {
      const ws = new WebSocket(wsUrl);
      state.ws = ws;

      ws.addEventListener('open', () => {
        if (dotEl) dotEl.className = 'status-dot online';
        if (txtEl) txtEl.textContent = 'WS: LIVE';
        ws.send(JSON.stringify({ type: 'SUBSCRIBE', symbol: state.activeSymbol }));
      });

      ws.addEventListener('message', (event) => {
        state.wsTickCount += 1;
        if (tickEl) tickEl.textContent = `${state.wsTickCount} TICKS`;

        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (_) {
          return;
        }

        handleWebSocketMessage(msg);
      });

      ws.addEventListener('close', () => {
        if (dotEl) dotEl.className = 'status-dot offline';
        if (txtEl) txtEl.textContent = 'WS: RECONNECTING';
        setTimeout(connectWebSocket, 2000);
      });

      ws.addEventListener('error', () => {
        if (dotEl) dotEl.className = 'status-dot offline';
      });
    } catch (_) {
      setTimeout(connectWebSocket, 3000);
    }
  }

  function handleWebSocketMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'SNAPSHOT': {
        if (Array.isArray(msg.tickers)) {
          msg.tickers.forEach((raw) => {
            const norm = ArgusComponents.normalizeTicker(raw);
            if (norm) state.tickersMap.set(norm.symbol, norm);
          });
          ArgusComponents.renderWatchlist(state.tickersMap, state.activeSymbol, state.assetFilter, selectSymbol);
          ArgusComponents.renderActiveInstrumentHeader(state.tickersMap.get(state.activeSymbol));
        }
        if (Array.isArray(msg.news)) {
          state.news = msg.news;
          ArgusComponents.renderNewsWire(state.news);
        }
        break;
      }

      case 'TICK': {
        if (Array.isArray(msg.tickers)) {
          msg.tickers.forEach((raw) => {
            const norm = ArgusComponents.normalizeTicker(raw);
            if (norm) state.tickersMap.set(norm.symbol, norm);
          });
          ArgusComponents.renderWatchlist(state.tickersMap, state.activeSymbol, state.assetFilter, selectSymbol);

          const activeTicker = state.tickersMap.get(state.activeSymbol);
          if (activeTicker) {
            ArgusComponents.renderActiveInstrumentHeader(activeTicker);
            chartEngine.updateLiveTickPrice(activeTicker.lastPrice);
          }

          // Live mark-to-market PnL update in Positions blotter
          ArgusComponents.renderPortfolioAndPositions(
            state.portfolio,
            state.tickersMap,
            flattenPositionMarket,
            selectSymbol
          );
        }
        break;
      }

      case 'ORDERBOOK': {
        const ob = msg.orderbook || msg;
        const sym = msg.symbol || ob.symbol || state.activeSymbol;
        if (sym === state.activeSymbol) {
          state.orderbook = ob;
          ArgusComponents.renderOrderbook(state.orderbook, state.activeSymbol, prefillOrderTicketPrice);
          chartEngine.setOrderbook(state.orderbook);
        }
        break;
      }

      case 'TRADE': {
        const tr = msg.trade || msg;
        if (!tr.symbol || tr.symbol === state.activeSymbol) {
          state.trades.unshift(tr);
          if (state.trades.length > 60) state.trades.pop();
          ArgusComponents.renderTradesTape(state.trades, state.activeSymbol);
        }
        break;
      }

      case 'CANDLE': {
        if (!msg.symbol || msg.symbol === state.activeSymbol) {
          chartEngine.updateLiveCandle(msg.candle);
        }
        break;
      }

      case 'NEWS': {
        if (msg.item) {
          state.news.unshift(msg.item);
          if (state.news.length > 50) state.news.pop();
          ArgusComponents.renderNewsWire(state.news);
        }
        break;
      }

      case 'PORTFOLIO_UPDATE': {
        loadPortfolio();
        break;
      }

      default:
        break;
    }
  }

  // ==========================================================================
  // 4. INSTRUMENT SWITCHING & <GO> COMMAND ROUTER
  // ==========================================================================

  function selectSymbol(symbol) {
    const cleanSym = String(symbol || '').trim().toUpperCase();
    if (!cleanSym) return;

    state.activeSymbol = cleanSym;
    ArgusComponents.renderWatchlist(state.tickersMap, state.activeSymbol, state.assetFilter, selectSymbol);

    const ticker = state.tickersMap.get(cleanSym);
    if (ticker) {
      ArgusComponents.renderActiveInstrumentHeader(ticker);
      const pxInput = document.getElementById('order-price');
      if (pxInput) {
        pxInput.value = ticker.lastPrice;
      }
      // Set reasonable default order size per instrument price scale
      const szInput = document.getElementById('order-size');
      if (szInput) {
        szInput.value = ticker.lastPrice > 10000 ? '0.5' : ticker.lastPrice > 500 ? '2.0' : '25.0';
      }
      updateOrderTicketCalculations();
    }

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'SUBSCRIBE', symbol: cleanSym }));
    }

    loadSymbolMarketData(cleanSym, true);
    loadQuantAndAlgoTelemetry(true);
  }

  function executeCommandString(rawInput) {
    const cleaned = String(rawInput || '')
      .replace(/<GO>/gi, '')
      .replace(/\bGO\b/gi, '')
      .trim()
      .toUpperCase();

    if (!cleaned) return;

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'COMMAND', command: `${cleaned} <GO>` }));
    }

    // Check direct ticker match or prefix match
    const tickerShortcuts = {
      BTC: 'BTC-USD',
      'BTC-USD': 'BTC-USD',
      ETH: 'ETH-USD',
      'ETH-USD': 'ETH-USD',
      SOL: 'SOL-USD',
      'SOL-USD': 'SOL-USD',
      NVDA: 'NVDA-EQ',
      'NVDA-EQ': 'NVDA-EQ',
      XAU: 'XAU-USD',
      GOLD: 'XAU-USD',
      'XAU-USD': 'XAU-USD',
      IDR: 'IDR-USD',
      'IDR-USD': 'IDR-USD'
    };

    if (tickerShortcuts[cleaned]) {
      const sym = tickerShortcuts[cleaned];
      selectSymbol(sym);
      ArgusComponents.showToast('COMMAND <GO>', `Loaded instrument workspace: ${sym}`, 'info');
      return;
    }

    if (cleaned === 'DEPTH' || cleaned === 'BOOK' || cleaned === 'L2') {
      setChartMode('DEPTH');
      ArgusComponents.showToast('DEPTH <GO>', `Switched ${state.activeSymbol} canvas to L2 Cumulative Liquidity Wall`, 'info');
      return;
    }

    if (cleaned === 'CANDLES' || cleaned === 'CHART' || cleaned === 'OHLC') {
      setChartMode('CANDLES');
      ArgusComponents.showToast('CANDLES <GO>', `Switched ${state.activeSymbol} canvas to OHLCV Candlesticks`, 'info');
      return;
    }

    if (cleaned === 'SPLIT') {
      setChartMode('SPLIT');
      ArgusComponents.showToast('SPLIT <GO>', 'Enabled Dual Split-Screen OHLCV + L2 Depth View', 'info');
      return;
    }

    if (cleaned === 'PORT' || cleaned === 'POS' || cleaned === 'POSITIONS' || cleaned === 'PNL') {
      switchBlotterTab('positions');
      ArgusComponents.showToast('PORT <GO>', 'Focused Mark-to-Market Positions & PnL Blotter', 'info');
      return;
    }

    if (cleaned === 'ORDERS' || cleaned === 'BLOTTER' || cleaned === 'FILLS') {
      switchBlotterTab('orders');
      ArgusComponents.showToast('ORDERS <GO>', 'Focused Open Limit Orders & Fills Blotter', 'info');
      return;
    }

    if (cleaned === 'SQL' || cleaned === 'QUERY') {
      switchBlotterTab('sql');
      const sqlIn = document.getElementById('sql-query-input');
      if (sqlIn) sqlIn.focus();
      ArgusComponents.showToast('SQL <GO>', 'Opened SQLite In-Process Analytical Query Console', 'info');
      return;
    }

    if (cleaned === 'NEWS' || cleaned === 'WIRE' || cleaned === 'MACRO') {
      switchBlotterTab('news');
      ArgusComponents.showToast('NEWS <GO>', 'Opened Real-Time Institutional Macro News Wire', 'info');
      return;
    }

    if (cleaned === 'QUANT' || cleaned === 'RISK' || cleaned === 'VAR' || cleaned === 'VPIN' || cleaned === 'COPILOT') {
      switchBlotterTab('quant');
      loadQuantAndAlgoTelemetry(false);
      return;
    }

    if (cleaned === 'ALGO' || cleaned === 'TWAP' || cleaned === 'VWAP' || cleaned === 'MM') {
      switchBlotterTab('quant');
      const algoType = cleaned === 'VWAP' ? 'VWAP' : cleaned === 'MM' ? 'AVELLANEDA_STOIKOV' : 'TWAP';
      launchAlgoExecution(algoType);
      return;
    }

    if (cleaned === 'BACKTEST' || cleaned === 'BT' || cleaned === 'SHARPE') {
      switchBlotterTab('quant');
      runStrategyBacktestUi();
      return;
    }

    if (cleaned === 'OPT' || cleaned === 'OPTIONS' || cleaned === 'GREEKS' || cleaned === 'VOL' || cleaned === 'SVI') {
      openOptionsWorkstation('surface');
      return;
    }

    if (cleaned === 'FIX' || cleaned === 'SBE' || cleaned === 'WIRE-FIX') {
      openOptionsWorkstation('fix');
      return;
    }

    if (cleaned === 'ARB' || cleaned === 'ARBITRAGE' || cleaned === 'SOR') {
      openOptionsWorkstation('sor');
      return;
    }

    if (cleaned === 'YIELD' || cleaned === 'NSS' || cleaned === 'CURVE' || cleaned === 'BOND' || cleaned === 'BONDS' || cleaned === 'REPLAY' || cleaned === 'TIMEMACHINE' || cleaned === 'DARK' || cleaned === 'DARKPOOL' || cleaned === 'WAVE4') {
      window.location.href = '/macro.html';
      return;
    }

    if (cleaned === 'DECK' || cleaned === 'PITCH' || cleaned === 'SLIDES') {
      openExecutiveDeck();
      return;
    }

    if (cleaned.startsWith('BUY')) {
      const parts = cleaned.split(/\s+/);
      if (parts[1] && tickerShortcuts[parts[1]]) selectSymbol(tickerShortcuts[parts[1]]);
      focusOrderTicket('BUY');
      return;
    }

    if (cleaned.startsWith('SELL')) {
      const parts = cleaned.split(/\s+/);
      if (parts[1] && tickerShortcuts[parts[1]]) selectSymbol(tickerShortcuts[parts[1]]);
      focusOrderTicket('SELL');
      return;
    }

    if (cleaned === 'CANCEL ALL' || cleaned === 'CANCEL' || cleaned === 'FLAT') {
      cancelAllOpenOrders();
      return;
    }

    if (cleaned === 'WEBHOOK') {
      triggerWebhookTest();
      return;
    }

    if (cleaned === 'HELP' || cleaned === 'MENU' || cleaned === '?') {
      openCommandPalette('');
      return;
    }

    // Fallback: open command palette pre-filtered with query
    openCommandPalette(cleaned);
  }

  // ==========================================================================
  // 5. ORDER EXECUTION, CANCELLATION & SQL ANALYTICS
  // ==========================================================================

  function prefillOrderTicketPrice(price, clickedSide) {
    const pxInput = document.getElementById('order-price');
    if (!pxInput || !Number.isFinite(price)) return;

    // Ensure LIMIT mode is active when clicking a price level
    setOrderType('LIMIT');
    pxInput.value = price;

    // Flash input border
    pxInput.style.borderColor = 'var(--amber)';
    pxInput.style.boxShadow = '0 0 12px var(--amber-glow)';
    setTimeout(() => {
      pxInput.style.borderColor = '';
      pxInput.style.boxShadow = '';
    }, 450);

    updateOrderTicketCalculations();
    ArgusComponents.showToast(
      'PRICE PRE-FILLED',
      `Set ${state.activeSymbol} Limit Price to ${ArgusComponents.formatPrice(price, state.activeSymbol)} (${clickedSide} level)`,
      'info'
    );
  }

  function setOrderSide(side) {
    state.orderSide = side === 'SELL' ? 'SELL' : 'BUY';
    const buyBtn = document.getElementById('side-buy-btn');
    const sellBtn = document.getElementById('side-sell-btn');
    const submitBtn = document.getElementById('order-submit-btn');

    if (buyBtn) buyBtn.classList.toggle('active', state.orderSide === 'BUY');
    if (sellBtn) sellBtn.classList.toggle('active', state.orderSide === 'SELL');

    if (submitBtn) {
      submitBtn.className = `btn-submit-order ${state.orderSide === 'BUY' ? 'buy-mode' : 'sell-mode'}`;
      submitBtn.innerHTML = `TRANSMIT ${state.orderSide} ${state.orderType} &lt;GO&gt;`;
    }
  }

  function setOrderType(type) {
    state.orderType = type === 'MARKET' ? 'MARKET' : 'LIMIT';
    document.querySelectorAll('.ticket-type-tabs .type-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-type') === state.orderType);
    });

    const pxGroup = document.getElementById('order-price-group');
    const pxInput = document.getElementById('order-price');
    if (pxGroup) pxGroup.classList.toggle('disabled', state.orderType === 'MARKET');
    if (pxInput) pxInput.required = state.orderType === 'LIMIT';

    setOrderSide(state.orderSide);
    updateOrderTicketCalculations();
  }

  function focusOrderTicket(side) {
    if (side) setOrderSide(side);
    const szInput = document.getElementById('order-size');
    if (szInput) {
      szInput.focus();
      szInput.select();
    }
  }

  function updateOrderTicketCalculations() {
    const pxInput = document.getElementById('order-price');
    const szInput = document.getElementById('order-size');
    const notionalEl = document.getElementById('order-notional');

    const ticker = state.tickersMap.get(state.activeSymbol);
    const mktPrice = ticker ? ticker.lastPrice : 0;
    const price = state.orderType === 'MARKET' ? mktPrice : Number(pxInput ? pxInput.value : mktPrice);
    const size = Number(szInput ? szInput.value : 0);

    const notional = Math.max(0, price * size);
    if (notionalEl) {
      notionalEl.textContent = ArgusComponents.formatCurrency(notional);
    }
  }

  async function submitOrderTicket(event) {
    if (event) event.preventDefault();

    const pxInput = document.getElementById('order-price');
    const szInput = document.getElementById('order-size');
    const tagInput = document.getElementById('order-client-tag');

    const ticker = state.tickersMap.get(state.activeSymbol);
    const price = state.orderType === 'MARKET'
      ? (ticker ? ticker.lastPrice : 0)
      : Number(pxInput ? pxInput.value : 0);
    const size = Number(szInput ? szInput.value : 0);
    const clientTag = tagInput && tagInput.value ? tagInput.value.trim() : 'DMA-ALPHA';

    if (!Number.isFinite(size) || size <= 0) {
      ArgusComponents.showToast('INVALID ORDER SIZE', 'Quantity must be greater than zero.', 'error');
      return;
    }

    if (state.orderType === 'LIMIT' && (!Number.isFinite(price) || price <= 0)) {
      ArgusComponents.showToast('INVALID LIMIT PRICE', 'Limit price must be greater than zero.', 'error');
      return;
    }

    try {
      const payload = {
        accountId: state.activeAccountId,
        symbol: state.activeSymbol,
        side: state.orderSide,
        type: state.orderType,
        price,
        size,
        clientTag
      };

      const res = await fetchJson('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const order = res.order || res;
      const fills = Array.isArray(res.fills) ? res.fills : [];
      const status = String(order.status || (fills.length > 0 ? 'FILLED' : 'OPEN')).toUpperCase();

      ArgusComponents.showToast(
        `ORDER ${status} // ${state.activeSymbol}`,
        `${state.orderSide} ${size} ${state.activeSymbol} @ ${state.orderType === 'MARKET' ? 'MKT' : ArgusComponents.formatPrice(price, state.activeSymbol)} (${fills.length} fills)`,
        'success'
      );

      await Promise.allSettled([
        loadPortfolio(),
        loadSymbolMarketData(state.activeSymbol, false)
      ]);
    } catch (err) {
      ArgusComponents.showToast('ORDER REJECTED', err.message || 'Execution engine error', 'error');
    }
  }

  async function flattenPositionMarket(symbol, qty) {
    const absQty = Math.abs(Number(qty));
    if (!symbol || absQty <= 0) return;
    const closeSide = Number(qty) > 0 ? 'SELL' : 'BUY';

    try {
      await fetchJson('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: state.activeAccountId,
          symbol,
          side: closeSide,
          type: 'MARKET',
          size: absQty,
          clientTag: 'FLATTEN-MKT'
        })
      });

      ArgusComponents.showToast(
        `POSITION CLOSED // ${symbol}`,
        `Executed ${closeSide} ${absQty} ${symbol} @ MARKET`,
        'success'
      );
      await Promise.allSettled([loadPortfolio(), loadSymbolMarketData(state.activeSymbol, false)]);
    } catch (err) {
      ArgusComponents.showToast('FLATTEN FAILED', err.message, 'error');
    }
  }

  async function cancelOrderById(orderId) {
    if (!orderId) return;
    try {
      await fetchJson(`/api/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
      ArgusComponents.showToast('ORDER CANCELLED', `Cancelled resting order ${orderId}`, 'info');
      await Promise.allSettled([loadPortfolio(), loadSymbolMarketData(state.activeSymbol, false)]);
    } catch (err) {
      ArgusComponents.showToast('CANCEL FAILED', err.message, 'error');
    }
  }

  async function cancelAllOpenOrders() {
    const openOrders = Array.isArray(state.portfolio.openOrders) ? state.portfolio.openOrders : [];
    if (openOrders.length === 0) {
      ArgusComponents.showToast('NO OPEN ORDERS', 'There are no open limit orders to cancel.', 'info');
      return;
    }

    await Promise.allSettled(
      openOrders.map((o) => {
        const id = o.id || o.orderId || o.order_id;
        return id ? fetchJson(`/api/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }) : Promise.resolve();
      })
    );

    ArgusComponents.showToast('CANCEL ALL COMPLETE', `Cancelled ${openOrders.length} open order(s).`, 'info');
    await Promise.allSettled([loadPortfolio(), loadSymbolMarketData(state.activeSymbol, false)]);
  }

  async function searchOrders(query) {
    const q = String(query || '').trim();
    if (!q) {
      ArgusComponents.renderOrdersBlotter(
        state.portfolio.openOrders || [],
        state.portfolio.recentFills || [],
        cancelOrderById
      );
      return;
    }

    try {
      const res = await fetchJson(`/api/orders/search?q=${encodeURIComponent(q)}`);
      const list = Array.isArray(res) ? res : res.orders || res.results || [];
      ArgusComponents.renderOrdersBlotter(list, [], cancelOrderById);
    } catch (_) {
      // Fallback client-side filter
      const all = [...(state.portfolio.openOrders || []), ...(state.portfolio.recentFills || [])];
      const filtered = all.filter((o) => JSON.stringify(o).toLowerCase().includes(q.toLowerCase()));
      ArgusComponents.renderOrdersBlotter(filtered, [], cancelOrderById);
    }
  }

  async function executeSqlQuery(queryText, silent = false) {
    const sqlInput = document.getElementById('sql-query-input');
    const query = String(queryText || (sqlInput ? sqlInput.value : '')).trim();
    if (!query) return;

    try {
      const result = await fetchJson('/api/sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      ArgusComponents.renderSqlResults(result);
      if (!silent) {
        ArgusComponents.showToast('SQL EXECUTED', `Returned ${(result.rows || []).length} rows in ${result.elapsedMs ?? 0.4}ms`, 'info');
      }
    } catch (err) {
      ArgusComponents.renderSqlResults({ error: err.message || 'SQL execution failed' });
      if (!silent) {
        ArgusComponents.showToast('SQL ERROR', err.message, 'error');
      }
    }
  }

  async function triggerWebhookTest() {
    try {
      const res = await fetchJson('/api/webhooks/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: `${window.location.origin}/api/health`,
          eventType: 'INSTITUTIONAL_EXECUTION_PING'
        })
      });
      ArgusComponents.showToast(
        'WEBHOOK DISPATCHED',
        `Status: ${res.status || res.statusCode || 200} // Delivered institutional payload`,
        'success'
      );
    } catch (err) {
      ArgusComponents.showToast('WEBHOOK PING', `Simulated webhook ping (${err.message})`, 'info');
    }
  }

  async function loadQuantAndAlgoTelemetry(silent = true) {
    try {
      const [riskRes, algosRes, slabRes] = await Promise.allSettled([
        fetchJson(`/api/quant/risk?accountId=${encodeURIComponent(state.activeAccountId)}&symbol=${encodeURIComponent(state.activeSymbol)}`),
        fetchJson('/api/algos'),
        fetchJson('/api/slab-metrics')
      ]);

      if (riskRes.status === 'fulfilled' && riskRes.value) {
        ArgusComponents.renderQuantRiskAndCopilot(riskRes.value, state.activeSymbol);
        if (!silent) {
          ArgusComponents.showToast(
            'QUANT RISK & COPILOT <GO>',
            `10,000-Path MC 99% VaR: $${Number(riskRes.value.var99 || 0).toLocaleString('en-US')} | VPIN: ${riskRes.value.vpin}`,
            'info'
          );
        }
      }

      const algosData = algosRes.status === 'fulfilled' ? algosRes.value : null;
      const slabData = slabRes.status === 'fulfilled' ? slabRes.value : null;
      ArgusComponents.renderAlgosAndSlab(algosData, slabData);
    } catch (_) {
      // Ignore transient telemetry error
    }
  }

  async function launchAlgoExecution(algoType = 'TWAP') {
    const szInput = document.getElementById('order-size');
    const totalSize = Math.max(0.1, Number(szInput ? szInput.value : 1.0) * 2);
    try {
      const res = await fetchJson('/api/algos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: state.activeAccountId,
          symbol: state.activeSymbol,
          type: algoType,
          strategy: algoType,
          side: state.orderSide,
          totalSize,
          slices: 4
        })
      });
      const algo = res.algo || res;
      ArgusComponents.showToast(
        `ALGO LAUNCHED // ${algoType}`,
        `${algo.id || algoType} executing ${totalSize} ${state.activeSymbol} (${state.orderSide})`,
        'success'
      );
      await Promise.allSettled([
        loadQuantAndAlgoTelemetry(true),
        loadPortfolio(),
        loadSymbolMarketData(state.activeSymbol, false)
      ]);
    } catch (err) {
      ArgusComponents.showToast('ALGO LAUNCH ERROR', err.message || 'Failed to start algo', 'error');
    }
  }

  async function runStrategyBacktestUi() {
    const sel = document.getElementById('quant-backtest-strategy');
    const strategy = sel ? sel.value : 'EMA_CROSS';
    try {
      const bt = await fetchJson('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: state.activeSymbol,
          strategy,
          initialCapital: 1000000
        })
      });
      ArgusComponents.renderBacktestResults(bt);
      ArgusComponents.showToast(
        `BACKTEST COMPLETE // ${strategy}`,
        `${state.activeSymbol}: Return ${bt.totalReturnPct >= 0 ? '+' : ''}${bt.totalReturnPct}% | Sharpe ${bt.sharpeRatio} | Sortino ${bt.sortinoRatio}`,
        'success'
      );
    } catch (err) {
      ArgusComponents.showToast('BACKTEST ERROR', err.message || 'Backtest failed', 'error');
    }
  }

  function openExecutiveDeck() {
    try {
      window.open('/deck.html', '_blank', 'noopener');
    } catch (_) {
      window.location.href = '/deck.html';
    }
    ArgusComponents.showToast('DECK <GO>', 'Opened Argus Institutional Executive Pitch Deck (/deck.html)', 'info');
  }

  function openOptionsWorkstation(section = 'surface') {
    const hash = section ? `#${section}` : '';
    const targetUrl = `/options.html?symbol=${encodeURIComponent(state.activeSymbol)}${hash}`;
    try {
      window.open(targetUrl, '_blank', 'noopener');
    } catch (_) {
      window.location.href = targetUrl;
    }
    const labelMap = {
      surface: '3D SVI Volatility Surface & BSM Options Chain',
      fix: 'FIX 4.4 Wire Protocol & 40-Byte SBE Inspector',
      sor: 'Multi-Venue Smart Order Router & Arbitrage Scanner'
    };
    ArgusComponents.showToast(
      `${String(section || 'OPT').toUpperCase()} <GO>`,
      `Opened ${labelMap[section] || 'Derivatives & FIX Workstation'} (/options.html)`,
      'info'
    );
  }

  // ==========================================================================
  // 6. UI EVENT BINDINGS, CLOCKS & KEYBOARD HOTKEYS
  // ==========================================================================

  function setupClocks() {
    const utcEl = document.getElementById('clock-utc');
    const wibEl = document.getElementById('clock-wib');

    const tickClocks = () => {
      const now = new Date();
      if (utcEl) {
        utcEl.textContent = now.toISOString().slice(11, 19);
      }
      if (wibEl) {
        const wibTime = new Date(now.getTime() + 7 * 3600 * 1000);
        wibEl.textContent = wibTime.toISOString().slice(11, 19);
      }
    };
    tickClocks();
    setInterval(tickClocks, 1000);
  }

  function setChartMode(mode) {
    chartEngine.setMode(mode);
    document.querySelectorAll('.chart-mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-chart-mode') === mode);
    });
  }

  function switchBlotterTab(tabName) {
    document.querySelectorAll('.blotter-tab').forEach((btn) => {
      const isTarget = btn.getAttribute('data-tab') === tabName;
      btn.classList.toggle('active', isTarget);
      btn.setAttribute('aria-selected', String(isTarget));
    });

    document.querySelectorAll('.blotter-panel').forEach((panel) => {
      const isTarget = panel.id === `tab-${tabName}`;
      panel.classList.toggle('active', isTarget);
      panel.hidden = !isTarget;
    });
  }

  function cycleWorkspaceLayout() {
    state.layoutIdx = (state.layoutIdx + 1) % state.layouts.length;
    const layoutName = state.layouts[state.layoutIdx];
    const grid = document.getElementById('main-workspace') || document.getElementById('workspace-grid') || document.querySelector('.workspace-grid');
    if (grid) {
      grid.setAttribute('data-layout', layoutName);
    }
    setTimeout(() => chartEngine.resize(), 40);
    ArgusComponents.showToast('WORKSPACE LAYOUT', `Switched tiling mode to: ${layoutName.toUpperCase()}`, 'info');
  }

  function bindHeaderAndCommandEvents() {
    const cmdForm = document.getElementById('go-command-form');
    const cmdInput = document.getElementById('go-command-input');
    const paletteBtn = document.getElementById('cmd-palette-trigger');
    const accountSelect = document.getElementById('account-select');

    if (cmdForm) {
      cmdForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (cmdInput && cmdInput.value.trim()) {
          executeCommandString(cmdInput.value);
          cmdInput.value = '';
        } else {
          openCommandPalette('');
        }
      });
    }

    const quickChipsContainer = document.querySelector('.cmd-quick-chips');
    if (quickChipsContainer && !quickChipsContainer.querySelector('[data-cmd="OPT <GO>"]')) {
      [
        { label: 'OPT', cmd: 'OPT <GO>', title: 'Open 3D Volatility Surface & Options Greeks Workstation (/options.html)' },
        { label: 'FIX', cmd: 'FIX <GO>', title: 'Open FIX 4.4 Wire & 40-Byte SBE Inspector (/options.html#fix)' },
        { label: 'ARB', cmd: 'ARB <GO>', title: 'Open Multi-Venue SOR & Arbitrage Scanner (/options.html#sor)' }
      ].forEach((item) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cmd-chip';
        btn.setAttribute('data-cmd', item.cmd);
        btn.title = item.title;
        btn.textContent = item.label;
        quickChipsContainer.appendChild(btn);
      });
    }

    document.querySelectorAll('.cmd-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const cmd = chip.getAttribute('data-cmd');
        if (cmd) executeCommandString(cmd);
      });
    });

    if (paletteBtn) {
      paletteBtn.addEventListener('click', () => openCommandPalette(''));
    }

    if (accountSelect) {
      accountSelect.addEventListener('change', () => {
        state.activeAccountId = accountSelect.value;
        loadPortfolio();
        ArgusComponents.showToast('ACCOUNT SWITCHED', `Active desk: ${state.activeAccountId}`, 'info');
      });
    }

    // Function Key Bar Clicks
    document.querySelectorAll('.fkey-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        handleFunctionAction(action);
      });
    });

    // Watchlist Asset Class Filters
    document.querySelectorAll('.mini-filter-btn[data-asset-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.assetFilter = btn.getAttribute('data-asset-filter') || 'ALL';
        document.querySelectorAll('.mini-filter-btn[data-asset-filter]').forEach((b) => {
          b.classList.toggle('active', b === btn);
        });
        ArgusComponents.renderWatchlist(state.tickersMap, state.activeSymbol, state.assetFilter, selectSymbol);
      });
    });

    // Command Palette Search Input & Arrow Key Navigation
    const paletteSearch = document.getElementById('palette-search-input');
    if (paletteSearch) {
      paletteSearch.addEventListener('input', () => {
        state.paletteSelectedIdx = 0;
        refreshPaletteList();
      });

      paletteSearch.addEventListener('keydown', (e) => {
        const len = state.paletteFiltered.length;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          state.paletteSelectedIdx = len > 0 ? (state.paletteSelectedIdx + 1) % len : 0;
          refreshPaletteList();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          state.paletteSelectedIdx = len > 0 ? (state.paletteSelectedIdx - 1 + len) % len : 0;
          refreshPaletteList();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const chosen = state.paletteFiltered[state.paletteSelectedIdx];
          const dialog = document.getElementById('cmd-dialog');
          if (dialog && dialog.open) dialog.close();
          if (chosen && typeof chosen.action === 'function') {
            chosen.action();
          } else if (paletteSearch.value.trim()) {
            executeCommandString(paletteSearch.value);
          }
        }
      });
    }
  }

  function bindChartToolbarEvents() {
    document.querySelectorAll('.chart-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-chart-mode');
        if (mode) setChartMode(mode);
      });
    });

    document.querySelectorAll('.overlay-toggle-btn[data-overlay]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-overlay');
        const active = chartEngine.toggleOverlay(key);
        btn.classList.toggle('active', active);
      });
    });

    const resetBtn = document.getElementById('chart-reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => chartEngine.resetView());
    }

    // Spread banner click sets mid-price
    const spreadBanner = document.getElementById('orderbook-spread-banner');
    if (spreadBanner) {
      spreadBanner.addEventListener('click', () => {
        const mid = state.orderbook.midPrice || (state.tickersMap.get(state.activeSymbol)?.lastPrice ?? 0);
        if (mid > 0) prefillOrderTicketPrice(Number(mid.toFixed(2)), 'MID');
      });
    }
  }

  function bindOrderTicketEvents() {
    const form = document.getElementById('order-entry-form');
    const buyBtn = document.getElementById('side-buy-btn');
    const sellBtn = document.getElementById('side-sell-btn');
    const pxInput = document.getElementById('order-price');
    const szInput = document.getElementById('order-size');

    if (buyBtn) buyBtn.addEventListener('click', () => setOrderSide('BUY'));
    if (sellBtn) sellBtn.addEventListener('click', () => setOrderSide('SELL'));

    document.querySelectorAll('.ticket-type-tabs .type-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-type');
        if (t) setOrderType(t);
      });
    });

    if (pxInput) pxInput.addEventListener('input', updateOrderTicketCalculations);
    if (szInput) szInput.addEventListener('input', updateOrderTicketCalculations);

    // Quick Price Anchor Buttons (BID / MID / ASK)
    document.querySelectorAll('.q-px-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const anchor = btn.getAttribute('data-px-anchor');
        const t = state.tickersMap.get(state.activeSymbol);
        if (!t) return;
        let targetPx = t.lastPrice;
        if (anchor === 'BID') targetPx = t.bid;
        else if (anchor === 'ASK') targetPx = t.ask;
        else if (anchor === 'MID') targetPx = Number(((t.bid + t.ask) / 2).toFixed(2));
        prefillOrderTicketPrice(targetPx, anchor);
      });
    });

    // Quick Size Allocation Buttons (25%, 50%, MAX)
    document.querySelectorAll('.q-sz-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pct = Number(btn.getAttribute('data-size-pct') || 0.25);
        const cash = Math.min(250000, Number(state.portfolio.account?.cashBalance || 100000));
        const t = state.tickersMap.get(state.activeSymbol);
        const px = Number((pxInput && pxInput.value) || (t ? t.lastPrice : 100));
        if (px > 0 && szInput) {
          const computedSz = Math.max(0.01, (cash * pct) / px);
          szInput.value = computedSz >= 10 ? computedSz.toFixed(1) : computedSz.toFixed(3);
          updateOrderTicketCalculations();
        }
      });
    });

    if (form) {
      form.addEventListener('submit', submitOrderTicket);
    }
  }

  function bindBlotterEvents() {
    document.querySelectorAll('.blotter-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const tabName = tab.getAttribute('data-tab');
        if (tabName) switchBlotterTab(tabName);
      });
    });

    const searchInput = document.getElementById('orders-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        searchOrders(searchInput.value);
      });
    }

    const refreshOrdersBtn = document.getElementById('refresh-orders-btn');
    if (refreshOrdersBtn) {
      refreshOrdersBtn.addEventListener('click', () => loadPortfolio());
    }

    const cancelAllBtn = document.getElementById('cancel-all-orders-btn');
    if (cancelAllBtn) {
      cancelAllBtn.addEventListener('click', () => cancelAllOpenOrders());
    }

    // SQL Console Presets & Execution
    document.querySelectorAll('.sql-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-sql-preset');
        const q = SQL_PRESETS[key];
        const sqlInput = document.getElementById('sql-query-input');
        document.querySelectorAll('.sql-preset-btn').forEach((b) => b.classList.toggle('active', b === btn));
        if (q && sqlInput) {
          sqlInput.value = q;
          executeSqlQuery(q, false);
        }
      });
    });

    const sqlRunBtn = document.getElementById('sql-run-btn');
    const sqlInput = document.getElementById('sql-query-input');
    if (sqlRunBtn) {
      sqlRunBtn.addEventListener('click', () => executeSqlQuery());
    }
    if (sqlInput) {
      sqlInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          executeSqlQuery();
        }
      });
    }

    // Tab 5: Quant Risk, Algo Execution & Backtester Controls
    const quantRefreshBtn = document.getElementById('quant-refresh-btn');
    if (quantRefreshBtn) {
      quantRefreshBtn.addEventListener('click', () => loadQuantAndAlgoTelemetry(false));
    }

    document.querySelectorAll('.algo-launch-btn[data-algo-type]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const algoType = btn.getAttribute('data-algo-type') || 'TWAP';
        launchAlgoExecution(algoType);
      });
    });

    const runBtBtn = document.getElementById('run-backtest-btn');
    if (runBtBtn) {
      runBtBtn.addEventListener('click', () => runStrategyBacktestUi());
    }
  }

  function handleFunctionAction(action) {
    switch (action) {
      case 'help':
      case 'open-palette':
        openCommandPalette('');
        break;
      case 'toggle-chart-mode': {
        const nextMode =
          chartEngine.mode === 'CANDLES' ? 'DEPTH' : chartEngine.mode === 'DEPTH' ? 'SPLIT' : 'CANDLES';
        setChartMode(nextMode);
        break;
      }
      case 'focus-order':
        focusOrderTicket();
        break;
      case 'tab-sql':
        switchBlotterTab('sql');
        break;
      case 'tab-news':
        switchBlotterTab('news');
        break;
      case 'tab-quant':
        switchBlotterTab('quant');
        loadQuantAndAlgoTelemetry(false);
        break;
      case 'cycle-layout':
        cycleWorkspaceLayout();
        break;
      case 'test-webhook':
        triggerWebhookTest();
        break;
      default:
        break;
    }
  }

  function bindGlobalKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement ? document.activeElement.tagName : '';
      const isInputFocused = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openCommandPalette('');
        return;
      }

      if (e.key === '/' && !isInputFocused) {
        e.preventDefault();
        const cmdInput = document.getElementById('go-command-input');
        if (cmdInput) cmdInput.focus();
        return;
      }

      if (e.key === 'F1') {
        e.preventDefault();
        handleFunctionAction('help');
      } else if (e.key === 'F2') {
        e.preventDefault();
        handleFunctionAction('toggle-chart-mode');
      } else if (e.key === 'F3') {
        e.preventDefault();
        handleFunctionAction('focus-order');
      } else if (e.key === 'F4') {
        e.preventDefault();
        handleFunctionAction('tab-sql');
      } else if (e.key === 'F5') {
        e.preventDefault();
        handleFunctionAction('tab-news');
      } else if (e.key === 'F6') {
        e.preventDefault();
        handleFunctionAction('cycle-layout');
      } else if (e.key === 'F7') {
        e.preventDefault();
        handleFunctionAction('test-webhook');
      } else if (e.key === 'F8') {
        e.preventDefault();
        handleFunctionAction('tab-quant');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
