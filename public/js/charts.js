/**
 * ARGUS TERMINAL // HIGH-DPI CANVAS 2D CHART & L2 MARKET DEPTH ENGINE
 * Renders:
 *  - Mode "CANDLES": OHLCV Candlesticks + Volume Histogram + EMA(9) + EMA(21) + VWAP + Crosshair HUD
 *  - Mode "DEPTH":   L2 Cumulative Bid/Ask Liquidity Walls + Mid-Price Laser + Hover Depth Readout
 *  - Mode "SPLIT":   Dual Split-View (Left 64% OHLCV Candles, Right 36% L2 Cumulative Depth Wall)
 */

(function (global) {
  'use strict';

  class ArgusChartEngine {
    constructor(canvasId) {
      this.canvas = document.getElementById(canvasId);
      this.ctx = this.canvas ? this.canvas.getContext('2d') : null;

      this.symbol = 'BTC-USD';
      this.mode = 'CANDLES'; // 'CANDLES' | 'DEPTH' | 'SPLIT'
      this.candles = [];
      this.orderbook = { bids: [], asks: [], midPrice: 0, spread: 0 };

      this.overlays = {
        ema: true,
        vwap: true,
        volume: true
      };

      // Viewport & interaction state
      this.visibleBars = 68;
      this.panOffset = 0; // bars shifted back from latest
      this.mouse = { x: -1, y: -1, active: false, isDragging: false, dragStartX: 0, dragStartOffset: 0 };

      // Cached HUD DOM nodes
      this.hud = {
        time: document.getElementById('hud-time'),
        open: document.getElementById('hud-open'),
        high: document.getElementById('hud-high'),
        low: document.getElementById('hud-low'),
        close: document.getElementById('hud-close'),
        vol: document.getElementById('hud-vol'),
        ema9: document.getElementById('hud-ema9'),
        ema21: document.getElementById('hud-ema21')
      };

      this.colors = {
        bg: '#060910',
        grid: '#101726',
        gridStrong: '#192338',
        axisText: '#697a96',
        amber: '#ff9e00',
        cyan: '#00d2ff',
        purple: '#b388ff',
        emerald: '#00e676',
        emeraldFill: 'rgba(0, 230, 118, 0.22)',
        crimson: '#ff3b5c',
        crimsonFill: 'rgba(255, 59, 92, 0.22)',
        crosshair: 'rgba(230, 237, 247, 0.42)'
      };

      this._rafId = null;
      this._initEvents();
      this.resize();
    }

    _initEvents() {
      if (!this.canvas) return;

      const stage = this.canvas.parentElement;
      if (typeof ResizeObserver !== 'undefined' && stage) {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(stage);
      }
      window.addEventListener('resize', () => this.resize());

      this.canvas.addEventListener('mousemove', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.x = e.clientX - rect.left;
        this.mouse.y = e.clientY - rect.top;
        this.mouse.active = true;

        if (this.mouse.isDragging && this.candles.length > 0) {
          const dx = this.mouse.x - this.mouse.dragStartX;
          const barPitch = Math.max(4, (rect.width - 70) / this.visibleBars);
          const deltaBars = Math.round(dx / barPitch);
          const maxOffset = Math.max(0, this.candles.length - Math.min(20, this.candles.length));
          this.panOffset = Math.max(0, Math.min(maxOffset, this.mouse.dragStartOffset + deltaBars));
        }

        this.scheduleRender();
      });

      this.canvas.addEventListener('mousedown', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        this.mouse.isDragging = true;
        this.mouse.dragStartX = e.clientX - rect.left;
        this.mouse.dragStartOffset = this.panOffset;
      });

      window.addEventListener('mouseup', () => {
        this.mouse.isDragging = false;
      });

      this.canvas.addEventListener('mouseleave', () => {
        this.mouse.active = false;
        this.mouse.isDragging = false;
        this._updateHudFromCandle(this.candles[this.candles.length - 1], null, null);
        this.scheduleRender();
      });

      this.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.12 : 0.88;
        this.visibleBars = Math.max(20, Math.min(150, Math.round(this.visibleBars * factor)));
        this.scheduleRender();
      }, { passive: false });
    }

    resize() {
      if (!this.canvas || !this.ctx) return;
      const stage = this.canvas.parentElement;
      const width = stage ? stage.clientWidth : 640;
      const height = stage ? stage.clientHeight : 360;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

      this.width = Math.max(200, width);
      this.height = Math.max(140, height);

      this.canvas.width = Math.floor(this.width * dpr);
      this.canvas.height = Math.floor(this.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this.scheduleRender();
    }

    setMode(mode) {
      if (['CANDLES', 'DEPTH', 'SPLIT'].includes(mode)) {
        this.mode = mode;
        this.scheduleRender();
      }
    }

    toggleOverlay(key) {
      if (key in this.overlays) {
        this.overlays[key] = !this.overlays[key];
        this.scheduleRender();
        return this.overlays[key];
      }
      return false;
    }

    resetView() {
      this.visibleBars = 68;
      this.panOffset = 0;
      this.scheduleRender();
    }

    setSymbol(symbol) {
      if (this.symbol !== symbol) {
        this.symbol = symbol;
        this.panOffset = 0;
      }
    }

    setCandles(candles) {
      if (!Array.isArray(candles)) return;
      this.candles = candles
        .map((c) => ({
          time: Number(c.time || c.timestamp || Date.now()),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          volume: Number(c.volume || 0)
        }))
        .sort((a, b) => a.time - b.time);

      this._computeIndicators();
      if (!this.mouse.active && this.candles.length > 0) {
        const lastIdx = this.candles.length - 1;
        this._updateHudFromCandle(
          this.candles[lastIdx],
          this.ema9 ? this.ema9[lastIdx] : null,
          this.ema21 ? this.ema21[lastIdx] : null
        );
      }
      this.scheduleRender();
    }

    updateLiveCandle(candle) {
      if (!candle) return;
      const normalized = {
        time: Number(candle.time || candle.timestamp || Date.now()),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume || 0)
      };

      if (this.candles.length === 0) {
        this.candles.push(normalized);
      } else {
        const last = this.candles[this.candles.length - 1];
        if (Math.abs(normalized.time - last.time) < 900) {
          this.candles[this.candles.length - 1] = normalized;
        } else if (normalized.time > last.time) {
          this.candles.push(normalized);
          if (this.candles.length > 240) this.candles.shift();
        }
      }

      this._computeIndicators();
      if (!this.mouse.active && this.candles.length > 0) {
        const idx = this.candles.length - 1;
        this._updateHudFromCandle(this.candles[idx], this.ema9[idx], this.ema21[idx]);
      }
      this.scheduleRender();
    }

    updateLiveTickPrice(price, volumeDelta = 0.05) {
      const px = Number(price);
      if (!Number.isFinite(px) || px <= 0 || this.candles.length === 0) return;
      const last = this.candles[this.candles.length - 1];
      last.close = px;
      if (px > last.high) last.high = px;
      if (px < last.low) last.low = px;
      last.volume = Number((last.volume + volumeDelta).toFixed(4));

      this._computeIndicators();
      if (!this.mouse.active) {
        const idx = this.candles.length - 1;
        this._updateHudFromCandle(last, this.ema9[idx], this.ema21[idx]);
      }
      this.scheduleRender();
    }

    setOrderbook(orderbook) {
      if (!orderbook) return;
      this.orderbook = {
        bids: Array.isArray(orderbook.bids) ? orderbook.bids : [],
        asks: Array.isArray(orderbook.asks) ? orderbook.asks : [],
        midPrice: Number(orderbook.midPrice || 0),
        spread: Number(orderbook.spread || 0)
      };
      if (this.mode === 'DEPTH' || this.mode === 'SPLIT') {
        this.scheduleRender();
      }
    }

    _computeIndicators() {
      const len = this.candles.length;
      this.ema9 = new Array(len).fill(null);
      this.ema21 = new Array(len).fill(null);
      this.vwapSeries = new Array(len).fill(null);

      if (len === 0) return;

      const k9 = 2 / (9 + 1);
      const k21 = 2 / (21 + 1);
      let prevEma9 = this.candles[0].close;
      let prevEma21 = this.candles[0].close;
      let cumPV = 0;
      let cumVol = 0;

      for (let i = 0; i < len; i++) {
        const c = this.candles[i];
        prevEma9 = i === 0 ? c.close : c.close * k9 + prevEma9 * (1 - k9);
        prevEma21 = i === 0 ? c.close : c.close * k21 + prevEma21 * (1 - k21);
        this.ema9[i] = prevEma9;
        this.ema21[i] = prevEma21;

        const typicalPrice = (c.high + c.low + c.close) / 3;
        const v = Math.max(0.0001, c.volume);
        cumPV += typicalPrice * v;
        cumVol += v;
        this.vwapSeries[i] = cumPV / cumVol;
      }
    }

    _formatPrice(val) {
      const n = Number(val);
      if (!Number.isFinite(n)) return '--';
      if (this.symbol === 'IDR-USD') return n.toFixed(1);
      if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (n >= 10) return n.toFixed(2);
      return n.toFixed(4);
    }

    _formatTime(ts) {
      if (!ts) return 'LIVE';
      const d = new Date(Number(ts));
      if (Number.isNaN(d.getTime())) return 'LIVE';
      return d.toISOString().slice(11, 19);
    }

    _updateHudFromCandle(candle, ema9Val, ema21Val) {
      if (!candle || !this.hud.open) return;
      const isUp = candle.close >= candle.open;
      const dirColor = isUp ? this.colors.emerald : this.colors.crimson;

      this.hud.time.textContent = this._formatTime(candle.time);
      this.hud.open.textContent = this._formatPrice(candle.open);
      this.hud.high.textContent = this._formatPrice(candle.high);
      this.hud.low.textContent = this._formatPrice(candle.low);
      this.hud.close.textContent = this._formatPrice(candle.close);
      this.hud.close.style.color = dirColor;
      this.hud.vol.textContent = Number(candle.volume || 0).toFixed(2);
      this.hud.ema9.textContent = ema9Val != null ? this._formatPrice(ema9Val) : '--';
      this.hud.ema21.textContent = ema21Val != null ? this._formatPrice(ema21Val) : '--';
    }

    scheduleRender() {
      if (this._rafId) return;
      this._rafId = window.requestAnimationFrame(() => {
        this._rafId = null;
        this.render();
      });
    }

    render() {
      if (!this.ctx || !this.width || !this.height) return;
      const ctx = this.ctx;

      // Clear background
      ctx.fillStyle = this.colors.bg;
      ctx.fillRect(0, 0, this.width, this.height);

      if (this.mode === 'CANDLES') {
        this._renderCandlesPane(0, 0, this.width, this.height);
      } else if (this.mode === 'DEPTH') {
        this._renderDepthPane(0, 0, this.width, this.height);
      } else if (this.mode === 'SPLIT') {
        const splitX = Math.floor(this.width * 0.62);
        this._renderCandlesPane(0, 0, splitX, this.height);
        // Divider line
        ctx.strokeStyle = '#1f293d';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(splitX + 0.5, 0);
        ctx.lineTo(splitX + 0.5, this.height);
        ctx.stroke();
        this._renderDepthPane(splitX + 1, 0, this.width - splitX - 1, this.height);
      }
    }

    _renderCandlesPane(x0, y0, w, h) {
      const ctx = this.ctx;
      const rightAxisW = 66;
      const bottomAxisH = 20;
      const plotW = Math.max(60, w - rightAxisW);
      const plotH = Math.max(60, h - bottomAxisH);

      if (this.candles.length === 0) {
        ctx.fillStyle = this.colors.axisText;
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`SYNCHRONIZING ${this.symbol} OHLCV STREAM...`, x0 + w / 2, y0 + h / 2);
        return;
      }

      const endIdx = Math.max(1, this.candles.length - this.panOffset);
      const startIdx = Math.max(0, endIdx - this.visibleBars);
      const slice = this.candles.slice(startIdx, endIdx);
      if (slice.length === 0) return;

      let minPrice = Infinity;
      let maxPrice = -Infinity;
      let maxVol = 0.0001;

      for (let i = 0; i < slice.length; i++) {
        const c = slice[i];
        const gIdx = startIdx + i;
        if (c.low < minPrice) minPrice = c.low;
        if (c.high > maxPrice) maxPrice = c.high;
        if (this.overlays.ema && this.ema21[gIdx] != null) {
          minPrice = Math.min(minPrice, this.ema9[gIdx], this.ema21[gIdx]);
          maxPrice = Math.max(maxPrice, this.ema9[gIdx], this.ema21[gIdx]);
        }
        if (c.volume > maxVol) maxVol = c.volume;
      }

      const priceSpan = Math.max(0.0001, maxPrice - minPrice);
      minPrice -= priceSpan * 0.07;
      maxPrice += priceSpan * 0.07;
      const paddedSpan = Math.max(0.0001, maxPrice - minPrice);

      const priceRegionH = this.overlays.volume ? Math.floor(plotH * 0.77) : plotH;
      const volRegionTop = y0 + priceRegionH + 4;
      const volRegionH = plotH - priceRegionH - 4;

      const priceToY = (p) => y0 + priceRegionH - ((p - minPrice) / paddedSpan) * priceRegionH;
      const yToPrice = (py) => maxPrice - ((py - y0) / priceRegionH) * paddedSpan;

      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, w, h);
      ctx.clip();

      // 1. Horizontal Price Grid & Right Gutter Labels
      const hSteps = 6;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.lineWidth = 1;

      for (let i = 0; i <= hSteps; i++) {
        const ratio = i / hSteps;
        const py = Math.floor(y0 + ratio * priceRegionH) + 0.5;
        const pVal = maxPrice - ratio * paddedSpan;

        ctx.strokeStyle = this.colors.grid;
        ctx.beginPath();
        ctx.moveTo(x0, py);
        ctx.lineTo(x0 + plotW, py);
        ctx.stroke();

        ctx.fillStyle = this.colors.axisText;
        ctx.fillText(this._formatPrice(pVal), x0 + plotW + 5, py + 3);
      }

      // Volume separator line
      if (this.overlays.volume) {
        ctx.strokeStyle = this.colors.gridStrong;
        ctx.beginPath();
        ctx.moveTo(x0, y0 + priceRegionH + 0.5);
        ctx.lineTo(x0 + plotW, y0 + priceRegionH + 0.5);
        ctx.stroke();
      }

      // 2. Vertical Time Grid & Candles
      const stepX = plotW / Math.max(1, slice.length);
      const bodyW = Math.max(2, Math.min(14, Math.floor(stepX * 0.68)));
      const labelInterval = Math.max(1, Math.floor(slice.length / 5));

      for (let i = 0; i < slice.length; i++) {
        const c = slice[i];
        const cx = Math.floor(x0 + (i + 0.5) * stepX) + 0.5;

        if (i % labelInterval === 0) {
          ctx.strokeStyle = this.colors.grid;
          ctx.beginPath();
          ctx.moveTo(cx, y0);
          ctx.lineTo(cx, y0 + plotH);
          ctx.stroke();

          ctx.fillStyle = this.colors.axisText;
          ctx.textAlign = 'center';
          ctx.fillText(this._formatTime(c.time), cx, y0 + plotH + 13);
        }

        const isUp = c.close >= c.open;
        const color = isUp ? this.colors.emerald : this.colors.crimson;

        // Volume bar
        if (this.overlays.volume && volRegionH > 8) {
          const vH = Math.max(1, (c.volume / maxVol) * (volRegionH - 2));
          ctx.fillStyle = isUp ? this.colors.emeraldFill : this.colors.crimsonFill;
          ctx.fillRect(cx - bodyW / 2, y0 + plotH - vH, bodyW, vH);
        }

        // High-Low Wick
        const highY = priceToY(c.high);
        const lowY = priceToY(c.low);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, highY);
        ctx.lineTo(cx, lowY);
        ctx.stroke();

        // Open-Close Body
        const openY = priceToY(c.open);
        const closeY = priceToY(c.close);
        const topY = Math.min(openY, closeY);
        const bHeight = Math.max(1.5, Math.abs(closeY - openY));
        ctx.fillStyle = color;
        ctx.fillRect(cx - bodyW / 2, topY, bodyW, bHeight);
      }

      // 3. Technical Overlays: Session VWAP, EMA 21, EMA 9
      if (this.overlays.vwap) {
        this._drawIndicatorLine(startIdx, slice.length, stepX, x0, priceToY, this.vwapSeries, this.colors.purple, [4, 3]);
      }
      if (this.overlays.ema) {
        this._drawIndicatorLine(startIdx, slice.length, stepX, x0, priceToY, this.ema21, this.colors.cyan, []);
        this._drawIndicatorLine(startIdx, slice.length, stepX, x0, priceToY, this.ema9, this.colors.amber, []);
      }

      // 4. Live Last Price Laser Line & Right Gutter Pill
      const latestCandle = this.candles[this.candles.length - 1];
      if (latestCandle) {
        const lastY = priceToY(latestCandle.close);
        if (lastY >= y0 && lastY <= y0 + priceRegionH) {
          const isUp = latestCandle.close >= latestCandle.open;
          const laserColor = isUp ? this.colors.emerald : this.colors.crimson;

          ctx.save();
          ctx.strokeStyle = laserColor;
          ctx.setLineDash([2, 2]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x0, lastY);
          ctx.lineTo(x0 + plotW, lastY);
          ctx.stroke();

          // Gutter Price Tag
          ctx.fillStyle = laserColor;
          ctx.fillRect(x0 + plotW + 1, lastY - 8, rightAxisW - 2, 16);
          ctx.fillStyle = '#03070e';
          ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
          ctx.textAlign = 'left';
          ctx.fillText(this._formatPrice(latestCandle.close), x0 + plotW + 4, lastY + 3);
          ctx.restore();
        }
      }

      // 5. Right & Bottom Axis Borders
      ctx.strokeStyle = this.colors.gridStrong;
      ctx.beginPath();
      ctx.moveTo(x0 + plotW + 0.5, y0);
      ctx.lineTo(x0 + plotW + 0.5, y0 + h);
      ctx.moveTo(x0, y0 + plotH + 0.5);
      ctx.lineTo(x0 + w, y0 + plotH + 0.5);
      ctx.stroke();

      // 6. Interactive Crosshair & Hover Inspection
      if (
        this.mouse.active &&
        this.mouse.x >= x0 &&
        this.mouse.x <= x0 + plotW &&
        this.mouse.y >= y0 &&
        this.mouse.y <= y0 + plotH
      ) {
        const relX = this.mouse.x - x0;
        const barIdx = Math.max(0, Math.min(slice.length - 1, Math.floor(relX / stepX)));
        const hoveredCandle = slice[barIdx];
        const globalIdx = startIdx + barIdx;
        const snapX = Math.floor(x0 + (barIdx + 0.5) * stepX) + 0.5;
        const snapY = Math.floor(this.mouse.y) + 0.5;

        this._updateHudFromCandle(hoveredCandle, this.ema9[globalIdx], this.ema21[globalIdx]);

        ctx.save();
        ctx.strokeStyle = this.colors.crosshair;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(snapX, y0);
        ctx.lineTo(snapX, y0 + plotH);
        ctx.moveTo(x0, snapY);
        ctx.lineTo(x0 + plotW, snapY);
        ctx.stroke();

        // Crosshair Y-axis price pill
        if (this.mouse.y <= y0 + priceRegionH) {
          const cursorPrice = yToPrice(this.mouse.y);
          ctx.fillStyle = '#1f293d';
          ctx.fillRect(x0 + plotW + 1, snapY - 8, rightAxisW - 2, 16);
          ctx.strokeStyle = this.colors.amber;
          ctx.strokeRect(x0 + plotW + 1, snapY - 8, rightAxisW - 2, 16);
          ctx.fillStyle = this.colors.amber;
          ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
          ctx.textAlign = 'left';
          ctx.fillText(this._formatPrice(cursorPrice), x0 + plotW + 4, snapY + 3);
        }
        ctx.restore();
      }

      ctx.restore();
    }

    _drawIndicatorLine(startIdx, count, stepX, x0, priceToY, series, color, dash) {
      if (!series || count < 2) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      let started = false;

      for (let i = 0; i < count; i++) {
        const val = series[startIdx + i];
        if (val == null || !Number.isFinite(val)) continue;
        const cx = x0 + (i + 0.5) * stepX;
        const cy = priceToY(val);
        if (!started) {
          ctx.moveTo(cx, cy);
          started = true;
        } else {
          ctx.lineTo(cx, cy);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    _renderDepthPane(x0, y0, w, h) {
      const ctx = this.ctx;
      const bottomAxisH = 22;
      const plotW = w;
      const plotH = Math.max(60, h - bottomAxisH);

      const bids = (this.orderbook.bids || []).slice().sort((a, b) => Number(b.price) - Number(a.price));
      const asks = (this.orderbook.asks || []).slice().sort((a, b) => Number(a.price) - Number(b.price));

      if (bids.length === 0 && asks.length === 0) {
        ctx.fillStyle = this.colors.axisText;
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`AWAITING ${this.symbol} L2 DEPTH BOOK...`, x0 + w / 2, y0 + h / 2);
        return;
      }

      // Compute cumulative volumes if not already populated
      let cumBid = 0;
      const bidPoints = bids.map((b) => {
        cumBid += Number(b.size || 0);
        return { price: Number(b.price), size: Number(b.size), total: Number(b.total || cumBid) };
      });

      let cumAsk = 0;
      const askPoints = asks.map((a) => {
        cumAsk += Number(a.size || 0);
        return { price: Number(a.price), size: Number(a.size), total: Number(a.total || cumAsk) };
      });

      const maxTotal = Math.max(
        0.0001,
        bidPoints.length ? bidPoints[bidPoints.length - 1].total : 0,
        askPoints.length ? askPoints[askPoints.length - 1].total : 0
      ) * 1.1;

      const midX = Math.floor(x0 + plotW / 2) + 0.5;
      const halfW = plotW / 2;
      const volToY = (tot) => y0 + plotH - (tot / maxTotal) * (plotH - 26);

      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, w, h);
      ctx.clip();

      // Grid lines
      ctx.strokeStyle = this.colors.grid;
      ctx.lineWidth = 1;
      for (let i = 1; i <= 4; i++) {
        const gy = Math.floor(y0 + (plotH / 5) * i) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x0, gy);
        ctx.lineTo(x0 + plotW, gy);
        ctx.stroke();
      }

      // Draw Bid Cumulative Wall (Right-to-Left from MidX to x0)
      if (bidPoints.length > 0) {
        ctx.beginPath();
        ctx.moveTo(midX - 2, y0 + plotH);

        for (let i = 0; i < bidPoints.length; i++) {
          const ratio = (i + 1) / bidPoints.length;
          const px = midX - 2 - ratio * (halfW - 8);
          const py = volToY(bidPoints[i].total);
          const prevX = i === 0 ? midX - 2 : midX - 2 - (i / bidPoints.length) * (halfW - 8);
          ctx.lineTo(prevX, py);
          ctx.lineTo(px, py);
          bidPoints[i]._x = px;
          bidPoints[i]._y = py;
        }
        ctx.lineTo(x0 + 6, y0 + plotH);
        ctx.closePath();

        const bidGrad = ctx.createLinearGradient(0, y0, 0, y0 + plotH);
        bidGrad.addColorStop(0, 'rgba(0, 230, 118, 0.38)');
        bidGrad.addColorStop(1, 'rgba(0, 230, 118, 0.04)');
        ctx.fillStyle = bidGrad;
        ctx.fill();

        // Stroke step line
        ctx.beginPath();
        for (let i = 0; i < bidPoints.length; i++) {
          const prevX = i === 0 ? midX - 2 : bidPoints[i - 1]._x;
          if (i === 0) ctx.moveTo(prevX, bidPoints[i]._y);
          else ctx.lineTo(prevX, bidPoints[i]._y);
          ctx.lineTo(bidPoints[i]._x, bidPoints[i]._y);
        }
        ctx.strokeStyle = this.colors.emerald;
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }

      // Draw Ask Cumulative Wall (Left-to-Right from MidX to x0 + plotW)
      if (askPoints.length > 0) {
        ctx.beginPath();
        ctx.moveTo(midX + 2, y0 + plotH);

        for (let i = 0; i < askPoints.length; i++) {
          const ratio = (i + 1) / askPoints.length;
          const px = midX + 2 + ratio * (halfW - 8);
          const py = volToY(askPoints[i].total);
          const prevX = i === 0 ? midX + 2 : midX + 2 + (i / askPoints.length) * (halfW - 8);
          ctx.lineTo(prevX, py);
          ctx.lineTo(px, py);
          askPoints[i]._x = px;
          askPoints[i]._y = py;
        }
        ctx.lineTo(x0 + plotW - 6, y0 + plotH);
        ctx.closePath();

        const askGrad = ctx.createLinearGradient(0, y0, 0, y0 + plotH);
        askGrad.addColorStop(0, 'rgba(255, 59, 92, 0.38)');
        askGrad.addColorStop(1, 'rgba(255, 59, 92, 0.04)');
        ctx.fillStyle = askGrad;
        ctx.fill();

        // Stroke step line
        ctx.beginPath();
        for (let i = 0; i < askPoints.length; i++) {
          const prevX = i === 0 ? midX + 2 : askPoints[i - 1]._x;
          if (i === 0) ctx.moveTo(prevX, askPoints[i]._y);
          else ctx.lineTo(prevX, askPoints[i]._y);
          ctx.lineTo(askPoints[i]._x, askPoints[i]._y);
        }
        ctx.strokeStyle = this.colors.crimson;
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }

      // Mid-Price Laser Line
      ctx.strokeStyle = this.colors.amber;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(midX, y0 + 20);
      ctx.lineTo(midX, y0 + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Header Banner inside Depth Chart
      const midPx = this.orderbook.midPrice || (bidPoints[0] && askPoints[0] ? (bidPoints[0].price + askPoints[0].price) / 2 : 0);
      ctx.fillStyle = 'rgba(10, 14, 22, 0.88)';
      ctx.fillRect(midX - 78, y0 + 4, 156, 18);
      ctx.strokeStyle = this.colors.amber;
      ctx.strokeRect(midX - 78, y0 + 4, 156, 18);
      ctx.fillStyle = this.colors.amber;
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`MID: ${this._formatPrice(midPx)}`, midX, y0 + 16);

      // Bottom Axis Price Labels
      ctx.strokeStyle = this.colors.gridStrong;
      ctx.beginPath();
      ctx.moveTo(x0, y0 + plotH + 0.5);
      ctx.lineTo(x0 + plotW, y0 + plotH + 0.5);
      ctx.stroke();

      ctx.font = '9.5px "JetBrains Mono", monospace';
      if (bidPoints.length > 0) {
        ctx.fillStyle = this.colors.emerald;
        ctx.textAlign = 'left';
        ctx.fillText(this._formatPrice(bidPoints[bidPoints.length - 1].price), x0 + 6, y0 + plotH + 14);
        ctx.textAlign = 'right';
        ctx.fillText(this._formatPrice(bidPoints[0].price), midX - 6, y0 + plotH + 14);
      }
      if (askPoints.length > 0) {
        ctx.fillStyle = this.colors.crimson;
        ctx.textAlign = 'left';
        ctx.fillText(this._formatPrice(askPoints[0].price), midX + 6, y0 + plotH + 14);
        ctx.textAlign = 'right';
        ctx.fillText(this._formatPrice(askPoints[askPoints.length - 1].price), x0 + plotW - 6, y0 + plotH + 14);
      }

      // Hover Tooltip on Depth Wall
      if (this.mouse.active && this.mouse.x >= x0 && this.mouse.x <= x0 + plotW && this.mouse.y >= y0 && this.mouse.y <= y0 + plotH) {
        const isBidSide = this.mouse.x < midX;
        const pts = isBidSide ? bidPoints : askPoints;
        if (pts.length > 0) {
          const distRatio = Math.min(0.999, Math.max(0, Math.abs(this.mouse.x - midX) / Math.max(1, halfW - 8)));
          const idx = Math.min(pts.length - 1, Math.floor(distRatio * pts.length));
          const pt = pts[idx];

          if (pt && pt._x != null) {
            ctx.fillStyle = isBidSide ? this.colors.emerald : this.colors.crimson;
            ctx.beginPath();
            ctx.arc(pt._x, pt._y, 4, 0, Math.PI * 2);
            ctx.fill();

            const boxW = 148;
            const boxH = 40;
            const bx = Math.min(x0 + plotW - boxW - 6, Math.max(x0 + 6, pt._x - boxW / 2));
            const by = Math.max(y0 + 26, pt._y - boxH - 10);

            ctx.fillStyle = 'rgba(6, 9, 16, 0.94)';
            ctx.fillRect(bx, by, boxW, boxH);
            ctx.strokeStyle = isBidSide ? this.colors.emerald : this.colors.crimson;
            ctx.strokeRect(bx, by, boxW, boxH);

            ctx.fillStyle = '#e6edf7';
            ctx.textAlign = 'left';
            ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
            ctx.fillText(`${isBidSide ? 'BID' : 'ASK'} PX: ${this._formatPrice(pt.price)}`, bx + 6, by + 15);
            ctx.fillStyle = this.colors.cyan;
            ctx.fillText(`CUM VOL: ${pt.total.toFixed(3)}`, bx + 6, by + 30);
          }
        }
      }

      ctx.restore();
    }
  }

  global.ArgusChartEngine = ArgusChartEngine;
})(window);
