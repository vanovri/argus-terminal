/**
 * ARGUS TERMINAL // UI COMPONENTS, BLOTTER, ORDERBOOK & SQL CONSOLE RENDERER
 * Handles DOM updates for:
 *  - Watchlist & Microstructure Telemetry Card
 *  - L2 Orderbook Depth Ladder + Click-to-Prefill Order Ticket
 *  - Time & Sales Live Execution Tape
 *  - Positions & Live Mark-to-Market PnL Blotter
 *  - Open Orders & Fills Blotter (with Cancel & Search)
 *  - Interactive SQLite Analytics Grid (with dynamic --label-* CSS variables)
 *  - Macro News Wire & Toast Notification Stack
 */

(function (global) {
  'use strict';

  const prevPrices = new Map();

  function escapeHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatPrice(val, symbol = 'BTC-USD') {
    const n = Number(val);
    if (!Number.isFinite(n)) return '--';
    if (symbol === 'IDR-USD') {
      return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    }
    if (n >= 1000) {
      return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (n >= 1) {
      return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
    }
    return n.toFixed(4);
  }

  function formatSize(val) {
    const n = Number(val);
    if (!Number.isFinite(n)) return '0.00';
    if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (Math.abs(n) >= 10) return n.toFixed(2);
    return n.toFixed(4);
  }

  function formatCurrency(val, signed = false) {
    const n = Number(val);
    if (!Number.isFinite(n)) return '$0.00';
    const absStr = Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    if (signed) {
      return (n >= 0 ? '+$' : '-$') + absStr;
    }
    return (n < 0 ? '-$' : '$') + absStr;
  }

  function formatTimestampMs(ts) {
    const d = ts ? new Date(Number(ts) || ts) : new Date();
    if (Number.isNaN(d.getTime())) return String(ts || 'LIVE');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function normalizeTicker(raw) {
    if (!raw) return null;
    const lastPrice = Number(raw.lastPrice ?? raw.last_price ?? raw.price ?? 0);
    const change24h = Number(raw.change24h ?? raw.change_24h ?? 0);
    const changePct24h = Number(raw.changePct24h ?? raw.change_pct_24h ?? 0);
    const spread = Number(raw.spread ?? Math.max(0.01, lastPrice * 0.0002));
    const bid = Number(raw.bid ?? (lastPrice - spread / 2));
    const ask = Number(raw.ask ?? (lastPrice + spread / 2));

    return {
      symbol: String(raw.symbol || 'BTC-USD'),
      name: String(raw.name || raw.symbol || 'Instrument'),
      assetClass: String(raw.assetClass || raw.asset_class || 'CRYPTO').toUpperCase(),
      lastPrice,
      change24h,
      changePct24h,
      high24h: Number(raw.high24h ?? raw.high_24h ?? lastPrice * 1.015),
      low24h: Number(raw.low24h ?? raw.low_24h ?? lastPrice * 0.985),
      volume24h: Number(raw.volume24h ?? raw.volume_24h ?? 1250),
      vwap: Number(raw.vwap ?? lastPrice),
      bid,
      ask,
      spread
    };
  }

  const ArgusComponents = {
    escapeHtml,
    formatPrice,
    formatSize,
    formatCurrency,
    formatTimestampMs,
    normalizeTicker,

    /**
     * Render Left Watchlist Table & Trigger Flash-on-Tick Animations
     */
    renderWatchlist(tickersMap, activeSymbol, assetFilter, onSelectSymbol) {
      const tbody = document.getElementById('watchlist-tbody');
      if (!tbody) return;

      const list = Array.from(tickersMap.values()).filter((t) => {
        if (!assetFilter || assetFilter === 'ALL') return true;
        if (assetFilter === 'CRYPTO') return t.assetClass.includes('CRYPTO');
        return !t.assetClass.includes('CRYPTO');
      });

      tbody.innerHTML = list
        .map((t) => {
          const prev = prevPrices.get(t.symbol);
          let flashClass = '';
          if (prev !== undefined && prev !== t.lastPrice) {
            flashClass = t.lastPrice > prev ? 'flash-up' : 'flash-down';
          }
          prevPrices.set(t.symbol, t.lastPrice);

          const isUp = t.changePct24h >= 0;
          const dirClass = isUp ? 'up' : 'down';
          const sign = isUp ? '+' : '';
          const activeClass = t.symbol === activeSymbol ? 'active-row' : '';

          return `
            <tr class="${activeClass} ${flashClass}" data-symbol="${escapeHtml(t.symbol)}">
              <th scope="row">
                <div class="sym-cell-main">
                  <span class="sym-ticker">${escapeHtml(t.symbol)}</span>
                  <span class="sym-asset-sub">${escapeHtml(t.name)}</span>
                </div>
              </th>
              <td class="num-col ${dirClass}" style="font-weight:700;">${formatPrice(t.lastPrice, t.symbol)}</td>
              <td class="num-col ${dirClass}">${sign}${t.changePct24h.toFixed(2)}%</td>
              <td class="num-col cyan">${formatPrice(t.vwap, t.symbol)}</td>
            </tr>
          `;
        })
        .join('');

      tbody.querySelectorAll('tr[data-symbol]').forEach((row) => {
        row.addEventListener('click', () => {
          const sym = row.getAttribute('data-symbol');
          if (sym && typeof onSelectSymbol === 'function') {
            onSelectSymbol(sym);
          }
        });
      });
    },

    /**
     * Update Active Instrument Telemetry Card & Chart Header Banner
     */
    renderActiveInstrumentHeader(ticker) {
      if (!ticker) return;
      const t = normalizeTicker(ticker);
      const isUp = t.changePct24h >= 0;
      const sign = isUp ? '+' : '';

      // Chart Header
      const badgeEl = document.getElementById('active-symbol-badge');
      const nameEl = document.getElementById('active-symbol-name');
      const pxEl = document.getElementById('active-symbol-price');
      const chgEl = document.getElementById('active-symbol-change');

      if (badgeEl) badgeEl.textContent = t.symbol;
      if (nameEl) nameEl.textContent = t.name;
      if (pxEl) {
        pxEl.textContent = formatPrice(t.lastPrice, t.symbol);
        pxEl.className = `active-live-px ${isUp ? 'up' : 'down'}`;
      }
      if (chgEl) {
        chgEl.textContent = `${sign}${formatPrice(t.change24h, t.symbol)} (${sign}${t.changePct24h.toFixed(2)}%)`;
        chgEl.className = `active-live-chg ${isUp ? 'pnl-pos' : 'pnl-neg'}`;
      }

      // Telemetry Card in Pane 1
      const setTxt = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };

      const spreadBps = t.lastPrice > 0 ? ((t.spread / t.lastPrice) * 10000).toFixed(1) : '0.5';
      setTxt('tele-symbol', t.symbol);
      setTxt('tele-class', t.assetClass);
      setTxt('tele-spread-bps', `SPREAD: ${spreadBps} bps`);
      setTxt('tele-high', formatPrice(t.high24h, t.symbol));
      setTxt('tele-low', formatPrice(t.low24h, t.symbol));
      setTxt('tele-vol', Number(t.volume24h).toLocaleString('en-US', { maximumFractionDigits: 1 }));
      setTxt('tele-vwap', formatPrice(t.vwap, t.symbol));
      setTxt('tele-bid', formatPrice(t.bid, t.symbol));
      setTxt('tele-ask', formatPrice(t.ask, t.symbol));

      // Order Ticket Labels
      setTxt('ticket-symbol-label', t.symbol);
      const baseAsset = t.symbol.split('-')[0] || 'UNIT';
      setTxt('size-sym-label', baseAsset);
    },

    /**
     * Render L2 Orderbook Depth Ladder with Click-to-Prefill Order Ticket Price
     */
    renderOrderbook(orderbook, symbol, onPriceClick) {
      if (!orderbook) return;
      const asksEl = document.getElementById('orderbook-asks');
      const bidsEl = document.getElementById('orderbook-bids');
      const midEl = document.getElementById('ob-mid-price');
      const spreadEl = document.getElementById('ob-spread-val');

      const rawAsks = Array.isArray(orderbook.asks) ? orderbook.asks.slice(0, 12) : [];
      const rawBids = Array.isArray(orderbook.bids) ? orderbook.bids.slice(0, 12) : [];

      // Ensure cumulative totals exist
      let askCum = 0;
      const asksAsc = rawAsks
        .map((a) => ({ price: Number(a.price), size: Number(a.size), total: Number(a.total || 0) }))
        .sort((a, b) => a.price - b.price)
        .map((a) => {
          askCum += a.size;
          return { price: a.price, size: a.size, total: a.total > 0 ? a.total : askCum };
        });

      let bidCum = 0;
      const bidsDesc = rawBids
        .map((b) => ({ price: Number(b.price), size: Number(b.size), total: Number(b.total || 0) }))
        .sort((a, b) => b.price - a.price)
        .map((b) => {
          bidCum += b.size;
          return { price: b.price, size: b.size, total: b.total > 0 ? b.total : bidCum };
        });

      const maxTotal = Math.max(
        0.0001,
        asksAsc.length ? asksAsc[asksAsc.length - 1].total : 0,
        bidsDesc.length ? bidsDesc[bidsDesc.length - 1].total : 0
      );

      // Update Bid/Ask Imbalance Meter
      const totalBidVol = bidsDesc.length ? bidsDesc[bidsDesc.length - 1].total : 1;
      const totalAskVol = asksAsc.length ? asksAsc[asksAsc.length - 1].total : 1;
      const bidPct = Math.round((totalBidVol / Math.max(0.0001, totalBidVol + totalAskVol)) * 100);
      const askPct = 100 - bidPct;

      const imbBidLbl = document.getElementById('imb-bid-pct');
      const imbAskLbl = document.getElementById('imb-ask-pct');
      const imbFill = document.getElementById('imbalance-fill-bid');
      if (imbBidLbl) imbBidLbl.textContent = `B: ${bidPct}%`;
      if (imbAskLbl) imbAskLbl.textContent = `A: ${askPct}%`;
      if (imbFill) imbFill.style.width = `${bidPct}%`;

      // Display Asks descending so lowest Ask sits right above the spread banner
      const asksDisplay = asksAsc.slice().reverse();

      if (asksEl) {
        asksEl.innerHTML = asksDisplay
          .map((lvl) => {
            const widthPct = Math.min(100, Math.max(2, (lvl.total / maxTotal) * 100)).toFixed(1);
            return `
              <div class="ob-row ob-row-ask" role="listitem" data-price="${lvl.price}" data-side="SELL" title="Click to prefill Order Price @ ${lvl.price}">
                <div class="ob-depth-bar" style="width: ${widthPct}%"></div>
                <span class="ob-px">${formatPrice(lvl.price, symbol)}</span>
                <span class="ob-sz">${formatSize(lvl.size)}</span>
                <span class="ob-tot">${formatSize(lvl.total)}</span>
              </div>
            `;
          })
          .join('');
      }

      if (bidsEl) {
        bidsEl.innerHTML = bidsDesc
          .map((lvl) => {
            const widthPct = Math.min(100, Math.max(2, (lvl.total / maxTotal) * 100)).toFixed(1);
            return `
              <div class="ob-row ob-row-bid" role="listitem" data-price="${lvl.price}" data-side="BUY" title="Click to prefill Order Price @ ${lvl.price}">
                <div class="ob-depth-bar" style="width: ${widthPct}%"></div>
                <span class="ob-px">${formatPrice(lvl.price, symbol)}</span>
                <span class="ob-sz">${formatSize(lvl.size)}</span>
                <span class="ob-tot">${formatSize(lvl.total)}</span>
              </div>
            `;
          })
          .join('');
      }

      const bestBid = bidsDesc[0] ? bidsDesc[0].price : 0;
      const bestAsk = asksAsc[0] ? asksAsc[0].price : 0;
      const midPrice = Number(orderbook.midPrice || (bestBid && bestAsk ? (bestBid + bestAsk) / 2 : bestBid || bestAsk));
      const spread = Number(orderbook.spread || (bestBid && bestAsk ? Math.max(0, bestAsk - bestBid) : 0));
      const spreadBps = midPrice > 0 ? ((spread / midPrice) * 10000).toFixed(1) : '0.0';

      if (midEl) midEl.textContent = formatPrice(midPrice, symbol);
      if (spreadEl) spreadEl.textContent = `SPREAD: ${formatPrice(spread, symbol)} (${spreadBps} bps)`;

      // Attach click handlers to prefill Order Entry Ticket
      const bindRowClicks = (container) => {
        if (!container) return;
        container.querySelectorAll('.ob-row[data-price]').forEach((row) => {
          row.addEventListener('click', () => {
            const px = Number(row.getAttribute('data-price'));
            const side = row.getAttribute('data-side');
            if (Number.isFinite(px) && typeof onPriceClick === 'function') {
              onPriceClick(px, side);
            }
          });
        });
      };
      bindRowClicks(asksEl);
      bindRowClicks(bidsEl);
    },

    /**
     * Render Time & Sales Trade Execution Tape
     */
    renderTradesTape(trades, symbol) {
      const container = document.getElementById('trades-tape-list');
      const countEl = document.getElementById('tape-count');
      if (!container) return;

      const list = Array.isArray(trades) ? trades.slice(0, 45) : [];
      if (countEl) countEl.textContent = `${list.length} PRINTS`;

      container.innerHTML = list
        .map((tr) => {
          const side = String(tr.side || 'BUY').toUpperCase();
          const isBuy = side === 'BUY';
          const price = Number(tr.price || 0);
          const size = Number(tr.size || 0);
          const isBlock = price * size >= 25000;
          return `
            <div class="tape-row ${isBlock ? 'block-trade' : ''}">
              <span class="tape-time">${formatTimestampMs(tr.timestamp || tr.created_at)}</span>
              <span class="${isBuy ? 'tape-side-buy' : 'tape-side-sell'}">${side}</span>
              <span class="num-col ${isBuy ? 'up' : 'down'}">${formatPrice(price, tr.symbol || symbol)}</span>
              <span class="num-col">${formatSize(size)}</span>
            </div>
          `;
        })
        .join('');
    },

    /**
     * Render Portfolio Header & Positions Blotter
     */
    renderPortfolioAndPositions(portfolio, tickersMap, onClosePosition, onSelectSymbol) {
      if (!portfolio) return;
      const acc = portfolio.account || {};
      const positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];

      let totalExposure = 0;
      let totalUnrealizedPnl = 0;

      const enrichedPositions = positions
        .filter((p) => Math.abs(Number(p.qty ?? p.size ?? 0)) > 0.000001)
        .map((p) => {
          const sym = p.symbol;
          const qty = Number(p.qty ?? p.size ?? 0);
          const avgEntry = Number(p.avgEntryPrice ?? p.avg_entry_price ?? p.entryPrice ?? 0);
          const liveTicker = tickersMap ? tickersMap.get(sym) : null;
          const markPrice = Number(liveTicker ? liveTicker.lastPrice : (p.markPrice ?? p.mark_price ?? avgEntry));
          const notional = Math.abs(qty) * markPrice;
          const unrealizedPnl = (markPrice - avgEntry) * qty;
          const costBasis = Math.max(0.01, Math.abs(qty) * avgEntry);
          const roePct = (unrealizedPnl / costBasis) * 100;

          totalExposure += notional;
          totalUnrealizedPnl += unrealizedPnl;

          return {
            symbol: sym,
            side: qty >= 0 ? 'LONG' : 'SHORT',
            qty,
            avgEntry,
            markPrice,
            notional,
            unrealizedPnl,
            roePct
          };
        });

      const cashBalance = Number(acc.cashBalance ?? acc.cash_balance ?? 10000000);
      const marginUsed = Number(acc.marginUsed ?? acc.margin_used ?? totalExposure * 0.1);
      const equity = Number(acc.equity ?? (cashBalance + totalUnrealizedPnl));

      // Header Pills
      const eqEl = document.getElementById('header-equity');
      const cashEl = document.getElementById('header-cash');
      const upnlEl = document.getElementById('header-upnl');
      const expEl = document.getElementById('blotter-total-exposure');
      const marEl = document.getElementById('blotter-margin-used');
      const posBadge = document.getElementById('badge-positions-count');

      if (eqEl) eqEl.textContent = formatCurrency(equity);
      if (cashEl) cashEl.textContent = formatCurrency(cashBalance);
      if (upnlEl) {
        upnlEl.textContent = formatCurrency(totalUnrealizedPnl, true);
        upnlEl.className = `metric-val ${totalUnrealizedPnl >= 0 ? 'pnl-pos' : 'pnl-neg'}`;
      }
      if (expEl) expEl.textContent = formatCurrency(totalExposure);
      if (marEl) marEl.textContent = formatCurrency(marginUsed);
      if (posBadge) posBadge.textContent = String(enrichedPositions.length);

      // Positions Table Body
      const tbody = document.getElementById('positions-tbody');
      if (!tbody) return;

      if (enrichedPositions.length === 0) {
        tbody.innerHTML = `
          <tr>
            <th scope="row">FLAT</th>
            <td colspan="8" style="color: var(--text-muted);">No active open positions for this account. Execute an order in P4 to open exposure.</td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = enrichedPositions
        .map((pos) => {
          const isPos = pos.unrealizedPnl >= 0;
          const pnlClass = isPos ? 'pnl-pos' : 'pnl-neg';
          const sideClass = pos.side === 'LONG' ? 'up' : 'down';
          const sign = isPos ? '+' : '';

          return `
            <tr data-pos-symbol="${escapeHtml(pos.symbol)}">
              <th scope="row" style="cursor:pointer;" class="amber">${escapeHtml(pos.symbol)}</th>
              <td class="${sideClass}" style="font-weight:800;">${pos.side}</td>
              <td class="num-col">${formatSize(pos.qty)}</td>
              <td class="num-col">${formatPrice(pos.avgEntry, pos.symbol)}</td>
              <td class="num-col cyan">${formatPrice(pos.markPrice, pos.symbol)}</td>
              <td class="num-col">${formatCurrency(pos.notional)}</td>
              <td class="num-col ${pnlClass}" style="font-weight:800;">${formatCurrency(pos.unrealizedPnl, true)}</td>
              <td class="num-col ${pnlClass}">${sign}${pos.roePct.toFixed(2)}%</td>
              <td class="action-col">
                <button type="button" class="btn-mini danger btn-flatten-pos" data-symbol="${escapeHtml(pos.symbol)}" data-qty="${pos.qty}">
                  CLOSE MKT
                </button>
              </td>
            </tr>
          `;
        })
        .join('');

      tbody.querySelectorAll('th[ scope="row" ]').forEach((th) => {
        th.addEventListener('click', () => {
          const tr = th.closest('tr');
          const sym = tr ? tr.getAttribute('data-pos-symbol') : null;
          if (sym && typeof onSelectSymbol === 'function') onSelectSymbol(sym);
        });
      });

      tbody.querySelectorAll('.btn-flatten-pos').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const sym = btn.getAttribute('data-symbol');
          const qty = Number(btn.getAttribute('data-qty'));
          if (sym && Number.isFinite(qty) && typeof onClosePosition === 'function') {
            onClosePosition(sym, qty);
          }
        });
      });
    },

    /**
     * Render Open Orders & Recent Fills Blotter
     */
    renderOrdersBlotter(openOrders, recentFills, onCancelOrder) {
      const tbody = document.getElementById('orders-tbody');
      const badgeEl = document.getElementById('badge-orders-count');
      if (!tbody) return;

      const openList = Array.isArray(openOrders) ? openOrders : [];
      const fillsList = Array.isArray(recentFills) ? recentFills : [];
      if (badgeEl) badgeEl.textContent = String(openList.length);

      // Combine open orders first, then recent filled/cancelled orders
      const seenIds = new Set();
      const combined = [];

      for (const o of openList) {
        const id = o.id || o.orderId || o.order_id;
        seenIds.add(id);
        combined.push(o);
      }
      for (const f of fillsList) {
        const id = f.id || f.orderId || f.order_id || `FILL-${Math.random()}`;
        if (!seenIds.has(id)) {
          seenIds.add(id);
          combined.push(f);
        }
      }

      if (combined.length === 0) {
        tbody.innerHTML = `
          <tr>
            <th scope="row">NONE</th>
            <td colspan="8" style="color: var(--text-muted);">No matching orders or execution fills found.</td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = combined
        .slice(0, 40)
        .map((o) => {
          const id = String(o.id || o.orderId || o.order_id || 'ORD');
          const symbol = String(o.symbol || 'BTC-USD');
          const side = String(o.side || 'BUY').toUpperCase();
          const type = String(o.type || 'LIMIT').toUpperCase();
          const price = Number(o.price || o.avgFillPrice || 0);
          const size = Number(o.size ?? o.qty ?? 0);
          const filled = Number(o.filledSize ?? o.filled_size ?? (o.status === 'FILLED' ? size : 0));
          const status = String(o.status || 'FILLED').toUpperCase();
          const clientTag = String(o.clientTag || o.client_tag || 'DMA');
          const timeStr = formatTimestampMs(o.createdAt || o.created_at || o.timestamp);

          const isOpen = status === 'OPEN' || status === 'PARTIAL' || status === 'NEW';
          const sideClass = side === 'BUY' ? 'up' : 'down';
          const statusClass = isOpen ? 'amber' : status === 'FILLED' ? 'up' : 'down';

          return `
            <tr>
              <th scope="row">${escapeHtml(id.slice(0, 12))}</th>
              <td style="font-weight:700;">${escapeHtml(symbol)}</td>
              <td class="${sideClass}" style="font-weight:800;">${escapeHtml(side)}</td>
              <td>${escapeHtml(type)}</td>
              <td class="num-col">${price > 0 ? formatPrice(price, symbol) : 'MKT'}</td>
              <td class="num-col">${formatSize(size)} / ${formatSize(filled)}</td>
              <td class="${statusClass}" style="font-weight:700;">${escapeHtml(status)}</td>
              <td>${escapeHtml(clientTag)} <span style="color:var(--text-muted);">(${escapeHtml(timeStr)})</span></td>
              <td class="action-col">
                ${
                  isOpen
                    ? `<button type="button" class="btn-mini danger btn-cancel-order" data-order-id="${escapeHtml(id)}">CANCEL</button>`
                    : `<span style="color:var(--text-muted);font-size:9px;">CLOSED</span>`
                }
              </td>
            </tr>
          `;
        })
        .join('');

      tbody.querySelectorAll('.btn-cancel-order').forEach((btn) => {
        btn.addEventListener('click', () => {
          const orderId = btn.getAttribute('data-order-id');
          if (orderId && typeof onCancelOrder === 'function') {
            onCancelOrder(orderId);
          }
        });
      });
    },

    /**
     * Render Interactive SQLite Query Results Table (with responsive-table CSS variables)
     */
    renderSqlResults(result) {
      const table = document.getElementById('sql-results-table');
      const thead = document.getElementById('sql-thead');
      const tbody = document.getElementById('sql-tbody');
      const statsBadge = document.getElementById('sql-stats-badge');
      if (!table || !thead || !tbody) return;

      if (result && result.error) {
        if (statsBadge) {
          statsBadge.textContent = 'SQL ERROR';
          statsBadge.style.color = 'var(--crimson)';
        }
        thead.innerHTML = '<tr><th scope="col">ERROR</th></tr>';
        tbody.innerHTML = `<tr><th scope="row" class="down">${escapeHtml(result.error)}</th></tr>`;
        return;
      }

      const rows = Array.isArray(result?.rows) ? result.rows : [];
      const columns =
        Array.isArray(result?.columns) && result.columns.length > 0
          ? result.columns
          : rows.length > 0
            ? Object.keys(rows[0])
            : ['RESULT'];

      const elapsedMs = Number(result?.elapsedMs ?? 0.4).toFixed(2);
      if (statsBadge) {
        statsBadge.textContent = `${rows.length} ROWS (${elapsedMs}ms)`;
        statsBadge.style.color = 'var(--emerald)';
      }

      // Dynamically inject --label-* CSS variables for responsive-table stacked container mode
      columns.forEach((col, idx) => {
        table.style.setProperty(`--label-${idx + 1}`, `"${String(col).replace(/"/g, '')}"`);
      });

      thead.innerHTML = `
        <tr>
          ${columns.map((c) => `<th scope="col">${escapeHtml(String(c).toUpperCase())}</th>`).join('')}
        </tr>
      `;

      if (rows.length === 0) {
        tbody.innerHTML = `
          <tr>
            <th scope="row">EMPTY</th>
            <td colspan="${Math.max(1, columns.length - 1)}" style="color:var(--text-muted);">Query executed successfully (0 rows returned).</td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = rows
        .map((row) => {
          return `
            <tr>
              ${columns
                .map((col, idx) => {
                  const rawVal = Array.isArray(row) ? row[idx] : row[col];
                  const valStr = rawVal === null || rawVal === undefined ? 'NULL' : String(rawVal);
                  if (idx === 0) {
                    return `<th scope="row" class="amber">${escapeHtml(valStr)}</th>`;
                  }
                  const isNum = typeof rawVal === 'number' || (!Number.isNaN(Number(rawVal)) && valStr.trim() !== '');
                  return `<td class="${isNum ? 'num-col cyan' : ''}">${escapeHtml(valStr)}</td>`;
                })
                .join('')}
            </tr>
          `;
        })
        .join('');
    },

    /**
     * Render Macro News Wire Feed & Update Top Ribbon Headline
     */
    renderNewsWire(newsItems) {
      const container = document.getElementById('news-wire-list');
      const badgeEl = document.getElementById('badge-news-count');
      const ribbonEl = document.getElementById('ribbon-headline-text');
      if (!container) return;

      const list = Array.isArray(newsItems) ? newsItems : [];
      if (badgeEl) badgeEl.textContent = String(list.length);

      if (list.length > 0 && ribbonEl) {
        const latest = list[0];
        ribbonEl.textContent = `[${latest.source || 'ARGUS WIRE'}] ${latest.headline || latest.title || ''}`;
      }

      container.innerHTML = list
        .map((item) => {
          const sentiment = String(item.sentiment || item.category || 'MACRO').toUpperCase();
          const badgeClass =
            sentiment.includes('BULL') || sentiment.includes('POS')
              ? 'bullish'
              : sentiment.includes('BEAR') || sentiment.includes('NEG')
                ? 'bearish'
                : 'macro';
          const headline = item.headline || item.title || 'Institutional market update';
          const source = item.source || 'BLOOMBERG // ARGUS';
          const ts = formatTimestampMs(item.timestamp || item.created_at);

          return `
            <article class="news-wire-item">
              <span class="news-time">${escapeHtml(ts)}</span>
              <span class="news-badge ${badgeClass}">${escapeHtml(sentiment)}</span>
              <span class="news-headline">${escapeHtml(headline)}</span>
              <span class="news-source">${escapeHtml(source)}</span>
            </article>
          `;
        })
        .join('');
    },

    /**
     * Render Command Palette Modal List
     */
    renderCommandPalette(commands, filterQuery, selectedIdx, onExecuteCommand) {
      const listEl = document.getElementById('palette-command-list');
      if (!listEl) return [];

      const q = (filterQuery || '').trim().toLowerCase();
      const filtered = commands.filter((cmd) => {
        if (!q) return true;
        return (
          cmd.code.toLowerCase().includes(q) ||
          cmd.desc.toLowerCase().includes(q) ||
          cmd.category.toLowerCase().includes(q)
        );
      });

      listEl.innerHTML = filtered
        .map((cmd, idx) => {
          const isSelected = idx === selectedIdx;
          return `
            <div class="palette-item ${isSelected ? 'selected' : ''}" role="option" aria-selected="${isSelected}" data-cmd-idx="${idx}">
              <div>
                <div class="palette-cmd-code">${escapeHtml(cmd.code)}</div>
                <div class="palette-cmd-desc">${escapeHtml(cmd.desc)}</div>
              </div>
              <span class="palette-cmd-cat">${escapeHtml(cmd.category)}</span>
            </div>
          `;
        })
        .join('');

      listEl.querySelectorAll('.palette-item[data-cmd-idx]').forEach((item) => {
        item.addEventListener('click', () => {
          const idx = Number(item.getAttribute('data-cmd-idx'));
          const target = filtered[idx];
          if (target && typeof onExecuteCommand === 'function') {
            onExecuteCommand(target);
          }
        });
      });

      return filtered;
    },

    /**
     * Render Tab 5: Live Monte Carlo VaR/CVaR, VPIN Toxicity, OBI Skew, Micro-Price & AI Quant Copilot
     */
    renderQuantRiskAndCopilot(data, symbol = 'BTC-USD') {
      if (!data) return;
      const setTxt = (id, val, cls = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = val;
        if (cls) el.className = cls;
      };

      const mc = data.monteCarlo || data;
      const micro = data.microstructure || data;
      const copilot = data.copilot || data.briefing || {};

      const var95 = Number(mc.var95 ?? data.var95 ?? 38420);
      const var99 = Number(mc.var99 ?? data.var99 ?? 54180);
      const cvar99 = Number(mc.cvar99 ?? data.cvar99 ?? 63910);
      const vpin = Number(micro.vpin ?? data.vpin ?? 0.284);
      const vpinRegime = String(micro.vpinRegime || data.vpinRegime || copilot.regime || 'NORMAL');
      const obi = Number(micro.obi ?? data.obi ?? 0);
      const microPrice = Number(micro.microPrice ?? data.microPrice ?? 94500);
      const kyleBps = Number(micro.kyleLambdaBpsPer100k ?? data.kyleLambdaBpsPer100k ?? 1.45);
      const kellyPct = Number(copilot.kellyPct ?? (Number(copilot.kellyFraction || 0.184) * 100));
      const halfKellyPct = Number(copilot.halfKellyPct ?? (Number(copilot.halfKellyFraction || 0.092) * 100));

      setTxt('quant-var95', formatCurrency(var95));
      setTxt('quant-var99', formatCurrency(var99));
      setTxt('quant-cvar99', formatCurrency(cvar99));
      setTxt(
        'quant-vpin',
        `${vpin.toFixed(3)} (${vpinRegime})`,
        `quant-val ${vpinRegime === 'TOXIC' || vpinRegime === 'ELEVATED' ? 'down' : 'cyan'}`
      );
      const obiSign = obi >= 0 ? '+' : '';
      setTxt(
        'quant-obi',
        `${obiSign}${(obi * 100).toFixed(1)}%`,
        `quant-val ${obi >= 0 ? 'up' : 'down'}`
      );
      setTxt('quant-micro-price', formatPrice(microPrice, symbol));
      setTxt('quant-kyle-lambda', `${kyleBps.toFixed(2)} bps/$100k`);
      setTxt('quant-kelly', `${kellyPct.toFixed(1)}% / ${halfKellyPct.toFixed(1)}%`);

      const badgeRegime = document.getElementById('badge-quant-regime');
      if (badgeRegime) {
        badgeRegime.textContent = vpinRegime;
      }

      if (copilot.headline) {
        setTxt('quant-copilot-regime', `AI QUANT COPILOT // REGIME: ${vpinRegime}`);
        setTxt('quant-copilot-algo', `ROUTER: ${copilot.recommendedAlgo || 'AVELLANEDA_STOIKOV'}`);
        setTxt('quant-copilot-headline', copilot.headline);
        setTxt('quant-copilot-summary', copilot.summary || '');
      }
    },

    /**
     * Render Tab 5: Strategy Backtester Results (Sharpe, Sortino, Max Drawdown, Return %)
     */
    renderBacktestResults(bt) {
      if (!bt) return;
      const setTxt = (id, val, cls = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = val;
        if (cls) el.className = cls;
      };

      const sharpe = Number(bt.sharpeRatio ?? 2.42);
      const sortino = Number(bt.sortinoRatio ?? 3.58);
      const maxDd = Number(bt.maxDrawdownPct ?? 1.84);
      const retPct = Number(bt.totalReturnPct ?? 6.45);
      const winRate = Number(bt.winRatePct ?? 64.2);
      const trades = Number(bt.tradeCount ?? 18);

      setTxt('bt-sharpe', sharpe.toFixed(2), `quant-val ${sharpe >= 1.5 ? 'up' : 'amber'}`);
      setTxt('bt-sortino', sortino.toFixed(2), `quant-val ${sortino >= 2.0 ? 'up' : 'amber'}`);
      setTxt('bt-maxdd', `-${Math.abs(maxDd).toFixed(2)}%`, 'quant-val down');
      setTxt(
        'bt-return',
        `${retPct >= 0 ? '+' : ''}${retPct.toFixed(2)}%`,
        `quant-val ${retPct >= 0 ? 'up' : 'down'}`
      );
      setTxt('bt-winrate', `${winRate.toFixed(1)}% (${trades})`, 'quant-val cyan');
    },

    /**
     * Render Tab 5: Active Algorithmic Executions & Slab Orderbook Telemetry
     */
    renderAlgosAndSlab(algosPayload, slabPayload) {
      if (slabPayload) {
        const slabEl = document.getElementById('quant-slab-pill');
        if (slabEl) {
          const ops = Number(slabPayload.benchmark?.matchOpsPerSec || slabPayload.matchOpsPerSec || 1845000);
          const opsM = (ops / 1e6).toFixed(2);
          slabEl.textContent = `SLAB L3: ${opsM}M OPS/S (0 GC)`;
        }
      }

      const listEl = document.getElementById('quant-algo-list');
      if (!listEl) return;

      const list = Array.isArray(algosPayload)
        ? algosPayload
        : Array.isArray(algosPayload?.algos)
          ? algosPayload.algos
          : Array.isArray(algosPayload?.executions)
            ? algosPayload.executions
            : [];

      if (list.length === 0) {
        listEl.innerHTML = `<div class="algo-item-row"><span style="color:var(--text-muted);">No active algorithmic executions. Launch TWAP, VWAP, or Avellaneda-Stoikov MM above.</span></div>`;
        return;
      }

      listEl.innerHTML = list
        .slice(0, 5)
        .map((a) => {
          const type = String(a.type || a.strategy || 'TWAP');
          const sym = String(a.symbol || 'BTC-USD');
          const side = String(a.side || 'BUY');
          const filled = Number(a.filledSize ?? a.size ?? 1.0);
          const total = Number(a.totalSize ?? a.size ?? 1.0);
          const status = String(a.status || 'ACTIVE');
          const px = Number(a.avgFillPrice || a.reservationPrice || 0);
          const statusCls = status === 'ACTIVE' ? 'amber' : 'up';
          return `
            <div class="algo-item-row">
              <span class="amber" style="font-weight:800;">${escapeHtml(type)} // ${escapeHtml(sym)}</span>
              <span>${escapeHtml(side)} ${formatSize(filled)}/${formatSize(total)} ${px > 0 ? `@ ${formatPrice(px, sym)}` : ''}</span>
              <span class="${statusCls}" style="font-weight:800;">${escapeHtml(status)}</span>
            </div>
          `;
        })
        .join('');
    },

    /**
     * Institutional Toast Notification
     */
    showToast(title, message, type = 'info') {
      const container = document.getElementById('toast-container');
      if (!container) return;

      const toast = document.createElement('div');
      toast.className = `terminal-toast toast-${type}`;
      const timeStr = new Date().toISOString().slice(11, 19);
      toast.innerHTML = `
        <div class="toast-title">
          <span>${escapeHtml(title)}</span>
          <span style="color:var(--text-muted);font-size:9px;">${timeStr} UTC</span>
        </div>
        <div class="toast-msg">${escapeHtml(message)}</div>
      `;

      container.appendChild(toast);
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 3600);
    }
  };

  global.ArgusComponents = ArgusComponents;
})(window);
