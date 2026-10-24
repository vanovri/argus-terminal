'use strict';

/**
 * ARGUS TERMINAL — Wave 4: Limit Order Book (LOB) Replay Time-Machine
 *
 * Implements:
 *   1. Deterministic Event-Sourced L2/L3 Orderbook Journal with Periodic Keyframe Checkpoints:
 *      - Every state transition (ADD_LIMIT, MARKET_SWEEP, CANCEL_LIMIT, ICEBERG_REFILL, DARK_CROSS)
 *        is assigned a strictly monotonic sequence number `seq` and nanosecond/millisecond timestamp.
 *      - Periodic keyframe snapshots every K events enable O(K) sub-millisecond random access seeking
 *        to any historical sequence number or timestamp without replaying from genesis.
 *   2. Cryptographic State Hash Verification (`computeBookStateHash`):
 *      - Computes deterministic SHA-256 state digest over canonicalized (price, size) bid/ask ladders,
 *        proving bit-for-bit replay determinism between live execution and time-travel reconstruction.
 *   3. Microstructure Telemetry Reconstruction at Any Historical Frame:
 *      - Recomputes Best Bid/Ask, Mid-Price, Stoikov Micro-Price, L2 Order Book Imbalance (OBI),
 *        Spread (bps), and cumulative liquidity depth walls at the target frame.
 */

const crypto = require('node:crypto');
const { INITIAL_INSTRUMENTS, roundToTick } = require('../db/database');

function createPrng(seed) {
  let state = seed >>> 0;
  return function nextRand() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const KEYFRAME_INTERVAL = 10;
const MAX_EVENTS_PER_SYMBOL = 600;

/**
 * Deep-clones an L2 orderbook ladder array [{ price, size, total, ordersCount }]
 */
function cloneLadder(levels = [], maxDepth = 18) {
  let runningTotal = 0;
  const sliced = levels.slice(0, maxDepth);
  return sliced.map((lvl) => {
    const price = Number(lvl.price);
    const size = Number(Number(lvl.size).toFixed(6));
    runningTotal = Number((runningTotal + size).toFixed(6));
    return {
      price,
      size,
      total: runningTotal,
      ordersCount: lvl.ordersCount || 1
    };
  });
}

/**
 * Computes deterministic SHA-256 digest of an L2 orderbook state.
 */
function computeBookStateHash(bookState) {
  const bids = Array.isArray(bookState?.bids) ? bookState.bids : [];
  const asks = Array.isArray(bookState?.asks) ? bookState.asks : [];
  const canonicalBids = bids
    .filter((b) => Number(b.size) > 1e-9)
    .map((b) => `${Number(b.price).toFixed(4)}:${Number(b.size).toFixed(4)}`)
    .join('|');
  const canonicalAsks = asks
    .filter((a) => Number(a.size) > 1e-9)
    .map((a) => `${Number(a.price).toFixed(4)}:${Number(a.size).toFixed(4)}`)
    .join('|');
  const payload = `SYM=${bookState?.symbol || 'BTC-USD'}#B=${canonicalBids}#A=${canonicalAsks}`;
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16).toUpperCase();
}

/**
 * Computes institutional microstructure metrics for a reconstructed L2 state.
 */
function computeFrameMicrostructure(symbol, bids, asks, tickSize = 0.5) {
  const bestBid = bids.length > 0 ? Number(bids[0].price) : 0;
  const bestAsk = asks.length > 0 ? Number(asks[0].price) : 0;
  const bestBidSize = bids.length > 0 ? Number(bids[0].size) : 0;
  const bestAskSize = asks.length > 0 ? Number(asks[0].size) : 0;

  const midPrice = bestBid > 0 && bestAsk > 0
    ? Number(((bestBid + bestAsk) / 2).toFixed(4))
    : bestBid || bestAsk || 0;

  const spread = bestBid > 0 && bestAsk > 0
    ? Number(Math.max(tickSize, bestAsk - bestBid).toFixed(4))
    : tickSize;

  const spreadBps = midPrice > 0 ? Number(((spread / midPrice) * 10000).toFixed(2)) : 0;

  // Stoikov Micro-Price weighted by top-of-book opposite queue depth
  const topSum = bestBidSize + bestAskSize;
  const microPrice = topSum > 0 && bestBid > 0 && bestAsk > 0
    ? Number(((bestBid * bestAskSize + bestAsk * bestBidSize) / topSum).toFixed(4))
    : midPrice;

  // L2 Top-5 Order Book Imbalance (OBI) in [-1, +1]
  const bidDepth5 = bids.slice(0, 5).reduce((acc, b) => acc + Number(b.size), 0);
  const askDepth5 = asks.slice(0, 5).reduce((acc, a) => acc + Number(a.size), 0);
  const totalDepth5 = bidDepth5 + askDepth5;
  const obi = totalDepth5 > 0 ? Number(((bidDepth5 - askDepth5) / totalDepth5).toFixed(4)) : 0;

  const totalBidDepth = bids.reduce((acc, b) => acc + Number(b.size), 0);
  const totalAskDepth = asks.reduce((acc, a) => acc + Number(a.size), 0);

  return {
    symbol,
    bestBid,
    bestAsk,
    midPrice,
    microPrice,
    spread,
    spreadBps,
    obi,
    obiPct: Number((obi * 100).toFixed(2)),
    totalBidDepth: Number(totalBidDepth.toFixed(4)),
    totalAskDepth: Number(totalAskDepth.toFixed(4))
  };
}

/**
 * Applies a single deterministic L2 delta event onto a mutable { bids, asks } state.
 */
function applyDeltaToBookState(state, delta, tickSize = 0.5) {
  const bidsMap = new Map();
  const asksMap = new Map();

  for (const b of state.bids) {
    if (b.size > 1e-9) bidsMap.set(Number(b.price.toFixed(4)), Number(b.size));
  }
  for (const a of state.asks) {
    if (a.size > 1e-9) asksMap.set(Number(a.price.toFixed(4)), Number(a.size));
  }

  const side = String(delta.side || 'BUY').toUpperCase();
  const eventType = String(delta.eventType || 'ADD_LIMIT').toUpperCase();
  const priceKey = Number(roundToTick(Number(delta.price || state.midPrice || 94500), tickSize).toFixed(4));
  const size = Math.max(0.0001, Number(delta.size || 0.5));
  let fills = [];

  if (eventType === 'ADD_LIMIT' || eventType === 'ICEBERG_REFILL') {
    const targetMap = side === 'BUY' ? bidsMap : asksMap;
    const prev = targetMap.get(priceKey) || 0;
    targetMap.set(priceKey, Number((prev + size).toFixed(6)));
  } else if (eventType === 'CANCEL_LIMIT') {
    const targetMap = side === 'BUY' ? bidsMap : asksMap;
    const prev = targetMap.get(priceKey) || 0;
    const next = Math.max(0, prev - size);
    if (next <= 1e-6) {
      targetMap.delete(priceKey);
    } else {
      targetMap.set(priceKey, Number(next.toFixed(6)));
    }
  } else if (eventType === 'MARKET_SWEEP' || eventType === 'LIQUIDITY_SHOCK') {
    const oppMap = side === 'BUY' ? asksMap : bidsMap;
    const sortedKeys = Array.from(oppMap.keys()).sort((a, b) => (side === 'BUY' ? a - b : b - a));
    let rem = size;
    for (const k of sortedKeys) {
      if (rem <= 1e-9) break;
      const avail = oppMap.get(k) || 0;
      const matched = Math.min(rem, avail);
      rem = Number((rem - matched).toFixed(6));
      const left = Number((avail - matched).toFixed(6));
      if (left <= 1e-6) {
        oppMap.delete(k);
      } else {
        oppMap.set(k, left);
      }
      fills.push({
        price: k,
        size: Number(matched.toFixed(6)),
        side
      });
    }
  }

  // Rebuild sorted ladders
  const sortedBids = Array.from(bidsMap.entries())
    .sort((a, b) => b[0] - a[0])
    .slice(0, 18)
    .map(([price, sz]) => ({ price, size: sz }));

  const sortedAsks = Array.from(asksMap.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, 18)
    .map(([price, sz]) => ({ price, size: sz }));

  // Ensure book always maintains institutional depth on both sides
  const refCenter =
    sortedBids.length > 0 && sortedAsks.length > 0
      ? (sortedBids[0].price + sortedAsks[0].price) / 2
      : state.midPrice || delta.price || 94500;

  while (sortedBids.length < 10) {
    const lowestBid = sortedBids.length > 0
      ? sortedBids[sortedBids.length - 1].price
      : roundToTick(refCenter - tickSize, tickSize);
    sortedBids.push({
      price: roundToTick(lowestBid - tickSize, tickSize),
      size: Number((size * 0.85).toFixed(4))
    });
  }

  while (sortedAsks.length < 10) {
    const highestAsk = sortedAsks.length > 0
      ? sortedAsks[sortedAsks.length - 1].price
      : roundToTick(refCenter + tickSize, tickSize);
    sortedAsks.push({
      price: roundToTick(highestAsk + tickSize, tickSize),
      size: Number((size * 0.85).toFixed(4))
    });
  }

  const finalBids = cloneLadder(sortedBids, 15);
  const finalAsks = cloneLadder(sortedAsks, 15);
  const metrics = computeFrameMicrostructure(state.symbol, finalBids, finalAsks, tickSize);

  return {
    symbol: state.symbol,
    bids: finalBids,
    asks: finalAsks,
    ...metrics,
    fills
  };
}

class LobTimeMachine {
  constructor(matchingEngine = null, options = {}) {
    this.engine = matchingEngine;
    this.keyframeInterval = Number(options.keyframeInterval) || KEYFRAME_INTERVAL;
    this.maxEvents = Number(options.maxEvents) || MAX_EVENTS_PER_SYMBOL;

    // Map<symbol, { events: Array, keyframes: Map<seq, Snapshot>, tickSize, lotSize, basePrice }>
    this.journals = new Map();

    this._seedAllJournals();
  }

  _seedAllJournals() {
    const now = Date.now();
    for (let idx = 0; idx < INITIAL_INSTRUMENTS.length; idx++) {
      const inst = INITIAL_INSTRUMENTS[idx];
      this._seedSymbolJournal(inst, now, 7700 + idx * 911);
    }
  }

  _seedSymbolJournal(inst, nowTs, seed) {
    const rand = createPrng(seed);
    const symbol = inst.symbol;
    const tickSize = inst.tick_size || 0.5;
    const lotSize = inst.lot_size || 0.01;
    const basePrice = inst.base_price || 94500;

    // Build initial genesis L2 ladder (seq = 1)
    const genesisBids = [];
    const genesisAsks = [];
    for (let lvl = 1; lvl <= 15; lvl++) {
      const bPx = roundToTick(basePrice - lvl * tickSize, tickSize);
      const aPx = roundToTick(basePrice + lvl * tickSize, tickSize);
      const baseMult = symbol === 'BTC-USD' ? 28 : symbol === 'ETH-USD' ? 40 : 55;
      const bSz = Number((lotSize * Math.round(baseMult * (1 + 0.3 * Math.sin(lvl)))).toFixed(4));
      const aSz = Number((lotSize * Math.round(baseMult * (1 + 0.3 * Math.cos(lvl)))).toFixed(4));
      genesisBids.push({ price: bPx, size: bSz });
      genesisAsks.push({ price: aPx, size: aSz });
    }

    const bids = cloneLadder(genesisBids, 15);
    const asks = cloneLadder(genesisAsks, 15);
    const metrics = computeFrameMicrostructure(symbol, bids, asks, tickSize);

    let currentState = {
      symbol,
      bids,
      asks,
      ...metrics,
      fills: []
    };

    const events = [];
    const keyframes = new Map();

    const totalSeedEvents = 60;
    const eventTypes = [
      'ADD_LIMIT',
      'MARKET_SWEEP',
      'ADD_LIMIT',
      'CANCEL_LIMIT',
      'ICEBERG_REFILL',
      'MARKET_SWEEP',
      'LIQUIDITY_SHOCK',
      'ADD_LIMIT'
    ];

    for (let seq = 1; seq <= totalSeedEvents; seq++) {
      const ts = nowTs - (totalSeedEvents - seq) * 1000;
      const evType = seq === 1 ? 'GENESIS_SNAPSHOT' : eventTypes[(seq + Math.floor(rand() * 3)) % eventTypes.length];
      const side = rand() > 0.48 ? 'BUY' : 'SELL';
      const levelOffset = 1 + Math.floor(rand() * 5);
      const refMid = currentState.midPrice || basePrice;
      const px = side === 'BUY'
        ? roundToTick(refMid - levelOffset * tickSize, tickSize)
        : roundToTick(refMid + levelOffset * tickSize, tickSize);
      const sz = Number((lotSize * (8 + Math.floor(rand() * 45))).toFixed(4));

      const delta = {
        seq,
        timestamp: ts,
        symbol,
        eventType: evType,
        side,
        price: evType === 'MARKET_SWEEP'
          ? (side === 'BUY' ? currentState.bestAsk : currentState.bestBid)
          : px,
        size: sz,
        actor: evType === 'ICEBERG_REFILL' ? 'ALGO-ICEBERG' : evType === 'MARKET_SWEEP' ? 'DMA-SWEEP' : 'MM-QUOTE'
      };

      if (seq > 1) {
        currentState = applyDeltaToBookState(currentState, delta, tickSize);
      }

      const stateHash = computeBookStateHash(currentState);
      const eventEntry = {
        ...delta,
        midPrice: currentState.midPrice,
        microPrice: currentState.microPrice,
        spread: currentState.spread,
        spreadBps: currentState.spreadBps,
        obi: currentState.obi,
        fillsCount: currentState.fills ? currentState.fills.length : 0,
        stateHash
      };

      events.push(eventEntry);

      if (seq === 1 || seq % this.keyframeInterval === 0 || seq === totalSeedEvents) {
        keyframes.set(seq, {
          seq,
          timestamp: ts,
          symbol,
          bids: cloneLadder(currentState.bids, 15),
          asks: cloneLadder(currentState.asks, 15),
          midPrice: currentState.midPrice,
          microPrice: currentState.microPrice,
          bestBid: currentState.bestBid,
          bestAsk: currentState.bestAsk,
          spread: currentState.spread,
          spreadBps: currentState.spreadBps,
          obi: currentState.obi,
          totalBidDepth: currentState.totalBidDepth,
          totalAskDepth: currentState.totalAskDepth,
          stateHash
        });
      }
    }

    this.journals.set(symbol, {
      symbol,
      tickSize,
      lotSize,
      basePrice,
      events,
      keyframes,
      latestState: currentState
    });
  }

  _getJournal(symbol = 'BTC-USD') {
    const cleanSym = String(symbol || 'BTC-USD').toUpperCase();
    if (!this.journals.has(cleanSym)) {
      const fallbackInst = INITIAL_INSTRUMENTS.find((i) => i.symbol === cleanSym) || INITIAL_INSTRUMENTS[0];
      this._seedSymbolJournal(fallbackInst, Date.now(), 9999);
    }
    return this.journals.get(cleanSym);
  }

  /**
   * Appends a new orderbook event (from live execution or manual injection) into the Time-Machine journal.
   */
  recordEvent(params = {}) {
    const symbol = String(params.symbol || 'BTC-USD').toUpperCase();
    const journal = this._getJournal(symbol);
    const nextSeq = journal.events.length > 0 ? journal.events[journal.events.length - 1].seq + 1 : 1;
    const timestamp = Number(params.timestamp) || Date.now();

    const delta = {
      seq: nextSeq,
      timestamp,
      symbol,
      eventType: String(params.eventType || params.type || 'ADD_LIMIT').toUpperCase(),
      side: String(params.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      price: Number(params.price || journal.latestState.midPrice || journal.basePrice),
      size: Math.max(0.0001, Number(params.size || 0.25)),
      actor: String(params.actor || params.clientTag || 'LIVE-ENGINE')
    };

    // If caller provides an explicit live engine snapshot, anchor to it; otherwise evolve deterministically
    let nextState;
    if (params.snapshot && Array.isArray(params.snapshot.bids) && Array.isArray(params.snapshot.asks)) {
      const bids = cloneLadder(params.snapshot.bids, 15);
      const asks = cloneLadder(params.snapshot.asks, 15);
      const metrics = computeFrameMicrostructure(symbol, bids, asks, journal.tickSize);
      nextState = {
        symbol,
        bids,
        asks,
        ...metrics,
        fills: params.fills || []
      };
      // Force a keyframe whenever an explicit snapshot is anchored so replay matches 100%
      const stateHash = computeBookStateHash(nextState);
      journal.keyframes.set(nextSeq, {
        seq: nextSeq,
        timestamp,
        symbol,
        bids: cloneLadder(nextState.bids, 15),
        asks: cloneLadder(nextState.asks, 15),
        midPrice: nextState.midPrice,
        microPrice: nextState.microPrice,
        bestBid: nextState.bestBid,
        bestAsk: nextState.bestAsk,
        spread: nextState.spread,
        spreadBps: nextState.spreadBps,
        obi: nextState.obi,
        totalBidDepth: nextState.totalBidDepth,
        totalAskDepth: nextState.totalAskDepth,
        stateHash
      });
    } else {
      nextState = applyDeltaToBookState(journal.latestState, delta, journal.tickSize);
    }

    const stateHash = computeBookStateHash(nextState);
    const eventEntry = {
      ...delta,
      midPrice: nextState.midPrice,
      microPrice: nextState.microPrice,
      spread: nextState.spread,
      spreadBps: nextState.spreadBps,
      obi: nextState.obi,
      fillsCount: nextState.fills ? nextState.fills.length : 0,
      stateHash
    };

    journal.events.push(eventEntry);
    journal.latestState = nextState;

    if (nextSeq % this.keyframeInterval === 0) {
      journal.keyframes.set(nextSeq, {
        seq: nextSeq,
        timestamp,
        symbol,
        bids: cloneLadder(nextState.bids, 15),
        asks: cloneLadder(nextState.asks, 15),
        midPrice: nextState.midPrice,
        microPrice: nextState.microPrice,
        bestBid: nextState.bestBid,
        bestAsk: nextState.bestAsk,
        spread: nextState.spread,
        spreadBps: nextState.spreadBps,
        obi: nextState.obi,
        totalBidDepth: nextState.totalBidDepth,
        totalAskDepth: nextState.totalAskDepth,
        stateHash
      });
    }

    return {
      event: eventEntry,
      state: this.seekToSequence(symbol, nextSeq)
    };
  }

  /**
   * Returns timeline metadata, sequence bounds, keyframes list, and recent event tape for the UI scrubber.
   */
  getTimeline(symbol = 'BTC-USD', limit = 100) {
    const journal = this._getJournal(symbol);
    const events = journal.events;
    const minSeq = events.length > 0 ? events[0].seq : 1;
    const maxSeq = events.length > 0 ? events[events.length - 1].seq : 1;
    const startTs = events.length > 0 ? events[0].timestamp : Date.now();
    const endTs = events.length > 0 ? events[events.length - 1].timestamp : Date.now();

    const keyframes = Array.from(journal.keyframes.keys()).sort((a, b) => a - b);
    const slicedEvents = events.slice(-Math.min(events.length, Math.max(10, Number(limit) || 100)));

    return {
      symbol: journal.symbol,
      totalEvents: events.length,
      minSeq,
      maxSeq,
      startTimestamp: startTs,
      endTimestamp: endTs,
      keyframeInterval: this.keyframeInterval,
      keyframes,
      events: slicedEvents,
      latestStateHash: events.length > 0 ? events[events.length - 1].stateHash : null
    };
  }

  /**
   * Reconstructs exact historical L2 Orderbook state at `targetSeq` by jumping to the nearest
   * preceding keyframe and replaying delta events forward to `targetSeq`.
   */
  seekToSequence(symbol = 'BTC-USD', targetSeq = null) {
    const journal = this._getJournal(symbol);
    const events = journal.events;
    if (events.length === 0) {
      return null;
    }

    const minSeq = events[0].seq;
    const maxSeq = events[events.length - 1].seq;
    const clampedSeq = targetSeq === null || targetSeq === undefined
      ? maxSeq
      : Math.max(minSeq, Math.min(maxSeq, Math.round(Number(targetSeq) || maxSeq)));

    // Find highest keyframe <= clampedSeq
    let anchorSeq = minSeq;
    for (const kSeq of journal.keyframes.keys()) {
      if (kSeq <= clampedSeq && kSeq >= anchorSeq) {
        anchorSeq = kSeq;
      }
    }

    const anchorSnap = journal.keyframes.get(anchorSeq);
    let workingState = {
      symbol: journal.symbol,
      bids: cloneLadder(anchorSnap.bids, 15),
      asks: cloneLadder(anchorSnap.asks, 15),
      midPrice: anchorSnap.midPrice,
      microPrice: anchorSnap.microPrice,
      bestBid: anchorSnap.bestBid,
      bestAsk: anchorSnap.bestAsk,
      spread: anchorSnap.spread,
      spreadBps: anchorSnap.spreadBps,
      obi: anchorSnap.obi,
      totalBidDepth: anchorSnap.totalBidDepth,
      totalAskDepth: anchorSnap.totalAskDepth,
      fills: []
    };

    let replayedDeltas = 0;
    for (let s = anchorSeq + 1; s <= clampedSeq; s++) {
      const ev = events[s - minSeq];
      if (!ev) continue;
      workingState = applyDeltaToBookState(workingState, ev, journal.tickSize);
      replayedDeltas += 1;
    }

    const targetEvent = events[clampedSeq - minSeq] || events[events.length - 1];
    const computedHash = computeBookStateHash(workingState);
    const expectedHash = targetEvent.stateHash;

    // Context window of surrounding events for the replay tape inspector
    const windowStart = Math.max(0, clampedSeq - minSeq - 8);
    const windowEnd = Math.min(events.length, clampedSeq - minSeq + 5);
    const surroundingEvents = events.slice(windowStart, windowEnd);

    return {
      symbol: journal.symbol,
      seq: clampedSeq,
      minSeq,
      maxSeq,
      progressPct: maxSeq > minSeq ? Number((((clampedSeq - minSeq) / (maxSeq - minSeq)) * 100).toFixed(2)) : 100,
      timestamp: targetEvent.timestamp,
      anchorKeyframeSeq: anchorSeq,
      replayedDeltasCount: replayedDeltas,
      stateHash: computedHash,
      expectedStateHash: expectedHash,
      deterministicVerified: computedHash === expectedHash,
      event: targetEvent,
      orderbook: {
        symbol: journal.symbol,
        bids: workingState.bids,
        asks: workingState.asks,
        bestBid: workingState.bestBid,
        bestAsk: workingState.bestAsk,
        midPrice: workingState.midPrice,
        microPrice: workingState.microPrice,
        spread: workingState.spread,
        spreadBps: workingState.spreadBps,
        obi: workingState.obi,
        obiPct: Number((workingState.obi * 100).toFixed(2)),
        totalBidDepth: workingState.totalBidDepth,
        totalAskDepth: workingState.totalAskDepth
      },
      surroundingEvents
    };
  }

  /**
   * Reconstructs the historical L2 Orderbook state at or immediately prior to `targetTimestamp`.
   */
  seekToTimestamp(symbol = 'BTC-USD', targetTimestamp) {
    const journal = this._getJournal(symbol);
    const events = journal.events;
    const ts = Number(targetTimestamp) || Date.now();
    let bestSeq = events[0]?.seq || 1;

    for (const ev of events) {
      if (ev.timestamp <= ts) {
        bestSeq = ev.seq;
      } else {
        break;
      }
    }
    return this.seekToSequence(symbol, bestSeq);
  }
}

module.exports = {
  LobTimeMachine,
  computeBookStateHash,
  computeFrameMicrostructure,
  applyDeltaToBookState,
  KEYFRAME_INTERVAL
};
