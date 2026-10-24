'use strict';

/**
 * ARGUS TERMINAL — Automated Chrome DevTools Performance (LCP/TTFB),
 * Heap Memory-Leak Stress, & WCAG AAA Accessibility (a11y) Audit Suite
 *
 * Executes:
 *   - Audit 1: LCP & TTFB Subparts Breakdown, Zero Render-Blocking 3P Resources,
 *              CSS Layout Containment (`contain: layout style`), & Asset Budgets
 *   - Audit 2: Accessibility Tree Landmarks, Skip-Link, Zero Orphaned Inputs,
 *              `<dialog closedby="any">`, & Exact WCAG 2.1 Relative Luminance Contrast
 *   - Audit 3: High-Frequency WebSocket & Matching Engine Heap Memory-Leak Stress Test
 *              (300 rapid market ticks + 100 order submit/cancel cycles)
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { WebSocket } = require('ws');
const { createArgusServer } = require('../src/server/index');

const AUDIT_PORT = Number(process.env.AUDIT_PORT || 3497);

let passCount = 0;
let failCount = 0;

async function runAuditCheck(name, fn) {
  try {
    await fn();
    passCount += 1;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failCount += 1;
    console.error(`[FAIL] ${name}`);
    console.error(`       ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n       ') : err}`);
  }
}

/**
 * Measure exact HTTP TTFB (Time to First Byte) and Total Download Duration
 */
function measureHttpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const startNs = performance.now();
    let ttfbMs = null;

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
        headers: {
          Accept: 'text/html, text/css, application/javascript, application/json, */*'
        },
        timeout: 5000
      },
      (res) => {
        ttfbMs = performance.now() - startNs;
        const chunks = [];
        res.once('data', (firstChunk) => {
          chunks.push(firstChunk);
        });
        res.on('data', (chunk) => {
          if (chunks.length === 0 || chunks[0] !== chunk) {
            chunks.push(chunk);
          }
        });
        res.on('end', () => {
          const totalMs = performance.now() - startNs;
          const bodyBuffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            ttfbMs: Number(ttfbMs.toFixed(3)),
            totalMs: Number(totalMs.toFixed(3)),
            byteLength: bodyBuffer.byteLength,
            text: bodyBuffer.toString('utf8')
          });
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`HTTP timeout on GET ${urlPath}`));
    });
    req.end();
  });
}

/**
 * WCAG 2.1 Relative Luminance & Contrast Ratio Calculator
 */
function hexToRgb(hex) {
  const clean = hex.replace(/^#/, '').trim();
  const num = parseInt(clean, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const transform = (channel8) => {
    const c = channel8 / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const R = transform(r);
  const G = transform(g);
  const B = transform(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(fgHex, bgHex) {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

(async () => {
  console.log('========================================================================');
  console.log(' ARGUS TERMINAL — DEVTOOLS PERFORMANCE, MEMORY-LEAK & A11Y AUDIT SUITE');
  console.log('========================================================================');

  let app = null;
  let indexHtml = '';
  let terminalCss = '';

  try {
    await runAuditCheck(`0. Bootstrap Argus Server on port ${AUDIT_PORT} (dbMemory: true)`, async () => {
      app = await createArgusServer({
        port: AUDIT_PORT,
        dbMemory: true,
        simIntervalMs: 400
      });
      assert.ok(app && app.server && app.server.listening, 'Argus server must be listening');
      // Pause background timer during deterministic audit checks so we control ticks explicitly
      app.marketSim.stop();
    });

    // =========================================================================
    // AUDIT 1: LCP & TTFB SUBPARTS BREAKDOWN
    // =========================================================================
    console.log('\n--- AUDIT 1: LCP & TTFB SUBPARTS BREAKDOWN ---');

    await runAuditCheck('1.1 HTTP TTFB on GET / is < 50ms local & critical path assets load cleanly', async () => {
      // Warmup request
      await measureHttpGet(app.port, '/api/health');

      const docMetrics = await measureHttpGet(app.port, '/');
      indexHtml = docMetrics.text;

      const cssMetrics = await measureHttpGet(app.port, '/css/terminal.css');
      terminalCss = cssMetrics.text;

      const chartsMetrics = await measureHttpGet(app.port, '/js/charts.js');
      const compMetrics = await measureHttpGet(app.port, '/js/components.js');
      const appMetrics = await measureHttpGet(app.port, '/js/app.js');

      console.log(
        `       [TELEMETRY] GET /            TTFB: ${docMetrics.ttfbMs}ms | Total: ${docMetrics.totalMs}ms | Size: ${(docMetrics.byteLength / 1024).toFixed(2)} KB`
      );
      console.log(
        `       [TELEMETRY] terminal.css     TTFB: ${cssMetrics.ttfbMs}ms | Total: ${cssMetrics.totalMs}ms | Size: ${(cssMetrics.byteLength / 1024).toFixed(2)} KB`
      );
      console.log(
        `       [TELEMETRY] charts.js        TTFB: ${chartsMetrics.ttfbMs}ms | Total: ${chartsMetrics.totalMs}ms | Size: ${(chartsMetrics.byteLength / 1024).toFixed(2)} KB`
      );
      console.log(
        `       [TELEMETRY] components.js    TTFB: ${compMetrics.ttfbMs}ms | Total: ${compMetrics.totalMs}ms | Size: ${(compMetrics.byteLength / 1024).toFixed(2)} KB`
      );
      console.log(
        `       [TELEMETRY] app.js           TTFB: ${appMetrics.ttfbMs}ms | Total: ${appMetrics.totalMs}ms | Size: ${(appMetrics.byteLength / 1024).toFixed(2)} KB`
      );

      assert.equal(docMetrics.status, 200, 'GET / must return 200 OK');
      assert.ok(docMetrics.ttfbMs < 50, `Expected GET / TTFB < 50ms, got ${docMetrics.ttfbMs}ms`);
      assert.ok(cssMetrics.ttfbMs < 50, `Expected terminal.css TTFB < 50ms, got ${cssMetrics.ttfbMs}ms`);

      const totalBundleBytes =
        docMetrics.byteLength +
        cssMetrics.byteLength +
        chartsMetrics.byteLength +
        compMetrics.byteLength +
        appMetrics.byteLength;
      console.log(
        `       [TELEMETRY] Total Uncompressed Critical-Path Bundle: ${(totalBundleBytes / 1024).toFixed(2)} KB`
      );
      assert.ok(totalBundleBytes < 250 * 1024, 'Total critical path bundle must be lightweight (< 250 KB)');
    });

    await runAuditCheck('1.2 Zero render-blocking third-party stylesheets, external fonts, or synchronous scripts in <head>', async () => {
      const headMatch = indexHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
      assert.ok(headMatch, 'Expected <head> section in index.html');
      const headContent = headMatch[1];

      const hasExternalLink = /<link[^>]+href=["']https?:\/\//i.test(headContent);
      const hasBlockingHeadScript = /<script(?![^>]*(?:defer|async|type=["']module["']))[^>]*>/i.test(headContent);

      assert.equal(hasExternalLink, false, '<head> must not contain external render-blocking stylesheets or Google Fonts');
      assert.equal(hasBlockingHeadScript, false, '<head> must not contain synchronous render-blocking <script> tags');
    });

    await runAuditCheck('1.3 CSS Containment (contain: layout style), Double-Bezel enclosures, & Fluid Physics transitions verified', async () => {
      assert.ok(
        terminalCss.includes('contain: layout style'),
        'terminal.css must include contain: layout style on high-frequency scrolling panes'
      );
      assert.ok(
        /\.orderbook-ladder[\s\S]*?contain:\s*layout\s+style/i.test(terminalCss),
        '.orderbook-ladder must have contain: layout style'
      );
      assert.ok(
        /\.tape-list[\s\S]*?contain:\s*layout\s+style/i.test(terminalCss),
        '.tape-list must have contain: layout style'
      );
      assert.ok(
        /\.news-wire-list[\s\S]*?contain:\s*layout\s+style/i.test(terminalCss),
        '.news-wire-list must have contain: layout style'
      );
      assert.ok(
        terminalCss.includes('inset 0 1px 0 rgba(255, 255, 255, 0.07)'),
        'terminal.css must include Double-Bezel (Doppelrand) inner specular highlight on .pane and .cmd-dialog-inner'
      );
      assert.ok(
        terminalCss.includes('cubic-bezier(0.32, 0.72, 0, 1)'),
        'terminal.css must use fluid physics cubic-bezier(0.32, 0.72, 0, 1) transitions'
      );
    });

    // =========================================================================
    // AUDIT 2: ACCESSIBILITY TREE, SEMANTIC LANDMARKS, CONTRAST & ZERO ORPHANED INPUTS
    // =========================================================================
    console.log('\n--- AUDIT 2: ACCESSIBILITY TREE, LANDMARKS, CONTRAST & FORM CONTROLS ---');

    await runAuditCheck('2.1 Document <html lang="en">, Skip-Link to #main-workspace, and Semantic Landmarks verified', async () => {
      assert.ok(/<html[^>]+lang=["']en["']/i.test(indexHtml), '<html> must declare lang="en"');
      assert.ok(
        indexHtml.includes('<a href="#main-workspace" class="skip-link">Skip to Argus Terminal Workspace</a>'),
        '<body> must include skip link <a href="#main-workspace" class="skip-link">Skip to Argus Terminal Workspace</a>'
      );
      assert.ok(
        /<main[^>]+id=["']main-workspace["'][^>]+class=["'][^"']*terminal-workspace/i.test(indexHtml),
        '<main> must have id="main-workspace" and class="terminal-workspace"'
      );
      assert.ok(/<header[^>]+role=["']banner["']/i.test(indexHtml), 'Top header must have role="banner"');
      assert.ok(
        /<dialog[^>]+id=["']cmd-dialog["'][^>]+closedby=["']any["'][^>]+aria-labelledby=["']cmd-dialog-title["']/i.test(
          indexHtml
        ),
        '<dialog> must include closedby="any" and aria-labelledby="cmd-dialog-title"'
      );
      assert.ok(
        /<div[^>]+id=["']toast-container["'][^>]+aria-live=["']polite["']/i.test(indexHtml),
        'Toast container must have aria-live="polite"'
      );

      // Verify all 4 .table-wrapper containers have tabindex="0", role="region", and aria-labelledby
      const tableWrappers = indexHtml.match(/<div[^>]+class=["'][^"']*table-wrapper[^"']*["'][^>]*>/gi) || [];
      assert.equal(tableWrappers.length, 4, `Expected 4 .table-wrapper containers, found ${tableWrappers.length}`);
      for (const wrapperTag of tableWrappers) {
        assert.ok(/tabindex=["']0["']/i.test(wrapperTag), `table-wrapper missing tabindex="0": ${wrapperTag}`);
        assert.ok(/role=["']region["']/i.test(wrapperTag), `table-wrapper missing role="region": ${wrapperTag}`);
        assert.ok(
          /aria-labelledby=["'][^"']+["']/i.test(wrapperTag),
          `table-wrapper missing aria-labelledby: ${wrapperTag}`
        );
      }
    });

    await runAuditCheck('2.2 Zero orphaned <input>, <select>, <textarea>, or <button> elements in index.html', async () => {
      // Collect all explicit <label for="..."> targets
      const labelForIds = new Set();
      const labelRegex = /<label[^>]+for=["']([^"']+)["']/gi;
      let m;
      while ((m = labelRegex.exec(indexHtml)) !== null) {
        labelForIds.add(m[1]);
      }

      // Check all <input>, <select>, <textarea>
      const controlRegex = /<(input|select|textarea)\b([^>]*)>/gi;
      let controlCount = 0;
      while ((m = controlRegex.exec(indexHtml)) !== null) {
        controlCount += 1;
        const tag = m[1].toLowerCase();
        const attrs = m[2];
        const idMatch = attrs.match(/\bid=["']([^"']+)["']/i);
        const id = idMatch ? idMatch[1] : null;
        const hasAriaLabel = /\baria-label=["']([^"']+)["']/i.test(attrs) || /\baria-labelledby=["']([^"']+)["']/i.test(attrs);
        const hasExplicitLabel = Boolean(id && labelForIds.has(id));

        assert.ok(
          hasExplicitLabel || hasAriaLabel,
          `Orphaned form control <${tag}> without <label for> or aria-label: <${tag}${attrs}>`
        );
      }
      assert.ok(controlCount >= 7, `Expected at least 7 form controls, verified ${controlCount}`);

      // Check all <button> elements have accessible text or aria-label
      const buttonRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
      let buttonCount = 0;
      while ((m = buttonRegex.exec(indexHtml)) !== null) {
        buttonCount += 1;
        const attrs = m[1];
        const innerText = m[2].replace(/<[^>]+>/g, '').trim();
        const hasAriaLabel = /\baria-label=["']([^"']+)["']/i.test(attrs);
        assert.ok(
          innerText.length > 0 || hasAriaLabel,
          `Unlabelled <button> element detected: <button${attrs}>`
        );
      }
      console.log(`       [A11Y] Verified ${controlCount} form controls and ${buttonCount} interactive buttons — 0 orphaned elements`);
    });

    await runAuditCheck('2.3 Primary Design Token Contrast Ratios exceed WCAG AA/AAA (>= 7.0:1 against #06080c)', async () => {
      const bgObsidian = '#06080c';
      const pairs = [
        { name: 'Primary Text (#e6edf7 on #06080c)', fg: '#e6edf7', bg: bgObsidian, minRatio: 7.0 },
        { name: 'Bloomberg Amber (#ff9e00 on #06080c)', fg: '#ff9e00', bg: bgObsidian, minRatio: 7.0 },
        { name: 'Bid Emerald (#00e676 on #06080c)', fg: '#00e676', bg: bgObsidian, minRatio: 7.0 },
        { name: 'Telemetry Cyan (#00d2ff on #06080c)', fg: '#00d2ff', bg: bgObsidian, minRatio: 7.0 }
      ];

      for (const pair of pairs) {
        const ratio = contrastRatio(pair.fg, pair.bg);
        console.log(`       [WCAG AAA] ${pair.name} => ${ratio.toFixed(2)}:1 (Threshold >= ${pair.minRatio.toFixed(1)}:1)`);
        assert.ok(
          ratio >= pair.minRatio,
          `Contrast ratio for ${pair.name} (${ratio.toFixed(2)}:1) is below ${pair.minRatio}:1`
        );
      }
    });

    // =========================================================================
    // AUDIT 3: HIGH-FREQUENCY WEBSOCKET & MATCHING ENGINE HEAP MEMORY-LEAK STRESS TEST
    // =========================================================================
    console.log('\n--- AUDIT 3: HIGH-FREQUENCY WEBSOCKET & MATCHING ENGINE HEAP MEMORY-LEAK STRESS TEST ---');

    await runAuditCheck('3.1 300 rapid WebSocket market simulation ticks + 100 order submit/cancel cycles maintain bounded heap & collection sizes', async () => {
      const wsClient = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
      let receivedMessages = 0;

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket connection timeout')), 3000);
        wsClient.once('open', () => {
          clearTimeout(timer);
          wsClient.send(JSON.stringify({ type: 'SUBSCRIBE', symbol: 'BTC-USD' }));
          resolve();
        });
        wsClient.once('error', reject);
      });

      wsClient.on('message', () => {
        receivedMessages += 1;
      });

      // Warm up a few ticks before taking baseline memory snapshot
      for (let i = 0; i < 5; i++) {
        app.marketSim.step();
      }
      if (typeof global.gc === 'function') {
        global.gc();
      }

      const memBefore = process.memoryUsage();
      const stressStartMs = performance.now();

      // Pump 300 rapid market simulation ticks
      for (let tick = 0; tick < 300; tick++) {
        app.marketSim.step();
      }

      // Pump 100 rapid LIMIT order submissions & immediate cancellations across instruments
      const symbols = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'NVDA-EQ', 'XAU-USD'];
      let submittedAndCancelled = 0;
      for (let i = 0; i < 100; i++) {
        const sym = symbols[i % symbols.length];
        const book = app.engine.getBook(sym);
        const restingBidPx = Math.max(book.tickSize * 2, book.basePrice * 0.65);

        const { order } = app.engine.submitOrder({
          accountId: 'ACC-INST-01',
          symbol: sym,
          side: 'BUY',
          type: 'LIMIT',
          price: restingBidPx,
          size: book.lotSize * 2,
          clientTag: `STRESS-AUDIT-${i}`
        });

        const cancelled = app.engine.cancelOrder(order.id, sym);
        assert.ok(cancelled, `Order ${order.id} should be cleanly cancelled`);
        submittedAndCancelled += 1;
      }

      // Allow WebSocket I/O buffer to flush
      await new Promise((r) => setTimeout(r, 150));

      if (typeof global.gc === 'function') {
        global.gc();
      }

      const stressElapsedMs = performance.now() - stressStartMs;
      const memAfter = process.memoryUsage();

      const heapBeforeMb = memBefore.heapUsed / (1024 * 1024);
      const heapAfterMb = memAfter.heapUsed / (1024 * 1024);
      const heapDeltaMb = heapAfterMb - heapBeforeMb;

      console.log(
        `       [HEAP] Before: ${heapBeforeMb.toFixed(2)} MB | After: ${heapAfterMb.toFixed(2)} MB | Delta: ${heapDeltaMb >= 0 ? '+' : ''}${heapDeltaMb.toFixed(2)} MB`
      );
      console.log(
        `       [STRESS] 300 Sim Ticks + ${submittedAndCancelled} Order Submit/Cancel Cycles completed in ${stressElapsedMs.toFixed(1)}ms (${receivedMessages} WS frames received)`
      );

      // Verify bounded in-memory collections
      for (const [symbol, book] of app.engine.books.entries()) {
        assert.ok(
          book.bids.length <= 30,
          `Unbounded bid book growth on ${symbol}: length=${book.bids.length} (expected <= 30)`
        );
        assert.ok(
          book.asks.length <= 30,
          `Unbounded ask book growth on ${symbol}: length=${book.asks.length} (expected <= 30)`
        );
      }

      assert.ok(
        Array.isArray(app.marketSim.trades) && app.marketSim.trades.length <= 100,
        `Expected marketSim.trades ring buffer <= 100, got ${app.marketSim.trades?.length}`
      );
      assert.ok(
        Array.isArray(app.marketSim.news) && app.marketSim.news.length <= 40,
        `Expected marketSim.news ring buffer <= 40, got ${app.marketSim.news?.length}`
      );
      assert.ok(
        heapDeltaMb < 25,
        `Expected bounded heap delta < 25 MB after 300 ticks + 100 orders, got ${heapDeltaMb.toFixed(2)} MB`
      );
      assert.ok(receivedMessages >= 300, `Expected at least 300 WS messages delivered, got ${receivedMessages}`);

      wsClient.close();
      await new Promise((r) => setTimeout(r, 40));
    });
  } finally {
    if (app) {
      await app.stop();
    }
  }

  console.log('\n========================================================================');
  console.log(` DEVTOOLS AUDIT SUMMARY: ${passCount} PASSED | ${failCount} FAILED`);
  console.log('========================================================================');

  process.exit(failCount === 0 ? 0 : 1);
})();
