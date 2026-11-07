'use strict';

/**
 * Shared validation, finite-number contract enforcement, and structured diagnostics
 * for Argus Terminal engines, database, and server modules.
 */

/**
 * Checks whether a value is a finite number and explicitly NOT a boolean.
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') {
    return false;
  }
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num);
}

/**
 * Asserts that `value` is a finite number (rejecting booleans, NaN, Infinity, null, empty strings).
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {number}
 */
function assertFiniteNumber(value, fieldName = 'value') {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') {
    throw new RangeError(`Invalid ${fieldName}: must be a finite number`);
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new RangeError(`Invalid ${fieldName}: must be a finite number`);
  }
  return num;
}

/**
 * Asserts that `value` is a strictly positive finite number (> 0).
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {number}
 */
function assertPositiveFinite(value, fieldName = 'value') {
  const num = assertFiniteNumber(value, fieldName);
  if (num <= 0) {
    throw new RangeError(`Invalid ${fieldName}: must be a positive finite number (> 0)`);
  }
  return num;
}

/**
 * Asserts that `value` is a non-negative finite number (>= 0).
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {number}
 */
function assertNonNegativeFinite(value, fieldName = 'value') {
  const num = assertFiniteNumber(value, fieldName);
  if (num < 0) {
    throw new RangeError(`Invalid ${fieldName}: must be a non-negative finite number (>= 0)`);
  }
  return num;
}

/**
 * Structured lightweight diagnostic logger that suppresses noisy stack traces during unit tests
 * unless ARGUS_DEBUG=1 is set, while recording structured error diagnostics.
 */
const recentDiagnostics = [];
const MAX_DIAGNOSTICS = 100;

/**
 * @param {string} component
 * @param {string} event
 * @param {unknown} [err]
 */
function logDiagnostic(component, event, err = null) {
  const message = err instanceof Error ? err.message : err !== null ? String(err) : '';
  const entry = {
    timestamp: Date.now(),
    component,
    event,
    message
  };
  recentDiagnostics.push(entry);
  if (recentDiagnostics.length > MAX_DIAGNOSTICS) {
    recentDiagnostics.shift();
  }
  if (process.env.ARGUS_DEBUG === '1') {
    process.stderr.write(`[ARGUS:${component}] ${event}${message ? ': ' + message : ''}\n`);
  }
  return entry;
}

/**
 * @returns {Array<{ timestamp: number, component: string, event: string, message: string }>}
 */
function getRecentDiagnostics() {
  return recentDiagnostics.slice();
}

module.exports = {
  isFiniteNumber,
  assertFiniteNumber,
  assertPositiveFinite,
  assertNonNegativeFinite,
  logDiagnostic,
  getRecentDiagnostics
};
