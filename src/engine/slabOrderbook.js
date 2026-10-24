'use strict';

/**
 * TypedArray Slab Orderbook + small hand-assembled WebAssembly helper module
 *
 * Design goals: price-time priority (FIFO) matching with O(1) slab slot
 * allocation, O(1) order cancellation, and no per-order object allocation on the
 * matching path (orders live in preallocated typed arrays; results come from a
 * reused 64-object pool). This is a goal, not a measured guarantee: V8 may still
 * allocate (e.g. boxed doubles), and `benchmarks/matching_bench.js` reports the
 * observed heapUsed delta. The WASM helpers are tiny and do not measurably change
 * throughput versus equivalent JS (see BENCHMARK_REPORT.md).
 */

const SIDE_BUY = 0;
const SIDE_SELL = 1;

/**
 * Hand-assembled WebAssembly binary module (WASM_BYTES).
 *
 * Exports:
 *  1. `priceCrosses(side: i32, incomingPriceTicks: i32, restingPriceTicks: i32) -> i32`
 *     Branchless WASM `select` tick comparison:
 *       - side == 0 (BUY):  returns 1 if incomingPriceTicks >= restingPriceTicks, else 0
 *       - side != 0 (SELL): returns 1 if incomingPriceTicks <= restingPriceTicks, else 0
 *
 *  2. `minInt(a: i32, b: i32) -> i32`
 *     Branchless WASM `select` minimum of two signed 32-bit integers.
 *
 *  3. `calcNotionalCents(priceTicks: i32, sizeLots: i32, tickScale: i32) -> i32`
 *     Two wrapping 32-bit `i32.mul` operations (priceTicks * sizeLots * tickScale).
 *     Overflows (wraps) above 2^31-1; fine for the demo instruments' tick/lot ranges.
 */
const WASM_BYTES = new Uint8Array([
  // Magic header ("\0asm") + Version 1
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,

  // Section 1: Type Section (3 function signatures, 21 bytes payload)
  0x01, 0x15, 0x03,
  // Type 0: (i32, i32, i32) -> i32
  0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x01, 0x7f,
  // Type 1: (i32, i32) -> i32
  0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  // Type 2: (i32, i32, i32) -> i32
  0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x01, 0x7f,

  // Section 3: Function Section (3 functions -> types 0, 1, 2)
  0x03, 0x04, 0x03, 0x00, 0x01, 0x02,

  // Section 7: Export Section (3 exported kernels, 45 bytes payload)
  0x07, 0x2d, 0x03,
  // Export 0: "priceCrosses" -> func 0
  0x0c, 0x70, 0x72, 0x69, 0x63, 0x65, 0x43, 0x72, 0x6f, 0x73, 0x73, 0x65, 0x73, 0x00, 0x00,
  // Export 1: "minInt" -> func 1
  0x06, 0x6d, 0x69, 0x6e, 0x49, 0x6e, 0x74, 0x00, 0x01,
  // Export 2: "calcNotionalCents" -> func 2
  0x11, 0x63, 0x61, 0x6c, 0x63, 0x4e, 0x6f, 0x74, 0x69, 0x6f, 0x6e, 0x61, 0x6c, 0x43, 0x65, 0x6e, 0x74, 0x73, 0x00, 0x02,

  // Section 10: Code Section (3 function bodies, 42 bytes payload)
  0x0a, 0x2a, 0x03,

  // Body 0: priceCrosses(side, incomingTicks, restingTicks) -> i32 (16 bytes)
  0x10, 0x00,
  0x20, 0x01, // local.get 1 (incomingTicks)
  0x20, 0x02, // local.get 2 (restingTicks)
  0x4e,       // i32.ge_s    (incoming >= resting)
  0x20, 0x01, // local.get 1 (incomingTicks)
  0x20, 0x02, // local.get 2 (restingTicks)
  0x4c,       // i32.le_s    (incoming <= resting)
  0x20, 0x00, // local.get 0 (side)
  0x45,       // i32.eqz     (side == 0)
  0x1b,       // select      (branchless select)
  0x0b,       // end

  // Body 1: minInt(a, b) -> i32 (12 bytes)
  0x0c, 0x00,
  0x20, 0x00, // local.get 0 (a)
  0x20, 0x01, // local.get 1 (b)
  0x20, 0x00, // local.get 0 (a)
  0x20, 0x01, // local.get 1 (b)
  0x48,       // i32.lt_s    (a < b)
  0x1b,       // select      (branchless min)
  0x0b,       // end

  // Body 2: calcNotionalCents(priceTicks, sizeLots, tickScale) -> i32 (10 bytes)
  0x0a, 0x00,
  0x20, 0x00, // local.get 0 (priceTicks)
  0x20, 0x01, // local.get 1 (sizeLots)
  0x6c,       // i32.mul
  0x20, 0x02, // local.get 2 (tickScale)
  0x6c,       // i32.mul
  0x0b        // end
]);

const wasmModule = new WebAssembly.Module(WASM_BYTES);
const wasmInstance = new WebAssembly.Instance(wasmModule);
const wasmExports = wasmInstance.exports;
const wasmPriceCrosses = wasmExports.priceCrosses;
const wasmMinInt = wasmExports.minInt;
const wasmCalcNotionalCents = wasmExports.calcNotionalCents;

const RESULT_POOL_SIZE = 64;
const RESULT_POOL_MASK = RESULT_POOL_SIZE - 1;

class SlabOrderbook {
  /**
   * @param {number|object} [optionsOrCapacity=262144]
   * @param {number} [tickSize=0.50]
   * @param {number} [lotSize=0.01]
   */
  constructor(optionsOrCapacity = 262144, tickSize = 0.50, lotSize = 0.01) {
    let resolvedCapacity = 262144;
    let resolvedTickSize = tickSize;
    let resolvedLotSize = lotSize;
    let resolvedSymbol = 'BTC-USD';
    let resolvedBasePrice = 94500.0;

    if (typeof optionsOrCapacity === 'number' && optionsOrCapacity > 0) {
      resolvedCapacity = optionsOrCapacity | 0;
    } else if (optionsOrCapacity && typeof optionsOrCapacity === 'object') {
      resolvedCapacity = (optionsOrCapacity.capacity || 262144) | 0;
      resolvedTickSize = Number(optionsOrCapacity.tickSize || optionsOrCapacity.tick_size || 0.50);
      resolvedLotSize = Number(optionsOrCapacity.lotSize || optionsOrCapacity.lot_size || 0.01);
      resolvedSymbol = optionsOrCapacity.symbol || 'BTC-USD';
      resolvedBasePrice = Number(optionsOrCapacity.basePrice || optionsOrCapacity.base_price || 94500.0);
    }

    this.symbol = resolvedSymbol;
    this.capacity = resolvedCapacity;
    this.tickSize = resolvedTickSize > 0 ? resolvedTickSize : 0.01;
    this.invTickSize = 1.0 / this.tickSize;
    this.lotSize = resolvedLotSize > 0 ? resolvedLotSize : 0.01;
    this.invLotSize = 1.0 / this.lotSize;
    this.tickScaleBps = Math.max(1, Math.round(this.tickSize * this.lotSize * 10000));
    this.lastPrice = resolvedBasePrice;

    // Flat pre-allocated TypedArray slab arenas (zero heap allocation during order lifecycle)
    this.orderIds = new Int32Array(this.capacity);
    this.sides = new Uint8Array(this.capacity);
    this.prices = new Float64Array(this.capacity);
    this.priceTicks = new Int32Array(this.capacity);
    this.sizes = new Float64Array(this.capacity);
    this.sizeLots = new Int32Array(this.capacity);
    this.nextIdx = new Int32Array(this.capacity);
    this.prevIdx = new Int32Array(this.capacity);
    this.activeFlags = new Uint8Array(this.capacity);

    // O(1) direct integer orderId -> slab slot lookup table (supports IDs up to maxDirectId)
    this.maxDirectId = Math.max(this.capacity * 2, 524288);
    this.idToSlot = new Int32Array(this.maxDirectId);
    this.idToSlot.fill(-1);
    this.overflowIdMap = new Map();

    // Intrusive O(1) free-list stack
    this.freeStack = new Int32Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      this.freeStack[i] = this.capacity - 1 - i;
      this.nextIdx[i] = -1;
      this.prevIdx[i] = -1;
    }
    this.freeTop = this.capacity;

    // Intrusive doubly-linked FIFO price-time priority list heads & tails
    this.bidHead = -1;
    this.bidTail = -1;
    this.askHead = -1;
    this.askTail = -1;

    // Engine telemetry counters
    this.activeOrders = 0;
    this.totalMatchedOrders = 0;
    this.totalVolume = 0.0;
    this.totalNotionalCents = 0.0;
    this._autoIdSeq = 1;

    // Pre-allocated ring pool of 64 result objects with pre-unboxed V8 Double representations
    this._resultPool = new Array(RESULT_POOL_SIZE);
    for (let i = 0; i < RESULT_POOL_SIZE; i++) {
      const obj = {
        filledSize: 0.5,
        restingId: -1,
        matchCount: 0,
        lastFillPrice: 0.5
      };
      obj.filledSize = 0.0;
      obj.lastFillPrice = 0.0;
      this._resultPool[i] = obj;
    }
    this._resultCursor = 0;
  }

  /**
   * Allocate a slab slot in O(1) time from the pre-allocated free stack.
   * @returns {number} slot index, or -1 if slab is full
   */
  _allocSlot() {
    if (this.freeTop <= 0) {
      return -1;
    }
    this.freeTop -= 1;
    const slot = this.freeStack[this.freeTop];
    this.activeFlags[slot] = 1;
    this.activeOrders += 1;
    return slot;
  }

  /**
   * Release a slab slot in O(1) time back to the pre-allocated free stack.
   * @param {number} slot
   */
  _freeSlot(slot) {
    const id = this.orderIds[slot];
    if (id >= 0 && id < this.maxDirectId) {
      this.idToSlot[id] = -1;
    } else if (this.overflowIdMap.size > 0) {
      this.overflowIdMap.delete(id);
    }
    this.activeFlags[slot] = 0;
    this.sizes[slot] = 0.0;
    this.sizeLots[slot] = 0;
    this.nextIdx[slot] = -1;
    this.prevIdx[slot] = -1;
    this.freeStack[this.freeTop] = slot;
    this.freeTop += 1;
    this.activeOrders -= 1;
  }

  /**
   * Normalize side argument ('BUY'|'SELL'|0|1) to 0 (SIDE_BUY) or 1 (SIDE_SELL).
   * @param {string|number} side
   * @returns {number}
   */
  _normalizeSide(side) {
    if (typeof side === 'number') {
      return side === 0 ? SIDE_BUY : SIDE_SELL;
    }
    if (typeof side === 'string' && side.length > 0) {
      const c = side.charCodeAt(0);
      return c === 66 || c === 98 ? SIDE_BUY : SIDE_SELL;
    }
    return SIDE_BUY;
  }

  /**
   * Insert a resting order slot into the intrusive doubly-linked Bid or Ask queue
   * preserving strict Price-Time Priority (FIFO).
   * @param {number} slot
   * @param {number} sideCode
   * @param {number} incomingTicks
   */
  _insertIntrusive(slot, sideCode, incomingTicks) {
    if (sideCode === SIDE_BUY) {
      if (this.bidHead === -1) {
        this.bidHead = slot;
        this.bidTail = slot;
        this.prevIdx[slot] = -1;
        this.nextIdx[slot] = -1;
        return;
      }
      // Fast O(1) head check: strictly better than current best bid
      if (incomingTicks > this.priceTicks[this.bidHead]) {
        this.prevIdx[slot] = -1;
        this.nextIdx[slot] = this.bidHead;
        this.prevIdx[this.bidHead] = slot;
        this.bidHead = slot;
        return;
      }
      // Fast O(1) tail check: worse than or equal to worst bid (appends after equal ticks for FIFO)
      if (incomingTicks <= this.priceTicks[this.bidTail]) {
        this.prevIdx[slot] = this.bidTail;
        this.nextIdx[slot] = -1;
        this.nextIdx[this.bidTail] = slot;
        this.bidTail = slot;
        return;
      }
      // Bidirectional price-distance heuristic: walk from head or tail whichever is closer
      const distHead = this.priceTicks[this.bidHead] - incomingTicks;
      const distTail = incomingTicks - this.priceTicks[this.bidTail];
      if (distHead <= distTail) {
        let curr = this.bidHead;
        while (curr !== -1 && this.priceTicks[curr] >= incomingTicks) {
          curr = this.nextIdx[curr];
        }
        const prev = this.prevIdx[curr];
        this.prevIdx[slot] = prev;
        this.nextIdx[slot] = curr;
        if (prev !== -1) {
          this.nextIdx[prev] = slot;
        } else {
          this.bidHead = slot;
        }
        this.prevIdx[curr] = slot;
      } else {
        // Walk backwards from bidTail until we find the last order with priceTicks >= incomingTicks
        let curr = this.bidTail;
        while (curr !== -1 && this.priceTicks[curr] < incomingTicks) {
          curr = this.prevIdx[curr];
        }
        const next = this.nextIdx[curr];
        this.prevIdx[slot] = curr;
        this.nextIdx[slot] = next;
        this.nextIdx[curr] = slot;
        if (next !== -1) {
          this.prevIdx[next] = slot;
        } else {
          this.bidTail = slot;
        }
      }
    } else {
      if (this.askHead === -1) {
        this.askHead = slot;
        this.askTail = slot;
        this.prevIdx[slot] = -1;
        this.nextIdx[slot] = -1;
        return;
      }
      // Fast O(1) head check: strictly better (lower) than current best ask
      if (incomingTicks < this.priceTicks[this.askHead]) {
        this.prevIdx[slot] = -1;
        this.nextIdx[slot] = this.askHead;
        this.prevIdx[this.askHead] = slot;
        this.askHead = slot;
        return;
      }
      // Fast O(1) tail check: worse than or equal to worst ask (appends after equal ticks for FIFO)
      if (incomingTicks >= this.priceTicks[this.askTail]) {
        this.prevIdx[slot] = this.askTail;
        this.nextIdx[slot] = -1;
        this.nextIdx[this.askTail] = slot;
        this.askTail = slot;
        return;
      }
      // Bidirectional price-distance heuristic: walk from head or tail whichever is closer
      const distHead = incomingTicks - this.priceTicks[this.askHead];
      const distTail = this.priceTicks[this.askTail] - incomingTicks;
      if (distHead <= distTail) {
        let curr = this.askHead;
        while (curr !== -1 && this.priceTicks[curr] <= incomingTicks) {
          curr = this.nextIdx[curr];
        }
        const prev = this.prevIdx[curr];
        this.prevIdx[slot] = prev;
        this.nextIdx[slot] = curr;
        if (prev !== -1) {
          this.nextIdx[prev] = slot;
        } else {
          this.askHead = slot;
        }
        this.prevIdx[curr] = slot;
      } else {
        // Walk backwards from askTail until we find the last order with priceTicks <= incomingTicks
        let curr = this.askTail;
        while (curr !== -1 && this.priceTicks[curr] > incomingTicks) {
          curr = this.prevIdx[curr];
        }
        const next = this.nextIdx[curr];
        this.prevIdx[slot] = curr;
        this.nextIdx[slot] = next;
        this.nextIdx[curr] = slot;
        if (next !== -1) {
          this.prevIdx[next] = slot;
        } else {
          this.askTail = slot;
        }
      }
    }
  }

  /**
   * Submit a limit order to the zero-allocation slab orderbook.
   * Uses the embedded WASM kernel (`priceCrosses`, `minInt`, `calcNotionalCents`) on the hot path.
   *
   * @param {string|number} side - 'BUY' | 'SELL' | 0 | 1
   * @param {number} price - limit price
   * @param {number} size - order quantity
   * @param {number} [id] - numeric order ID
   * @returns {{ filledSize: number, restingId: number, matchCount: number, lastFillPrice: number }}
   */
  submitSlabOrder(side, price, size, id) {
    if (side !== null && typeof side === 'object') {
      const obj = side;
      id = obj.id;
      size = obj.size;
      price = obj.price;
      side = obj.side;
    }
    const sideCode = this._normalizeSide(side);
    const orderId = id !== undefined && id !== null ? (id | 0) : this._autoIdSeq++;
    const incomingTicks = Math.round(price * this.invTickSize) | 0;

    let remainingSize = +size;
    let remainingLots = Math.max(1, Math.round(remainingSize * this.invLotSize) | 0);
    let filledSize = 0.0;
    let matchCount = 0;
    let lastFillPrice = 0.0;

    let curr = sideCode === SIDE_BUY ? this.askHead : this.bidHead;

    while (curr !== -1 && remainingSize > 1e-9) {
      const restingTicks = this.priceTicks[curr];

      // Invoke hand-assembled WASM branchless tick crossing kernel
      if (wasmPriceCrosses(sideCode, incomingTicks, restingTicks) === 0) {
        break;
      }

      const restSize = this.sizes[curr];
      const restLots = this.sizeLots[curr];
      const fillPrice = this.prices[curr];

      // Invoke WASM branchless minInt for lot matching & notional calculation
      const matchedLots = wasmMinInt(remainingLots, restLots);
      this.totalNotionalCents += wasmCalcNotionalCents(restingTicks, matchedLots, this.tickScaleBps) * 0.01;

      const matchQty = remainingSize < restSize ? remainingSize : restSize;
      remainingSize -= matchQty;
      remainingLots -= matchedLots;
      filledSize += matchQty;
      matchCount += 1;
      lastFillPrice = fillPrice;
      this.totalVolume += matchQty;

      const next = this.nextIdx[curr];
      const newRestSize = restSize - matchQty;

      if (newRestSize <= 1e-9) {
        // Resting order fully filled — unlink from head in O(1) and return slot to slab free list
        if (sideCode === SIDE_BUY) {
          this.askHead = next;
          if (next !== -1) {
            this.prevIdx[next] = -1;
          } else {
            this.askTail = -1;
          }
        } else {
          this.bidHead = next;
          if (next !== -1) {
            this.prevIdx[next] = -1;
          } else {
            this.bidTail = -1;
          }
        }
        this._freeSlot(curr);
        this.totalMatchedOrders += 1;
      } else {
        this.sizes[curr] = newRestSize;
        this.sizeLots[curr] = restLots - matchedLots;
      }

      curr = next;
    }

    if (matchCount > 0) {
      this.lastPrice = lastFillPrice;
      if (remainingSize <= 1e-9) {
        this.totalMatchedOrders += 1;
      }
    }

    let restingId = -1;
    if (remainingSize > 1e-9) {
      const slot = this._allocSlot();
      if (slot !== -1) {
        this.orderIds[slot] = orderId;
        this.sides[slot] = sideCode;
        this.prices[slot] = price;
        this.priceTicks[slot] = incomingTicks;
        this.sizes[slot] = remainingSize;
        this.sizeLots[slot] = Math.max(1, remainingLots);

        if (orderId >= 0 && orderId < this.maxDirectId) {
          this.idToSlot[orderId] = slot;
        } else {
          this.overflowIdMap.set(orderId, slot);
        }

        this._insertIntrusive(slot, sideCode, incomingTicks);
        restingId = orderId;
      }
    }

    const out = this._resultPool[this._resultCursor];
    this._resultCursor = (this._resultCursor + 1) & RESULT_POOL_MASK;
    out.filledSize = filledSize;
    out.restingId = restingId;
    out.matchCount = matchCount;
    out.lastFillPrice = lastFillPrice;
    return out;
  }

  /**
   * Cancel a resting order by ID in O(1) time via direct slab slot lookup & intrusive list splice.
   * @param {number} id
   * @returns {boolean} true if order was active and cancelled
   */
  cancelSlabOrder(id) {
    const orderId = id | 0;
    let slot = -1;
    if (orderId >= 0 && orderId < this.maxDirectId) {
      slot = this.idToSlot[orderId];
    } else if (this.overflowIdMap.size > 0) {
      const mapped = this.overflowIdMap.get(orderId);
      if (mapped !== undefined) slot = mapped;
    }

    if (slot === -1 || this.activeFlags[slot] === 0) {
      return false;
    }

    const sideCode = this.sides[slot];
    const prev = this.prevIdx[slot];
    const next = this.nextIdx[slot];

    if (sideCode === SIDE_BUY) {
      if (prev !== -1) {
        this.nextIdx[prev] = next;
      } else {
        this.bidHead = next;
      }
      if (next !== -1) {
        this.prevIdx[next] = prev;
      } else {
        this.bidTail = prev;
      }
    } else {
      if (prev !== -1) {
        this.nextIdx[prev] = next;
      } else {
        this.askHead = next;
      }
      if (next !== -1) {
        this.prevIdx[next] = prev;
      } else {
        this.askTail = prev;
      }
    }

    this._freeSlot(slot);
    return true;
  }

  /**
   * Return slab capacity, active resting orders, match counters, and WASM kernel telemetry.
   */
  getSlabMetrics() {
    return {
      symbol: this.symbol,
      capacity: this.capacity,
      activeOrders: this.activeOrders,
      freeSlots: this.capacity - this.activeOrders,
      utilizationPct: Number(((this.activeOrders / this.capacity) * 100).toFixed(2)),
      totalMatchedOrders: this.totalMatchedOrders,
      totalVolume: Number(this.totalVolume.toFixed(6)),
      totalNotionalUsd: Number((this.totalNotionalCents / 100).toFixed(2)),
      bestBid: this.bidHead !== -1 ? this.prices[this.bidHead] : null,
      bestAsk: this.askHead !== -1 ? this.prices[this.askHead] : null,
      lastPrice: this.lastPrice,
      wasmAccelerated: true,
      wasmExports: Object.keys(wasmExports)
    };
  }

  /**
   * Aggregate top-N price levels from the intrusive slab queues for L2 inspection.
   * @param {number} [depth=15]
   */
  getSnapshot(depth = 15) {
    const bids = [];
    let curr = this.bidHead;
    while (curr !== -1) {
      const p = this.prices[curr];
      const s = this.sizes[curr];
      const last = bids[bids.length - 1];
      if (last && Math.abs(last.price - p) < 1e-9) {
        last.size = Number((last.size + s).toFixed(4));
      } else {
        if (bids.length >= depth) break;
        bids.push({ price: p, size: Number(s.toFixed(4)), total: 0 });
      }
      curr = this.nextIdx[curr];
    }
    let bidTotal = 0;
    for (let i = 0; i < bids.length; i++) {
      bidTotal = Number((bidTotal + bids[i].size).toFixed(4));
      bids[i].total = bidTotal;
    }

    const asks = [];
    curr = this.askHead;
    while (curr !== -1) {
      const p = this.prices[curr];
      const s = this.sizes[curr];
      const last = asks[asks.length - 1];
      if (last && Math.abs(last.price - p) < 1e-9) {
        last.size = Number((last.size + s).toFixed(4));
      } else {
        if (asks.length >= depth) break;
        asks.push({ price: p, size: Number(s.toFixed(4)), total: 0 });
      }
      curr = this.nextIdx[curr];
    }
    let askTotal = 0;
    for (let i = 0; i < asks.length; i++) {
      askTotal = Number((askTotal + asks[i].size).toFixed(4));
      asks[i].total = askTotal;
    }

    const bestBid = bids[0]?.price ?? this.lastPrice - this.tickSize;
    const bestAsk = asks[0]?.price ?? this.lastPrice + this.tickSize;

    return {
      symbol: this.symbol,
      bids,
      asks,
      spread: Number(Math.max(0, bestAsk - bestBid).toFixed(4)),
      midPrice: Number(((bestBid + bestAsk) * 0.5).toFixed(4))
    };
  }
}

module.exports = {
  SlabOrderbook,
  WASM_BYTES,
  wasmModule,
  wasmInstance,
  wasmExports,
  SIDE_BUY,
  SIDE_SELL
};
