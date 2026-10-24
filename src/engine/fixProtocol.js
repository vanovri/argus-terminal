'use strict';

/**
 * ARGUS TERMINAL — FIX 4.4 Tag-Value Codec (educational subset) & SBE-inspired 40-Byte Binary Codec
 *
 * Implements:
 *   1. FIX 4.4 tag=value message codec (`FixProtocolEngine`). Builds/parses messages and
 *      handles NewOrderSingle -> ExecutionReport. Keeps simple in/out sequence counters and a
 *      demo session log, but implements no real session layer (logon negotiation, heartbeat
 *      timers, gap fill / resend).
 *      - Supports both ASCII SOH (`\x01`) and pipe (`|`) field delimiters
 *      - Computes & validates the standard FIX modulo-256 CheckSum (`Tag 10`, 3-digit zero-padded)
 *        and `BodyLength` (`Tag 9`)
 *      - `buildFixMessage(msgType, fields, options)`
 *      - `parseFixMessage(rawFixStr)`
 *      - `executeFixOrder(rawFixStr, matchingEngine, accountId)`
 *   2. A 40-byte fixed-layout binary order codec inspired by Simple Binary Encoding (SBE).
 *      It is a custom layout, not a CME (or any exchange) SBE schema.
 *      - Little-endian `DataView` encoding with 1e8 fixed-point mantissas
 *      - `encodeSbeOrder(params)` -> 40-byte `Buffer` / `Uint8Array`
 *      - `decodeSbeOrder(buffer)` -> structured order object (round-trips values representable at 1e-8)
 */

const SOH = '\x01';
const PIPE = '|';
const SBE_FRAME_BYTES = 40;
const SBE_MANTISSA_SCALE = 100000000n; // 1e8 fixed-point scaling
const SBE_MANTISSA_NUMBER = 1e8;

const SYMBOL_TO_ID = {
  'BTC-USD': 1,
  'ETH-USD': 2,
  'SOL-USD': 3,
  'NVDA-EQ': 4,
  'XAU-USD': 5,
  'IDR-USD': 6
};

const ID_TO_SYMBOL = {
  1: 'BTC-USD',
  2: 'ETH-USD',
  3: 'SOL-USD',
  4: 'NVDA-EQ',
  5: 'XAU-USD',
  6: 'IDR-USD'
};

const FIX_MSG_TYPE_NAMES = {
  '0': 'Heartbeat',
  '1': 'TestRequest',
  '2': 'ResendRequest',
  '3': 'Reject',
  '4': 'SequenceReset',
  '5': 'Logout',
  '8': 'ExecutionReport',
  '9': 'OrderCancelReject',
  'A': 'Logon',
  'D': 'NewOrderSingle',
  'F': 'OrderCancelRequest',
  'G': 'OrderCancelReplaceRequest',
  'V': 'MarketDataRequest',
  'W': 'MarketDataSnapshotFullRefresh'
};

const FRIENDLY_MSG_TYPE_TO_CODE = {
  HEARTBEAT: '0',
  TESTREQUEST: '1',
  REJECT: '3',
  LOGOUT: '5',
  EXECUTIONREPORT: '8',
  EXECUTION_REPORT: '8',
  LOGON: 'A',
  NEWORDERSINGLE: 'D',
  NEW_ORDER_SINGLE: 'D',
  ORDER: 'D',
  ORDERCANCELREQUEST: 'F',
  ORDER_CANCEL_REQUEST: 'F',
  CANCEL: 'F'
};

const FIX_TAG_NAMES = {
  1: 'Account',
  6: 'AvgPx',
  8: 'BeginString',
  9: 'BodyLength',
  10: 'CheckSum',
  11: 'ClOrdID',
  14: 'CumQty',
  17: 'ExecID',
  31: 'LastPx',
  32: 'LastShares',
  34: 'MsgSeqNum',
  35: 'MsgType',
  37: 'OrderID',
  38: 'OrderQty',
  39: 'OrdStatus',
  40: 'OrdType',
  41: 'OrigClOrdID',
  44: 'Price',
  49: 'SenderCompID',
  52: 'SendingTime',
  54: 'Side',
  55: 'Symbol',
  56: 'TargetCompID',
  58: 'Text',
  59: 'TimeInForce',
  60: 'TransactTime',
  150: 'ExecType',
  151: 'LeavesQty'
};

const EXEC_TYPE_MAP = {
  '0': 'NEW',
  '1': 'PARTIAL_FILL',
  '2': 'FILL',
  '4': 'CANCELED',
  '8': 'REJECTED'
};

const ORD_STATUS_MAP = {
  '0': 'NEW',
  '1': 'PARTIALLY_FILLED',
  '2': 'FILLED',
  '4': 'CANCELED',
  '8': 'REJECTED'
};

// Track original string vs numeric enum representation for SBE buffers when decoded in-process
const sbeMetadataMap = new WeakMap();

/**
 * Format timestamp into standard FIX 4.4 UTC SendingTime (YYYYMMDD-HH:MM:SS.sss)
 * @param {number|Date} [ts]
 * @returns {string}
 */
function formatFixUtcTimestamp(ts = Date.now()) {
  const d = ts instanceof Date ? ts : new Date(Number(ts) || Date.now());
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const mmm = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${yyyy}${mm}${dd}-${hh}:${min}:${ss}.${mmm}`;
}

/**
 * Compute official FIX 4.4 Modulo-256 checksum (3-digit zero-padded string e.g. '142')
 * over all bytes of the message up to and including the delimiter preceding Tag 10.
 *
 * @param {string|Buffer|Uint8Array} rawPrefix
 * @returns {string}
 */
function computeFixChecksum(rawPrefix) {
  let sum = 0;
  if (typeof rawPrefix === 'string') {
    for (let i = 0; i < rawPrefix.length; i++) {
      sum = (sum + rawPrefix.charCodeAt(i)) & 0xff;
    }
  } else if (rawPrefix && typeof rawPrefix.length === 'number') {
    for (let i = 0; i < rawPrefix.length; i++) {
      sum = (sum + rawPrefix[i]) & 0xff;
    }
  }
  return String(sum % 256).padStart(3, '0');
}

/**
 * Normalize MsgType input ('D', 'NewOrderSingle', etc.) into canonical FIX 4.4 MsgType code.
 * @param {string} msgType
 * @returns {string}
 */
function normalizeMsgType(msgType) {
  const raw = String(msgType || 'D').trim();
  const upper = raw.toUpperCase();
  if (FRIENDLY_MSG_TYPE_TO_CODE[upper]) {
    return FRIENDLY_MSG_TYPE_TO_CODE[upper];
  }
  return raw;
}

/**
 * Normalize Side ('1', '2', 1, 2, 'BUY', 'SELL') into FIX Tag 54 code ('1' or '2').
 * @param {string|number} side
 * @returns {string}
 */
function normalizeSideToFix(side) {
  if (side === 1 || side === '1') return '1';
  if (side === 2 || side === '2') return '2';
  const upper = String(side || '').trim().toUpperCase();
  if (upper === 'BUY' || upper === 'BID' || upper === 'B') return '1';
  if (upper === 'SELL' || upper === 'ASK' || upper === 'OFFER' || upper === 'S') return '2';
  return String(side);
}

/**
 * Normalize OrdType ('1', '2', 1, 2, 'MARKET', 'LIMIT') into FIX Tag 40 code ('1' or '2').
 * @param {string|number} ordType
 * @returns {string}
 */
function normalizeOrdTypeToFix(ordType) {
  if (ordType === 1 || ordType === '1') return '1';
  if (ordType === 2 || ordType === '2') return '2';
  const upper = String(ordType || '').trim().toUpperCase();
  if (upper === 'MARKET' || upper === 'MKT') return '1';
  if (upper === 'LIMIT' || upper === 'LMT') return '2';
  return String(ordType);
}

/**
 * Convert named or numeric fields object into an ordered array of [tagNumberString, valueString]
 * excluding header/trailer structural tags (8, 9, 35, 49, 56, 34, 52, 10).
 *
 * @param {object|Array} fields
 * @returns {Array<[string, string]>}
 */
function normalizeBodyFields(fields) {
  if (!fields) return [];

  if (Array.isArray(fields)) {
    return fields
      .filter((pair) => Array.isArray(pair) && pair.length >= 2 && pair[1] !== undefined && pair[1] !== null)
      .map(([k, v]) => [String(k), String(v)]);
  }

  const tagMap = new Map();

  const setTag = (tag, val) => {
    if (val === undefined || val === null || val === '') return;
    tagMap.set(String(tag), String(val));
  };

  // Friendly key mappings
  if (fields.account !== undefined || fields.accountId !== undefined || fields.Account !== undefined) {
    setTag(1, fields.account ?? fields.accountId ?? fields.Account);
  }
  if (fields.clOrdId !== undefined || fields.clOrdID !== undefined || fields.ClOrdID !== undefined) {
    setTag(11, fields.clOrdId ?? fields.clOrdID ?? fields.ClOrdID);
  }
  if (fields.origClOrdId !== undefined || fields.origClOrdID !== undefined || fields.OrigClOrdID !== undefined) {
    setTag(41, fields.origClOrdId ?? fields.origClOrdID ?? fields.OrigClOrdID);
  }
  if (fields.orderId !== undefined || fields.orderID !== undefined || fields.OrderID !== undefined) {
    setTag(37, fields.orderId ?? fields.orderID ?? fields.OrderID);
  }
  if (fields.execId !== undefined || fields.execID !== undefined || fields.ExecID !== undefined) {
    setTag(17, fields.execId ?? fields.execID ?? fields.ExecID);
  }
  if (fields.execType !== undefined || fields.ExecType !== undefined) {
    setTag(150, fields.execType ?? fields.ExecType);
  }
  if (fields.ordStatus !== undefined || fields.OrdStatus !== undefined) {
    setTag(39, fields.ordStatus ?? fields.OrdStatus);
  }
  if (fields.symbol !== undefined || fields.Symbol !== undefined) {
    setTag(55, fields.symbol ?? fields.Symbol);
  }
  if (fields.side !== undefined || fields.Side !== undefined) {
    setTag(54, normalizeSideToFix(fields.side ?? fields.Side));
  }
  if (fields.ordType !== undefined || fields.OrdType !== undefined || fields.type !== undefined) {
    setTag(40, normalizeOrdTypeToFix(fields.ordType ?? fields.OrdType ?? fields.type));
  }
  if (fields.orderQty !== undefined || fields.OrderQty !== undefined || fields.size !== undefined || fields.qty !== undefined) {
    setTag(38, fields.orderQty ?? fields.OrderQty ?? fields.size ?? fields.qty);
  }
  if (fields.price !== undefined || fields.Price !== undefined) {
    setTag(44, fields.price ?? fields.Price);
  }
  if (fields.timeInForce !== undefined || fields.TimeInForce !== undefined) {
    setTag(59, fields.timeInForce ?? fields.TimeInForce);
  }
  if (fields.lastShares !== undefined || fields.LastShares !== undefined || fields.lastQty !== undefined) {
    setTag(32, fields.lastShares ?? fields.LastShares ?? fields.lastQty);
  }
  if (fields.lastPx !== undefined || fields.LastPx !== undefined) {
    setTag(31, fields.lastPx ?? fields.LastPx);
  }
  if (fields.leavesQty !== undefined || fields.LeavesQty !== undefined) {
    setTag(151, fields.leavesQty ?? fields.LeavesQty);
  }
  if (fields.cumQty !== undefined || fields.CumQty !== undefined) {
    setTag(14, fields.cumQty ?? fields.CumQty);
  }
  if (fields.avgPx !== undefined || fields.AvgPx !== undefined) {
    setTag(6, fields.avgPx ?? fields.AvgPx);
  }
  if (fields.transactTime !== undefined || fields.TransactTime !== undefined) {
    setTag(60, fields.transactTime ?? fields.TransactTime);
  }
  if (fields.text !== undefined || fields.Text !== undefined) {
    setTag(58, fields.text ?? fields.Text);
  }

  // Direct numeric tag keys (override or supplement friendly keys)
  const reservedHeaderTrailer = new Set(['8', '9', '35', '49', '56', '34', '52', '10']);
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined || val === null || val === '') continue;
    if (/^\d+$/.test(key) && !reservedHeaderTrailer.has(key)) {
      if (key === '54') {
        tagMap.set('54', normalizeSideToFix(val));
      } else if (key === '40') {
        tagMap.set('40', normalizeOrdTypeToFix(val));
      } else {
        tagMap.set(key, String(val));
      }
    }
  }

  // Canonical institutional tag ordering
  const canonicalOrder = [
    '1', '11', '41', '37', '17', '150', '39',
    '55', '54', '40', '38', '44', '59',
    '32', '31', '151', '14', '6', '60', '58'
  ];
  const ordered = [];
  const emitted = new Set();

  for (const tag of canonicalOrder) {
    if (tagMap.has(tag)) {
      ordered.push([tag, tagMap.get(tag)]);
      emitted.add(tag);
    }
  }
  for (const [tag, val] of tagMap.entries()) {
    if (!emitted.has(tag)) {
      ordered.push([tag, val]);
    }
  }
  return ordered;
}

/**
 * Encode an institutional order into a 40-byte CME Simple Binary Encoding (SBE) wire buffer.
 *
 * Fixed 40-Byte Little-Endian Wire Layout:
 *   Offset  0..1  (2B) : u16 templateId     (default 101 = NewOrderSingle)
 *   Offset  2..3  (2B) : u16 schemaVersion  (default 1)
 *   Offset  4..7  (4B) : u32 seqNum
 *   Offset  8..15 (8B) : u64 timestampNs    (nanoseconds since Unix epoch)
 *   Offset 16..19 (4B) : u32 orderIdNum
 *   Offset 20..21 (2B) : u16 symbolId       (1=BTC-USD .. 6=IDR-USD)
 *   Offset 22     (1B) : u8  side           (1=BUY, 2=SELL)
 *   Offset 23     (1B) : u8  ordType        (1=MARKET, 2=LIMIT)
 *   Offset 24..31 (8B) : i64 priceMantissa  (price * 1e8 fixed-point)
 *   Offset 32..39 (8B) : i64 sizeMantissa   (size * 1e8 fixed-point)
 *
 * @param {object} params
 * @returns {Buffer} 40-byte Buffer (also Uint8Array instance)
 */
function encodeSbeOrder(params = {}) {
  const {
    templateId = 101,
    schemaVersion = 1,
    seqNum = 1,
    timestampNs,
    orderIdNum = 1001,
    symbolId,
    symbol,
    side = 1,
    ordType = 2,
    type,
    price = 0,
    size = 0,
    orderQty
  } = params;

  const arrayBuffer = new ArrayBuffer(SBE_FRAME_BYTES);
  const view = new DataView(arrayBuffer);

  // Resolve symbolId (supports numeric 1..6 or string 'BTC-USD')
  let resolvedSymbolId = 1;
  if (typeof symbolId === 'number' && Number.isFinite(symbolId)) {
    resolvedSymbolId = symbolId & 0xffff;
  } else if (typeof symbolId === 'string' && SYMBOL_TO_ID[symbolId.toUpperCase()]) {
    resolvedSymbolId = SYMBOL_TO_ID[symbolId.toUpperCase()];
  } else if (typeof symbol === 'string' && SYMBOL_TO_ID[symbol.toUpperCase()]) {
    resolvedSymbolId = SYMBOL_TO_ID[symbol.toUpperCase()];
  } else if (typeof symbolId === 'string' && /^\d+$/.test(symbolId)) {
    resolvedSymbolId = Number(symbolId) & 0xffff;
  }

  // Resolve side code (1=BUY, 2=SELL)
  let resolvedSideCode = 1;
  if (typeof side === 'number') {
    resolvedSideCode = side & 0xff;
  } else if (typeof side === 'string') {
    const sUpper = side.trim().toUpperCase();
    if (sUpper === 'SELL' || sUpper === '2' || sUpper === 'ASK') {
      resolvedSideCode = 2;
    } else {
      resolvedSideCode = 1;
    }
  }

  // Resolve ordType code (1=MARKET, 2=LIMIT)
  const rawOrdType = ordType !== undefined ? ordType : (type !== undefined ? type : 2);
  let resolvedOrdTypeCode = 2;
  if (typeof rawOrdType === 'number') {
    resolvedOrdTypeCode = rawOrdType & 0xff;
  } else if (typeof rawOrdType === 'string') {
    const tUpper = rawOrdType.trim().toUpperCase();
    if (tUpper === 'MARKET' || tUpper === '1' || tUpper === 'MKT') {
      resolvedOrdTypeCode = 1;
    } else {
      resolvedOrdTypeCode = 2;
    }
  }

  // Resolve orderIdNum (supports integer or string like 'ORD-1042')
  let resolvedOrderIdNum = 1001;
  if (typeof orderIdNum === 'number' && Number.isFinite(orderIdNum)) {
    resolvedOrderIdNum = orderIdNum >>> 0;
  } else if (typeof orderIdNum === 'string') {
    const digits = orderIdNum.replace(/\D+/g, '');
    resolvedOrderIdNum = digits ? (Number(digits.slice(-9)) >>> 0) : 1001;
  }

  // Resolve timestampNs (u64)
  let resolvedTimestampNs;
  if (typeof timestampNs === 'bigint') {
    resolvedTimestampNs = timestampNs;
  } else if (typeof timestampNs === 'number' && Number.isFinite(timestampNs)) {
    resolvedTimestampNs = BigInt(Math.trunc(timestampNs));
  } else {
    resolvedTimestampNs = BigInt(Date.now()) * 1000000n;
  }

  // Fixed-point mantissas (i64 scaled by 1e8)
  const numericPrice = Number(price) || 0;
  const numericSize = Number(size !== undefined ? size : (orderQty !== undefined ? orderQty : 0)) || 0;
  const priceMantissa = BigInt(Math.round(numericPrice * SBE_MANTISSA_NUMBER));
  const sizeMantissa = BigInt(Math.round(numericSize * SBE_MANTISSA_NUMBER));

  view.setUint16(0, Number(templateId) & 0xffff, true);
  view.setUint16(2, Number(schemaVersion) & 0xffff, true);
  view.setUint32(4, Number(seqNum) >>> 0, true);
  view.setBigUint64(8, resolvedTimestampNs, true);
  view.setUint32(16, resolvedOrderIdNum, true);
  view.setUint16(20, resolvedSymbolId, true);
  view.setUint8(22, resolvedSideCode);
  view.setUint8(23, resolvedOrdTypeCode);
  view.setBigInt64(24, priceMantissa, true);
  view.setBigInt64(32, sizeMantissa, true);

  const buf = Buffer.from(arrayBuffer);
  sbeMetadataMap.set(buf, {
    sideWasString: typeof side === 'string',
    sideString: typeof side === 'string' ? side : null,
    ordTypeWasString: typeof rawOrdType === 'string',
    ordTypeString: typeof rawOrdType === 'string' ? rawOrdType : null
  });
  return buf;
}

/**
 * Decode a 40-byte CME SBE binary buffer back into a structured order object with zero precision loss.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|string} buffer
 * @returns {object}
 */
function decodeSbeOrder(buffer) {
  let uint8;
  let meta = null;

  if (typeof buffer === 'string') {
    const cleanHex = buffer.replace(/[^0-9a-fA-F]/g, '');
    uint8 = Buffer.from(cleanHex, 'hex');
  } else if (buffer instanceof ArrayBuffer) {
    uint8 = new Uint8Array(buffer);
  } else if (ArrayBuffer.isView(buffer)) {
    meta = sbeMetadataMap.get(buffer) || null;
    uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } else {
    throw new Error('Invalid SBE buffer: expected 40-byte Buffer, Uint8Array, ArrayBuffer, or hex string');
  }

  if (uint8.byteLength < SBE_FRAME_BYTES) {
    throw new Error(`Invalid SBE frame length: expected ${SBE_FRAME_BYTES} bytes, got ${uint8.byteLength}`);
  }

  const view = new DataView(uint8.buffer, uint8.byteOffset, SBE_FRAME_BYTES);

  const templateId = view.getUint16(0, true);
  const schemaVersion = view.getUint16(2, true);
  const seqNum = view.getUint32(4, true);
  const timestampNs = view.getBigUint64(8, true);
  const orderIdNum = view.getUint32(16, true);
  const symbolId = view.getUint16(20, true);
  const sideCode = view.getUint8(22);
  const ordTypeCode = view.getUint8(23);
  const priceMantissa = view.getBigInt64(24, true);
  const sizeMantissa = view.getBigInt64(32, true);

  const price = Number(priceMantissa) / SBE_MANTISSA_NUMBER;
  const size = Number(sizeMantissa) / SBE_MANTISSA_NUMBER;

  const sideName = sideCode === 2 ? 'SELL' : 'BUY';
  const ordTypeName = ordTypeCode === 1 ? 'MARKET' : 'LIMIT';
  const symbol = ID_TO_SYMBOL[symbolId] || `SYM-${symbolId}`;

  const resolvedSide = meta && meta.sideWasString ? sideName : sideCode;
  const resolvedOrdType = meta && meta.ordTypeWasString ? ordTypeName : ordTypeCode;

  return {
    templateId,
    schemaVersion,
    seqNum,
    timestampNs,
    timestampMs: Number(timestampNs / 1000000n),
    orderIdNum,
    symbolId,
    symbol,
    side: resolvedSide,
    sideCode,
    sideName,
    ordType: resolvedOrdType,
    ordTypeCode,
    ordTypeName,
    priceMantissa,
    sizeMantissa,
    price,
    size,
    byteLength: SBE_FRAME_BYTES,
    hexWire: Buffer.from(uint8.buffer, uint8.byteOffset, SBE_FRAME_BYTES).toString('hex').toUpperCase()
  };
}

class FixProtocolEngine {
  /**
   * @param {object} [matchingEngine]
   * @param {object} [options]
   */
  constructor(matchingEngine = null, options = {}) {
    this.matchingEngine = matchingEngine;
    this.senderCompId = options.senderCompId || 'BUYSIDE-ALPH';
    this.targetCompId = options.targetCompId || 'ARGUS-DMA';
    this.inboundSeqNum = 1;
    this.outboundSeqNum = 1;
    this.sessionLog = [];

    this._seedInitialSessionLog();
  }

  _seedInitialSessionLog() {
    const now = Date.now();
    const logonMsg = this.buildFixMessage(
      'A',
      { 98: '0', 108: '30', 141: 'Y' },
      {
        senderCompId: 'BUYSIDE-ALPH',
        targetCompId: 'ARGUS-DMA',
        msgSeqNum: 1,
        sendingTime: formatFixUtcTimestamp(now - 12000),
        delimiter: PIPE
      }
    );
    const logonAck = this.buildFixMessage(
      'A',
      { 98: '0', 108: '30', 141: 'Y' },
      {
        senderCompId: 'ARGUS-DMA',
        targetCompId: 'BUYSIDE-ALPH',
        msgSeqNum: 1,
        sendingTime: formatFixUtcTimestamp(now - 11995),
        delimiter: PIPE
      }
    );
    const heartbeatMsg = this.buildFixMessage(
      '0',
      { 112: 'HB-SYNC-01' },
      {
        senderCompId: 'ARGUS-DMA',
        targetCompId: 'BUYSIDE-ALPH',
        msgSeqNum: 2,
        sendingTime: formatFixUtcTimestamp(now - 6000),
        delimiter: PIPE
      }
    );

    this.sessionLog.push(
      {
        id: 'FIX-LOG-1',
        timestamp: now - 12000,
        direction: 'INBOUND',
        msgType: 'A',
        msgTypeName: 'Logon',
        senderCompId: 'BUYSIDE-ALPH',
        targetCompId: 'ARGUS-DMA',
        seqNum: 1,
        validChecksum: true,
        rawFix: logonMsg,
        summary: 'FIX.4.4 Session Logon (HeartBtInt=30s, EncryptMethod=NONE)'
      },
      {
        id: 'FIX-LOG-2',
        timestamp: now - 11995,
        direction: 'OUTBOUND',
        msgType: 'A',
        msgTypeName: 'Logon',
        senderCompId: 'ARGUS-DMA',
        targetCompId: 'BUYSIDE-ALPH',
        seqNum: 1,
        validChecksum: true,
        rawFix: logonAck,
        summary: 'FIX.4.4 Session Logon Established (ARGUS-DMA <-> BUYSIDE-ALPH)'
      },
      {
        id: 'FIX-LOG-3',
        timestamp: now - 6000,
        direction: 'OUTBOUND',
        msgType: '0',
        msgTypeName: 'Heartbeat',
        senderCompId: 'ARGUS-DMA',
        targetCompId: 'BUYSIDE-ALPH',
        seqNum: 2,
        validChecksum: true,
        rawFix: heartbeatMsg,
        summary: 'FIX.4.4 Session Heartbeat (TestReqID=HB-SYNC-01)'
      }
    );
    this.inboundSeqNum = 2;
    this.outboundSeqNum = 3;
  }

  /**
   * Build a compliant FIX 4.4 wire message:
   *   8=FIX.4.4|9=...|35=...|49=...|56=...|34=...|52=...|...10=...|
   *
   * @param {string} msgType - e.g. 'D' (NewOrderSingle), '8' (ExecutionReport), 'F' (OrderCancelRequest)
   * @param {object|Array} [fields={}] - Tag-value map or semantic order fields
   * @param {object} [options={}]
   * @returns {string}
   */
  buildFixMessage(
    msgType = 'D',
    fields = {},
    {
      senderCompId = 'BUYSIDE-ALPH',
      targetCompId = 'ARGUS-DMA',
      msgSeqNum = 1,
      delimiter = PIPE,
      sendingTime = null
    } = {}
  ) {
    const delim = delimiter === SOH ? SOH : PIPE;
    const resolvedMsgType = normalizeMsgType(msgType);
    const resolvedSender = (fields && (fields['49'] || fields.SenderCompID || fields.senderCompId)) || senderCompId || 'BUYSIDE-ALPH';
    const resolvedTarget = (fields && (fields['56'] || fields.TargetCompID || fields.targetCompId)) || targetCompId || 'ARGUS-DMA';
    const resolvedSeq = (fields && (fields['34'] || fields.MsgSeqNum || fields.msgSeqNum)) || msgSeqNum || 1;
    const resolvedSendingTime = (fields && (fields['52'] || fields.SendingTime || fields.sendingTime)) || sendingTime || formatFixUtcTimestamp();

    const bodyPairs = [
      ['35', resolvedMsgType],
      ['49', String(resolvedSender)],
      ['56', String(resolvedTarget)],
      ['34', String(resolvedSeq)],
      ['52', String(resolvedSendingTime)],
      ...normalizeBodyFields(fields)
    ];

    const bodySegment = bodyPairs.map(([tag, val]) => `${tag}=${val}${delim}`).join('');
    const bodyLength = Buffer.byteLength(bodySegment, 'utf8');
    const prefixWithBody = `8=FIX.4.4${delim}9=${bodyLength}${delim}${bodySegment}`;
    const checksum = computeFixChecksum(prefixWithBody);

    return `${prefixWithBody}10=${checksum}${delim}`;
  }

  /**
   * Parse any FIX 4.4 string (pipe `|` or SOH `\x01` delimited), verify Tag 10 Modulo-256 checksum,
   * map standard tags, and return structured diagnostics + normalizedOrder.
   *
   * @param {string} rawFixStr
   * @returns {object}
   */
  parseFixMessage(rawFixStr) {
    const raw = String(rawFixStr || '').trim();
    if (!raw) {
      return {
        validChecksum: false,
        expectedChecksum: '000',
        providedChecksum: null,
        msgType: null,
        msgTypeName: 'Unknown',
        fields: {},
        normalizedOrder: null
      };
    }

    const delimiter = raw.includes(SOH) ? SOH : PIPE;

    // Locate the trailer Tag 10 (`|10=XXX` or `\x0110=XXX`) to compute exact checksum over prefix
    let providedChecksum = null;
    let expectedChecksum = '000';
    let validChecksum = false;

    const tag10Match = /(?:^|[\x01|])10=([^\x01|]*)(?:[\x01|]|$)/.exec(raw);
    if (tag10Match) {
      providedChecksum = tag10Match[1];
      // Prefix includes the delimiter immediately before '10='
      const matchIndex = tag10Match.index;
      const prefixEndIndex = raw[matchIndex] === SOH || raw[matchIndex] === PIPE
        ? matchIndex + 1
        : matchIndex;
      const prefixSlice = raw.slice(0, prefixEndIndex);
      expectedChecksum = computeFixChecksum(prefixSlice);
      validChecksum = providedChecksum === expectedChecksum;
    } else {
      const prefixSlice = raw.endsWith(delimiter) ? raw : `${raw}${delimiter}`;
      expectedChecksum = computeFixChecksum(prefixSlice);
      validChecksum = false;
    }

    // Extract all tag=value pairs
    const tokens = raw.split(/[\x01|]+/).filter(Boolean);
    const fields = {};
    const tagList = [];

    for (const token of tokens) {
      const eqIdx = token.indexOf('=');
      if (eqIdx <= 0) continue;
      const tag = token.slice(0, eqIdx).trim();
      const val = token.slice(eqIdx + 1).trim();
      fields[tag] = val;
      if (FIX_TAG_NAMES[tag]) {
        fields[FIX_TAG_NAMES[tag]] = val;
      }
      tagList.push({
        tag: Number(tag) || tag,
        name: FIX_TAG_NAMES[tag] || `Tag${tag}`,
        value: val
      });
    }

    // Compute BodyLength verification if Tag 9 is present
    let validBodyLength = true;
    let computedBodyLength = 0;
    const bodyMatch = /^8=[^\x01|]+[\x01|]9=(\d+)[\x01|]([\s\S]*?)(?:10=[^\x01|]*[\x01|]?$|$)/.exec(raw);
    if (bodyMatch) {
      const declaredLen = Number(bodyMatch[1]);
      computedBodyLength = Buffer.byteLength(bodyMatch[2], 'utf8');
      validBodyLength = declaredLen === computedBodyLength;
    }

    const msgType = fields['35'] || null;
    const msgTypeName = FIX_MSG_TYPE_NAMES[msgType] || 'CustomFixMessage';

    const rawSide = fields['54'];
    const side =
      rawSide === '1' || String(rawSide).toUpperCase() === 'BUY'
        ? 'BUY'
        : rawSide === '2' || String(rawSide).toUpperCase() === 'SELL'
        ? 'SELL'
        : null;

    const rawOrdType = fields['40'];
    const ordType =
      rawOrdType === '1' || String(rawOrdType).toUpperCase() === 'MARKET'
        ? 'MARKET'
        : rawOrdType === '2' || String(rawOrdType).toUpperCase() === 'LIMIT'
        ? 'LIMIT'
        : fields['44'] !== undefined
        ? 'LIMIT'
        : 'MARKET';

    const price = fields['44'] !== undefined && fields['44'] !== '' ? Number(fields['44']) : null;
    const orderQty = fields['38'] !== undefined && fields['38'] !== '' ? Number(fields['38']) : null;
    const lastPx = fields['31'] !== undefined && fields['31'] !== '' ? Number(fields['31']) : null;
    const lastShares = fields['32'] !== undefined && fields['32'] !== '' ? Number(fields['32']) : null;
    const leavesQty = fields['151'] !== undefined && fields['151'] !== '' ? Number(fields['151']) : null;
    const cumQty = fields['14'] !== undefined && fields['14'] !== '' ? Number(fields['14']) : null;
    const avgPx = fields['6'] !== undefined && fields['6'] !== '' ? Number(fields['6']) : null;

    const rawExecType = fields['150'] ?? null;
    const rawOrdStatus = fields['39'] ?? null;

    const normalizedOrder = {
      msgType,
      msgTypeName,
      clOrdId: fields['11'] || null,
      origClOrdId: fields['41'] || null,
      orderId: fields['37'] || fields['11'] || null,
      id: fields['11'] || fields['37'] || null,
      accountId: fields['1'] || 'ACC-INST-01',
      symbol: fields['55'] || 'BTC-USD',
      side,
      type: ordType,
      ordType,
      price,
      size: orderQty,
      orderQty,
      execType: rawExecType ? (EXEC_TYPE_MAP[rawExecType] || rawExecType) : null,
      execTypeCode: rawExecType,
      ordStatus: rawOrdStatus ? (ORD_STATUS_MAP[rawOrdStatus] || rawOrdStatus) : null,
      ordStatusCode: rawOrdStatus,
      lastPx,
      lastShares,
      leavesQty,
      cumQty,
      avgPx,
      senderCompId: fields['49'] || null,
      targetCompId: fields['56'] || null,
      msgSeqNum: fields['34'] ? Number(fields['34']) : null,
      sendingTime: fields['52'] || null,
      text: fields['58'] || null
    };

    return {
      validChecksum,
      expectedChecksum,
      providedChecksum,
      validBodyLength,
      bodyLength: fields['9'] ? Number(fields['9']) : computedBodyLength,
      computedBodyLength,
      delimiter: delimiter === SOH ? 'SOH' : 'PIPE',
      msgType,
      msgTypeName,
      fields,
      tagList,
      normalizedOrder
    };
  }

  /**
   * Parse an incoming `35=D` (NewOrderSingle) or `35=F` (OrderCancelRequest) FIX 4.4 message,
   * execute it against `matchingEngine`, and return both the execution result and the outbound
   * `35=8` (ExecutionReport) FIX 4.4 wire string + recent FIX session log.
   *
   * @param {string} rawFixStr
   * @param {object} [matchingEngine]
   * @param {string} [accountId='ACC-INST-01']
   * @returns {object}
   */
  executeFixOrder(rawFixStr, matchingEngine = null, accountId = 'ACC-INST-01') {
    const engine = matchingEngine || this.matchingEngine;
    if (!engine) {
      throw new Error('FixProtocolEngine.executeFixOrder requires a MatchingEngine instance');
    }

    const delimiter = String(rawFixStr || '').includes(SOH) ? SOH : PIPE;
    const parsed = this.parseFixMessage(rawFixStr);
    const now = Date.now();

    const inSender = parsed.fields['49'] || this.senderCompId;
    const inTarget = parsed.fields['56'] || this.targetCompId;
    const inSeq = parsed.fields['34'] ? Number(parsed.fields['34']) : this.inboundSeqNum++;
    const resolvedAccountId = parsed.fields['1'] || accountId || 'ACC-INST-01';

    this._appendLog({
      timestamp: now,
      direction: 'INBOUND',
      msgType: parsed.msgType || 'D',
      msgTypeName: parsed.msgTypeName,
      senderCompId: inSender,
      targetCompId: inTarget,
      seqNum: inSeq,
      validChecksum: parsed.validChecksum,
      rawFix: String(rawFixStr || '').trim(),
      summary: `${parsed.msgTypeName} (${parsed.normalizedOrder?.symbol || 'BTC-USD'} ${parsed.normalizedOrder?.side || ''} ${parsed.normalizedOrder?.size ?? ''})`.trim()
    });

    const msgType = parsed.msgType || 'D';
    const norm = parsed.normalizedOrder || {};

    // Handle 35=F (OrderCancelRequest)
    if (msgType === 'F') {
      const targetOrderId = norm.origClOrdId || norm.orderId || norm.clOrdId;
      const symbol = norm.symbol || 'BTC-USD';
      const cancelled = engine.cancelOrder(targetOrderId, symbol);

      const execTypeCode = cancelled ? '4' : '8'; // 4 = Canceled, 8 = Rejected
      const ordStatusCode = cancelled ? '4' : '8';
      const outSeq = this.outboundSeqNum++;

      const execFields = {
        1: resolvedAccountId,
        11: norm.clOrdId || `CXL-${now}`,
        41: targetOrderId || 'UNKNOWN',
        37: cancelled?.id || targetOrderId || 'NONE',
        17: `EXEC-CXL-${now}-${outSeq}`,
        150: execTypeCode,
        39: ordStatusCode,
        55: cancelled?.symbol || symbol,
        54: (cancelled?.side || norm.side) === 'SELL' ? '2' : '1',
        38: cancelled?.size ?? norm.size ?? 0,
        44: cancelled?.price ?? norm.price ?? 0,
        32: 0,
        31: 0,
        151: 0,
        14: cancelled?.filledSize ?? cancelled?.filled_size ?? 0,
        6: 0,
        60: formatFixUtcTimestamp(now),
        58: cancelled ? 'ORDER_CANCELED_VIA_FIX_DMA' : `ORDER_NOT_FOUND:${targetOrderId}`
      };

      const executionReportFix = this.buildFixMessage('8', execFields, {
        senderCompId: inTarget,
        targetCompId: inSender,
        msgSeqNum: outSeq,
        delimiter
      });

      this._appendLog({
        timestamp: Date.now(),
        direction: 'OUTBOUND',
        msgType: '8',
        msgTypeName: 'ExecutionReport',
        senderCompId: inTarget,
        targetCompId: inSender,
        seqNum: outSeq,
        validChecksum: true,
        rawFix: executionReportFix,
        summary: `ExecutionReport (150=${execTypeCode} ${cancelled ? 'CANCELED' : 'REJECTED'} OrderID=${execFields[37]})`
      });

      return {
        success: Boolean(cancelled),
        validChecksum: parsed.validChecksum,
        expectedChecksum: parsed.expectedChecksum,
        providedChecksum: parsed.providedChecksum,
        msgType: 'F',
        inboundParsed: parsed,
        normalizedOrder: norm,
        execution: { cancelled, order: cancelled, fills: [] },
        order: cancelled,
        fills: [],
        executionReportFix,
        executionReport: executionReportFix,
        outboundFix: executionReportFix,
        executionReportParsed: this.parseFixMessage(executionReportFix),
        sessionLog: this.getSessionLog(25)
      };
    }

    // Handle 35=D (NewOrderSingle)
    const clOrdId = norm.clOrdId || `FIX-ORD-${now}-${this.inboundSeqNum}`;
    const symbol = norm.symbol || 'BTC-USD';
    const side = norm.side || 'BUY';
    const type = norm.type || (norm.price ? 'LIMIT' : 'MARKET');
    const size = Number(norm.size) > 0 ? Number(norm.size) : 1;
    const price = norm.price !== null && norm.price !== undefined ? Number(norm.price) : undefined;

    let executionResult;
    let rejectReason = null;

    try {
      executionResult = engine.submitOrder({
        id: clOrdId,
        accountId: resolvedAccountId,
        symbol,
        side,
        type,
        price,
        size,
        clientTag: `FIX-4.4-${inSender}`
      });
    } catch (err) {
      rejectReason = err.message || 'FIX_DMA_REJECTED';
      executionResult = {
        order: {
          id: clOrdId,
          accountId: resolvedAccountId,
          symbol,
          side,
          type,
          price: price || 0,
          size,
          filledSize: 0,
          remainingSize: 0,
          status: 'REJECTED'
        },
        fills: []
      };
    }

    const { order, fills = [] } = executionResult;
    const cumQty = Number(order.filledSize || 0);
    const leavesQty = Number(order.remainingSize ?? Math.max(0, size - cumQty));
    const lastFill = fills.length > 0 ? fills[fills.length - 1] : null;
    const lastShares = lastFill ? Number(lastFill.size) : 0;
    const lastPx = lastFill ? Number(lastFill.price) : Number(order.price || 0);

    let avgPx = 0;
    if (fills.length > 0 && cumQty > 0) {
      const totalNotional = fills.reduce((acc, f) => acc + f.price * f.size, 0);
      avgPx = Number((totalNotional / cumQty).toFixed(4));
    }

    let execTypeCode = '0'; // 0 = New
    let ordStatusCode = '0';
    if (rejectReason || order.status === 'REJECTED') {
      execTypeCode = '8';
      ordStatusCode = '8';
    } else if (order.status === 'FILLED') {
      execTypeCode = '2'; // 2 = Fill
      ordStatusCode = '2'; // 2 = Filled
    } else if (order.status === 'PARTIAL') {
      execTypeCode = '1'; // 1 = Partial fill
      ordStatusCode = '1'; // 1 = Partially filled
    } else if (order.status === 'CANCELLED') {
      execTypeCode = '4';
      ordStatusCode = '4';
    }

    const outSeq = this.outboundSeqNum++;
    const execReportFields = {
      1: resolvedAccountId,
      11: clOrdId,
      37: order.id,
      17: lastFill ? lastFill.id : `EXEC-${now}-${outSeq}`,
      150: execTypeCode,
      39: ordStatusCode,
      55: order.symbol,
      54: order.side === 'SELL' ? '2' : '1',
      40: order.type === 'MARKET' ? '1' : '2',
      38: order.size,
      44: order.price,
      32: lastShares,
      31: lastPx,
      151: leavesQty,
      14: cumQty,
      6: avgPx,
      60: formatFixUtcTimestamp(now),
      58: rejectReason || `DMA_${order.status}_FILLS_${fills.length}`
    };

    const executionReportFix = this.buildFixMessage('8', execReportFields, {
      senderCompId: inTarget,
      targetCompId: inSender,
      msgSeqNum: outSeq,
      delimiter
    });

    this._appendLog({
      timestamp: Date.now(),
      direction: 'OUTBOUND',
      msgType: '8',
      msgTypeName: 'ExecutionReport',
      senderCompId: inTarget,
      targetCompId: inSender,
      seqNum: outSeq,
      validChecksum: true,
      rawFix: executionReportFix,
      summary: `ExecutionReport (150=${EXEC_TYPE_MAP[execTypeCode]} 39=${ORD_STATUS_MAP[ordStatusCode]} CumQty=${cumQty} AvgPx=${avgPx})`
    });

    // Also generate the 40-byte SBE wire representation of this order for telemetry/inspectors
    const sbeBuffer = encodeSbeOrder({
      templateId: 101,
      seqNum: inSeq,
      orderIdNum: clOrdId,
      symbol: order.symbol,
      side: order.side === 'SELL' ? 2 : 1,
      ordType: order.type === 'MARKET' ? 1 : 2,
      price: order.price || lastPx || 0,
      size: order.size
    });

    return {
      success: !rejectReason,
      error: rejectReason,
      validChecksum: parsed.validChecksum,
      expectedChecksum: parsed.expectedChecksum,
      providedChecksum: parsed.providedChecksum,
      msgType: 'D',
      inboundParsed: parsed,
      normalizedOrder: norm,
      execution: executionResult,
      order,
      fills,
      executionReportFix,
      executionReport: executionReportFix,
      outboundFix: executionReportFix,
      executionReportParsed: this.parseFixMessage(executionReportFix),
      sbeWireHex: sbeBuffer.toString('hex').toUpperCase(),
      sbeDecoded: decodeSbeOrder(sbeBuffer),
      sessionLog: this.getSessionLog(25)
    };
  }

  encodeSbeOrder(params) {
    return encodeSbeOrder(params);
  }

  decodeSbeOrder(buffer) {
    return decodeSbeOrder(buffer);
  }

  _appendLog(entry) {
    this.sessionLog.unshift({
      id: `FIX-LOG-${Date.now()}-${this.sessionLog.length + 1}`,
      ...entry
    });
    if (this.sessionLog.length > 60) {
      this.sessionLog.pop();
    }
  }

  getSessionLog(limit = 25) {
    return this.sessionLog.slice(0, limit);
  }
}

const defaultFixEngine = new FixProtocolEngine();

module.exports = {
  FixProtocolEngine,
  defaultFixEngine,
  computeFixChecksum,
  formatFixUtcTimestamp,
  buildFixMessage: (msgType, fields, opts) => defaultFixEngine.buildFixMessage(msgType, fields, opts),
  parseFixMessage: (rawFixStr) => defaultFixEngine.parseFixMessage(rawFixStr),
  executeFixOrder: (rawFixStr, matchingEngine, accountId) =>
    defaultFixEngine.executeFixOrder(rawFixStr, matchingEngine, accountId),
  encodeSbeOrder,
  decodeSbeOrder,
  getSessionLog: (limit) => defaultFixEngine.getSessionLog(limit),
  SYMBOL_TO_ID,
  ID_TO_SYMBOL,
  FIX_TAG_NAMES,
  FIX_MSG_TYPE_NAMES,
  SBE_FRAME_BYTES
};
