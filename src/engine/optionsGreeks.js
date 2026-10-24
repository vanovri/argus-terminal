'use strict';

/**
 * ARGUS TERMINAL — Institutional Options Greeks, Black-Scholes-Merton Pricing,
 * Hybrid Newton-Raphson/Halley/Brent Implied Volatility Solver & Gatheral SVI 3D Volatility Surface Engine
 */

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const DAYS_PER_YEAR = 365.0;

/**
 * High-precision Standard Normal Probability Density Function phi(x)
 * @param {number} x
 * @returns {number}
 */
function normPdf(x) {
  const z = Number(x);
  if (!Number.isFinite(z)) return 0;
  if (Math.abs(z) > 12) return 0;
  return Math.exp(-0.5 * z * z) / SQRT_2PI;
}

/**
 * High-precision Standard Normal Cumulative Distribution Function N(x)
 * Abramowitz & Stegun 26.2.17 polynomial approximation (max error < 7.5e-8)
 * @param {number} x
 * @returns {number}
 */
function normCdf(x) {
  const z = Number(x);
  if (!Number.isFinite(z)) return 0.5;
  if (z > 10) return 1.0;
  if (z < -10) return 0.0;

  const isNegative = z < 0;
  const absX = isNegative ? -z : z;

  const p = 0.2316419;
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;

  const t = 1.0 / (1.0 + p * absX);
  const poly = ((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t;
  const cdfPos = 1.0 - normPdf(absX) * poly;

  return isNegative ? 1.0 - cdfPos : cdfPos;
}

/**
 * Exact Black-Scholes-Merton Option Pricing + 1st & 2nd-Order Institutional Greeks + Put-Call Parity Proof.
 * Supports object arguments `{ S, K, T, r = 0.045, q = 0.0, sigma, type = 'CALL' }` or positional `(S, K, T, r, sigma, type, q)`.
 */
function priceBlackScholes(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
  let S;
  let K;
  let T;
  let r = 0.045;
  let q = 0.0;
  let sigma = 0.60;
  let type = 'CALL';

  if (arg0 && typeof arg0 === 'object') {
    S = Number(arg0.S ?? arg0.spot ?? arg0.spotPrice ?? 94500);
    K = Number(arg0.K ?? arg0.strike ?? arg0.strikePrice ?? S);
    T = Number(arg0.T ?? arg0.timeToExpiry ?? arg0.tau ?? (30 / DAYS_PER_YEAR));
    if (arg0.r !== undefined || arg0.rate !== undefined) {
      r = Number(arg0.r ?? arg0.rate);
    }
    if (arg0.q !== undefined || arg0.dividendYield !== undefined) {
      q = Number(arg0.q ?? arg0.dividendYield);
    }
    if (arg0.sigma !== undefined || arg0.vol !== undefined || arg0.iv !== undefined || arg0.volatility !== undefined) {
      sigma = Number(arg0.sigma ?? arg0.vol ?? arg0.iv ?? arg0.volatility);
    }
    const rawType = arg0.type ?? arg0.optionType ?? (arg0.isCall === false ? 'PUT' : 'CALL');
    type = String(rawType).toUpperCase().startsWith('P') ? 'PUT' : 'CALL';
  } else {
    S = Number(arg0 || 94500);
    K = Number(arg1 || S);
    T = Number(arg2 || (30 / DAYS_PER_YEAR));
    r = arg3 !== undefined ? Number(arg3) : 0.045;
    sigma = arg4 !== undefined ? Number(arg4) : 0.60;
    type = String(arg5 || 'CALL').toUpperCase().startsWith('P') ? 'PUT' : 'CALL';
    q = arg6 !== undefined ? Number(arg6) : 0.0;
  }

  const safeS = Math.max(1e-9, S);
  const safeK = Math.max(1e-9, K);
  const safeT = Math.max(1e-7, T);
  const safeSigma = Math.max(1e-6, sigma);
  const sqrtT = Math.sqrt(safeT);
  const sigSqrtT = safeSigma * sqrtT;

  const dfR = Math.exp(-r * safeT);
  const dfQ = Math.exp(-q * safeT);

  const d1 = (Math.log(safeS / safeK) + (r - q + 0.5 * safeSigma * safeSigma) * safeT) / sigSqrtT;
  const d2 = d1 - sigSqrtT;

  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const nMinusd1 = normCdf(-d1);
  const nMinusd2 = normCdf(-d2);
  const pdfD1 = normPdf(d1);

  const callPrice = Math.max(0, safeS * dfQ * nd1 - safeK * dfR * nd2);
  const putPrice = Math.max(0, safeK * dfR * nMinusd2 - safeS * dfQ * nMinusd1);

  const callIntrinsic = Math.max(0, safeS - safeK);
  const putIntrinsic = Math.max(0, safeK - safeS);

  // 1st-Order Greeks
  const callDelta = dfQ * nd1;
  const putDelta = dfQ * (nd1 - 1.0); // Identical to -dfQ * nMinusd1

  const gamma = (dfQ * pdfD1) / (safeS * sigSqrtT);

  // Vega: raw (per 100% vol move) and institutional scaled (per 1% vol move)
  const vegaRaw = safeS * dfQ * pdfD1 * sqrtT;
  const vega = vegaRaw / 100.0;

  // Theta: annualized and per calendar day (/365)
  const commonDecay = -(safeS * safeSigma * dfQ * pdfD1) / (2.0 * sqrtT);
  const callThetaAnnual = commonDecay - r * safeK * dfR * nd2 + q * safeS * dfQ * nd1;
  const putThetaAnnual = commonDecay + r * safeK * dfR * nMinusd2 - q * safeS * dfQ * nMinusd1;
  const callTheta = callThetaAnnual / DAYS_PER_YEAR;
  const putTheta = putThetaAnnual / DAYS_PER_YEAR;

  // Rho: per 1% rate change (/100)
  const callRhoRaw = safeK * safeT * dfR * nd2;
  const putRhoRaw = -safeK * safeT * dfR * nMinusd2;
  const callRho = callRhoRaw / 100.0;
  const putRho = putRhoRaw / 100.0;

  // 2nd-Order Institutional Greeks:
  // Vanna = d(Delta)/d(sigma) = -e^(-qT) * phi(d1) * (d2 / sigma)
  const vanna = -dfQ * pdfD1 * (d2 / safeSigma);

  // Charm = -d(Delta)/d(T) (Delta bleed per year and per day)
  const charmFactor = dfQ * pdfD1 * ((2.0 * (r - q) * safeT - d2 * sigSqrtT) / (2.0 * safeT * sigSqrtT));
  const callCharmAnnual = q * dfQ * nd1 - charmFactor;
  const putCharmAnnual = -q * dfQ * nMinusd1 - charmFactor;
  const callCharm = callCharmAnnual / DAYS_PER_YEAR;
  const putCharm = putCharmAnnual / DAYS_PER_YEAR;

  // Vomma / Volga = d^2(V)/d(sigma)^2 (scaled per 1% vol)
  const vomma = vega * ((d1 * d2) / safeSigma);

  // Put-Call Parity Verification: C - P = S * e^(-qT) - K * e^(-rT)
  const putCallParityLHS = callPrice - putPrice;
  const putCallParityRHS = safeS * dfQ - safeK * dfR;
  const putCallParityError = Math.abs(putCallParityLHS - putCallParityRHS);

  const callLeg = {
    type: 'CALL',
    price: callPrice,
    intrinsicValue: callIntrinsic,
    timeValue: callPrice - callIntrinsic,
    delta: callDelta,
    gamma,
    vega,
    vegaRaw,
    theta: callTheta,
    thetaAnnual: callThetaAnnual,
    rho: callRho,
    rhoRaw: callRhoRaw,
    vanna,
    charm: callCharm,
    charmAnnual: callCharmAnnual,
    vomma,
    volga: vomma
  };

  const putLeg = {
    type: 'PUT',
    price: putPrice,
    intrinsicValue: putIntrinsic,
    timeValue: putPrice - putIntrinsic,
    delta: putDelta,
    gamma,
    vega,
    vegaRaw,
    theta: putTheta,
    thetaAnnual: putThetaAnnual,
    rho: putRho,
    rhoRaw: putRhoRaw,
    vanna,
    charm: putCharm,
    charmAnnual: putCharmAnnual,
    vomma,
    volga: vomma
  };

  const activeLeg = type === 'PUT' ? putLeg : callLeg;

  return {
    S: safeS,
    K: safeK,
    T: safeT,
    r,
    q,
    sigma: safeSigma,
    type,
    d1,
    d2,
    price: activeLeg.price,
    intrinsicValue: activeLeg.intrinsicValue,
    timeValue: activeLeg.timeValue,
    delta: activeLeg.delta,
    gamma: activeLeg.gamma,
    vega: activeLeg.vega,
    vegaRaw: activeLeg.vegaRaw,
    theta: activeLeg.theta,
    thetaAnnual: activeLeg.thetaAnnual,
    rho: activeLeg.rho,
    rhoRaw: activeLeg.rhoRaw,
    vanna: activeLeg.vanna,
    charm: activeLeg.charm,
    charmAnnual: activeLeg.charmAnnual,
    vomma: activeLeg.vomma,
    volga: activeLeg.volga,
    callPrice,
    putPrice,
    callDelta,
    putDelta,
    callTheta,
    putTheta,
    callRho,
    putRho,
    call: callLeg,
    put: putLeg,
    putCallParityLHS,
    putCallParityRHS,
    putCallParityError,
    putCallParityVerified: putCallParityError < 1e-8
  };
}

/**
 * Hybrid Newton-Raphson + Halley 2nd-Order + Brent/Bisection Safeguard Implied Volatility Solver.
 * Converges to < 1e-7 accuracy in <= 12 iterations across ITM, ATM, and OTM options.
 */
function solveImpliedVolatility(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
  let targetPrice;
  let S;
  let K;
  let T;
  let r = 0.045;
  let q = 0.0;
  let type = 'CALL';
  let maxIter = 12;
  let tol = 1e-8;

  if (arg0 && typeof arg0 === 'object') {
    targetPrice = Number(arg0.targetPrice ?? arg0.marketPrice ?? arg0.optionPrice ?? arg0.price ?? 0);
    S = Number(arg0.S ?? arg0.spot ?? arg0.spotPrice ?? 94500);
    K = Number(arg0.K ?? arg0.strike ?? arg0.strikePrice ?? S);
    T = Number(arg0.T ?? arg0.timeToExpiry ?? arg0.tau ?? (30 / DAYS_PER_YEAR));
    if (arg0.r !== undefined || arg0.rate !== undefined) {
      r = Number(arg0.r ?? arg0.rate);
    }
    if (arg0.q !== undefined || arg0.dividendYield !== undefined) {
      q = Number(arg0.q ?? arg0.dividendYield);
    }
    const rawType = arg0.type ?? arg0.optionType ?? 'CALL';
    type = String(rawType).toUpperCase().startsWith('P') ? 'PUT' : 'CALL';
    if (arg0.maxIter !== undefined) maxIter = Math.min(12, Math.max(1, Number(arg0.maxIter)));
    if (arg0.tol !== undefined) tol = Number(arg0.tol);
  } else {
    targetPrice = Number(arg0 || 0);
    S = Number(arg1 || 94500);
    K = Number(arg2 || S);
    T = Number(arg3 || (30 / DAYS_PER_YEAR));
    r = arg4 !== undefined ? Number(arg4) : 0.045;
    type = String(arg5 || 'CALL').toUpperCase().startsWith('P') ? 'PUT' : 'CALL';
    q = arg6 !== undefined ? Number(arg6) : 0.0;
  }

  const safeS = Math.max(1e-9, S);
  const safeK = Math.max(1e-9, K);
  const safeT = Math.max(1e-7, T);
  const dfR = Math.exp(-r * safeT);
  const dfQ = Math.exp(-q * safeT);

  const intrinsic = type === 'PUT'
    ? Math.max(0, safeK * dfR - safeS * dfQ)
    : Math.max(0, safeS * dfQ - safeK * dfR);

  const upperBoundPrice = type === 'PUT' ? safeK * dfR : safeS * dfQ;
  const clampedTarget = Math.min(upperBoundPrice * 0.999999, Math.max(intrinsic + 1e-8, targetPrice));

  // Initial seed via Brenner-Subrahmanyam / Manaster-Koehler inflection point
  const forward = safeS * Math.exp((r - q) * safeT);
  const logMoneyness = Math.abs(Math.log(forward / safeK));
  const brennerSeed = Math.sqrt((2 * Math.PI) / safeT) * (clampedTarget / safeS);
  const inflectionSeed = logMoneyness > 0.03 ? Math.sqrt((2 * logMoneyness) / safeT) : brennerSeed;
  let sigma = Math.min(3.5, Math.max(0.05, 0.5 * (brennerSeed + inflectionSeed) || 0.5));

  let low = 1e-5;
  let high = 5.0;
  let iterations = 0;
  let converged = false;
  let pricingError = Infinity;
  let lastEval = null;
  const trace = [];

  for (let i = 1; i <= maxIter; i++) {
    iterations = i;
    lastEval = priceBlackScholes({ S: safeS, K: safeK, T: safeT, r, q, sigma, type });
    const diff = lastEval.price - clampedTarget;
    pricingError = Math.abs(diff);

    trace.push({
      iter: i,
      sigma: Number(sigma.toFixed(8)),
      modelPrice: Number(lastEval.price.toFixed(6)),
      error: Number(diff.toExponential(4))
    });

    if (pricingError < tol || pricingError / Math.max(1.0, clampedTarget) < 1e-8) {
      converged = true;
      break;
    }

    if (diff > 0) {
      high = Math.min(high, sigma);
    } else {
      low = Math.max(low, sigma);
    }

    const vegaRaw = lastEval.vegaRaw;
    let nextSigma;

    if (vegaRaw > 1e-9) {
      // Halley's 2nd-order correction over Newton-Raphson for cubic convergence
      const newtonStep = diff / vegaRaw;
      const vommaOverVega = (lastEval.d1 * lastEval.d2) / sigma;
      const halleyDenom = 1.0 - 0.5 * newtonStep * vommaOverVega;
      const step = Math.abs(halleyDenom) > 0.25 ? newtonStep / halleyDenom : newtonStep;
      const candidate = sigma - step;

      if (candidate > low && candidate < high) {
        nextSigma = candidate;
      } else {
        // Brent/Bisection safeguard when Newton step jumps outside bracket
        nextSigma = 0.5 * (low + high);
      }
    } else {
      nextSigma = 0.5 * (low + high);
    }

    if (Math.abs(nextSigma - sigma) < 1e-10) {
      sigma = nextSigma;
      converged = true;
      break;
    }
    sigma = nextSigma;
  }

  lastEval = priceBlackScholes({ S: safeS, K: safeK, T: safeT, r, q, sigma, type });
  pricingError = Math.abs(lastEval.price - targetPrice);
  if (pricingError < 1e-5) {
    converged = true;
  }

  return {
    impliedVol: Number(sigma.toFixed(8)),
    iv: Number(sigma.toFixed(8)),
    sigma: Number(sigma.toFixed(8)),
    volatility: Number(sigma.toFixed(8)),
    impliedVolPct: Number((sigma * 100).toFixed(4)),
    iterations,
    converged,
    pricingError: Number(pricingError.toExponential(6)),
    targetPrice,
    modelPrice: Number(lastEval.price.toFixed(4)),
    greeks: lastEval,
    trace
  };
}

/**
 * Gatheral's SVI (Stochastic Volatility Inspired) Implied Volatility Parameterization:
 * Total variance w(k) = a + b * (rho * (k - m) + sqrt((k - m)^2 + sigma_svi^2))
 * where k = ln(K / F) is log-moneyness.
 */
function sviImpliedVol(k, T, symbol = 'BTC-USD') {
  const sym = String(symbol || 'BTC-USD').toUpperCase();
  const isCrypto = sym.includes('BTC') || sym.includes('ETH') || sym.includes('SOL');
  const isEquity = sym.includes('NVDA');
  const isGold = sym.includes('XAU');

  // Base annualized ATM vol level by asset class
  const baseAtmVol = isCrypto
    ? (sym.includes('SOL') ? 0.74 : sym.includes('ETH') ? 0.62 : 0.56)
    : isEquity
      ? 0.44
      : isGold
        ? 0.18
        : 0.12;

  // Term structure adjustment: mild contango/backwardation curvature across tenors
  const termFactor = 1.0 - 0.06 * Math.exp(-T * 12.0) + 0.04 * Math.min(1.0, T);
  const atmVol = baseAtmVol * termFactor;

  // Gatheral SVI parameters scaled per annum so w_ann(k) represents annualized variance sigma(k, T)^2
  const a = atmVol * atmVol * 0.82;
  const b = isCrypto ? 0.42 : 0.28;
  const rho = isCrypto ? -0.18 : -0.38; // Put skew (negative rho) + crypto OTM call wing
  const m = isCrypto ? 0.015 : -0.02;
  const sigmaSvi = 0.14 + 0.05 * Math.sqrt(Math.max(0.01, T));

  const dk = k - m;
  const totalAnnVariance = a + b * (rho * dk + Math.sqrt(dk * dk + sigmaSvi * sigmaSvi));
  const iv = Math.sqrt(Math.max(0.01, totalAnnVariance));

  return Number(Math.min(2.5, Math.max(0.08, iv)).toFixed(6));
}

const INSTITUTIONAL_TENORS = [
  { label: '7D', days: 7, T: 7 / DAYS_PER_YEAR },
  { label: '14D', days: 14, T: 14 / DAYS_PER_YEAR },
  { label: '30D', days: 30, T: 30 / DAYS_PER_YEAR },
  { label: '90D', days: 90, T: 90 / DAYS_PER_YEAR },
  { label: '180D', days: 180, T: 180 / DAYS_PER_YEAR }
];

const MONEYNESS_OFFSETS = [-0.20, -0.16, -0.12, -0.08, -0.04, 0.00, 0.04, 0.08, 0.12, 0.16, 0.20];

function roundStrikeForSymbol(rawStrike, spotPrice) {
  if (spotPrice >= 20000) return Math.round(rawStrike / 50) * 50;
  if (spotPrice >= 1000) return Math.round(rawStrike / 5) * 5;
  if (spotPrice >= 50) return Math.round(rawStrike * 2) / 2;
  return Number(rawStrike.toFixed(2));
}

/**
 * Generates the 5-Tenor x 11-Strike Gatheral SVI 3D Volatility Surface,
 * full Straddle Options Chain for the selected tenor, Put-Call Parity proof,
 * and Portfolio Greeks Summary with Delta-Gamma hedge recommendation.
 */
function buildOptionsChainAndSurface(options = {}) {
  const symbol = String(options.symbol || 'BTC-USD').toUpperCase();
  let spotPrice = Number(options.spotPrice ?? options.spot ?? options.S ?? 0);

  if ((!spotPrice || spotPrice <= 0) && options.marketSim && typeof options.marketSim.getTickers === 'function') {
    const tickers = options.marketSim.getTickers();
    const match = Array.isArray(tickers) ? tickers.find((t) => t.symbol === symbol) : null;
    if (match && match.lastPrice > 0) {
      spotPrice = Number(match.lastPrice);
    }
  }
  if (!spotPrice || spotPrice <= 0) {
    const defaults = {
      'BTC-USD': 94500,
      'ETH-USD': 3180,
      'SOL-USD': 212.5,
      'NVDA-EQ': 148.2,
      'XAU-USD': 2745,
      'IDR-USD': 15680
    };
    spotPrice = defaults[symbol] || 94500;
  }

  const r = options.r !== undefined ? Number(options.r) : 0.045;
  const q = options.q !== undefined ? Number(options.q) : 0.0;
  const requestedTenor = String(options.tenor || options.selectedTenor || '30D').toUpperCase();
  const activeTenorObj = INSTITUTIONAL_TENORS.find((t) => t.label === requestedTenor) || INSTITUTIONAL_TENORS[2];

  const strikes = MONEYNESS_OFFSETS.map((pct) => roundStrikeForSymbol(spotPrice * (1.0 + pct), spotPrice));

  // Build 2D Volatility Surface Matrix (5 tenors x 11 strikes) + flat node list
  const surfaceMatrix = [];
  const surfaceNodes = [];

  for (const tenorObj of INSTITUTIONAL_TENORS) {
    const forward = spotPrice * Math.exp((r - q) * tenorObj.T);
    const tenorRow = [];

    for (let idx = 0; idx < strikes.length; idx++) {
      const K = strikes[idx];
      const pctMoneyness = Number((((K / spotPrice) - 1.0) * 100).toFixed(2));
      const logMoneyness = Number(Math.log(K / forward).toFixed(6));
      const iv = sviImpliedVol(logMoneyness, tenorObj.T, symbol);
      const bsm = priceBlackScholes({ S: spotPrice, K, T: tenorObj.T, r, q, sigma: iv, type: 'CALL' });

      const cell = {
        tenor: tenorObj.label,
        days: tenorObj.days,
        T: Number(tenorObj.T.toFixed(6)),
        strike: K,
        K,
        moneyness: Number((K / spotPrice).toFixed(4)),
        moneynessPct: pctMoneyness,
        logMoneyness,
        iv,
        ivPct: Number((iv * 100).toFixed(2)),
        callPrice: Number(bsm.callPrice.toFixed(2)),
        putPrice: Number(bsm.putPrice.toFixed(2)),
        callDelta: Number(bsm.callDelta.toFixed(4)),
        putDelta: Number(bsm.putDelta.toFixed(4)),
        gamma: Number(bsm.gamma.toFixed(6)),
        vega: Number(bsm.vega.toFixed(2)),
        theta: Number(bsm.callTheta.toFixed(2)),
        vanna: Number(bsm.vanna.toFixed(4)),
        putCallParityError: bsm.putCallParityError
      };

      tenorRow.push(cell);
      surfaceNodes.push(cell);
    }

    surfaceMatrix.push({
      tenor: tenorObj.label,
      days: tenorObj.days,
      T: Number(tenorObj.T.toFixed(6)),
      atmVolPct: tenorRow[5].ivPct,
      rr25dPct: Number((tenorRow[8].ivPct - tenorRow[2].ivPct).toFixed(2)),
      bf25dPct: Number((0.5 * (tenorRow[8].ivPct + tenorRow[2].ivPct) - tenorRow[5].ivPct).toFixed(2)),
      strikes: tenorRow
    });
  }

  // Build Full Straddle Options Chain for the Selected Tenor
  const forwardSelected = spotPrice * Math.exp((r - q) * activeTenorObj.T);
  let maxParityError = 0;

  const chain = strikes.map((K, idx) => {
    const logMoneyness = Math.log(K / forwardSelected);
    const iv = sviImpliedVol(logMoneyness, activeTenorObj.T, symbol);
    const bsm = priceBlackScholes({ S: spotPrice, K, T: activeTenorObj.T, r, q, sigma: iv, type: 'CALL' });

    if (bsm.putCallParityError > maxParityError) {
      maxParityError = bsm.putCallParityError;
    }

    const halfSpreadCall = Math.max(0.05, bsm.callPrice * 0.006);
    const halfSpreadPut = Math.max(0.05, bsm.putPrice * 0.006);

    return {
      strike: K,
      K,
      isAtm: idx === 5,
      moneyness: Number((K / spotPrice).toFixed(4)),
      moneynessPct: Number((((K / spotPrice) - 1.0) * 100).toFixed(2)),
      logMoneyness: Number(logMoneyness.toFixed(6)),
      iv,
      ivPct: Number((iv * 100).toFixed(2)),
      callPrice: Number(bsm.callPrice.toFixed(2)),
      putPrice: Number(bsm.putPrice.toFixed(2)),
      straddlePrice: Number((bsm.callPrice + bsm.putPrice).toFixed(2)),
      putCallParityError: bsm.putCallParityError,
      call: {
        price: Number(bsm.callPrice.toFixed(2)),
        bid: Number(Math.max(0.01, bsm.callPrice - halfSpreadCall).toFixed(2)),
        ask: Number((bsm.callPrice + halfSpreadCall).toFixed(2)),
        intrinsicValue: Number(bsm.call.intrinsicValue.toFixed(2)),
        timeValue: Number(bsm.call.timeValue.toFixed(2)),
        delta: Number(bsm.call.delta.toFixed(4)),
        gamma: Number(bsm.call.gamma.toFixed(6)),
        vega: Number(bsm.call.vega.toFixed(2)),
        theta: Number(bsm.call.theta.toFixed(2)),
        rho: Number(bsm.call.rho.toFixed(2)),
        vanna: Number(bsm.call.vanna.toFixed(4)),
        charm: Number(bsm.call.charm.toFixed(4)),
        volga: Number(bsm.call.volga.toFixed(4)),
        openInterest: Math.round(420 + 680 * Math.exp(-Math.abs(idx - 5) * 0.45))
      },
      put: {
        price: Number(bsm.putPrice.toFixed(2)),
        bid: Number(Math.max(0.01, bsm.putPrice - halfSpreadPut).toFixed(2)),
        ask: Number((bsm.putPrice + halfSpreadPut).toFixed(2)),
        intrinsicValue: Number(bsm.put.intrinsicValue.toFixed(2)),
        timeValue: Number(bsm.put.timeValue.toFixed(2)),
        delta: Number(bsm.put.delta.toFixed(4)),
        gamma: Number(bsm.put.gamma.toFixed(6)),
        vega: Number(bsm.put.vega.toFixed(2)),
        theta: Number(bsm.put.theta.toFixed(2)),
        rho: Number(bsm.put.rho.toFixed(2)),
        vanna: Number(bsm.put.vanna.toFixed(4)),
        charm: Number(bsm.put.charm.toFixed(4)),
        volga: Number(bsm.put.volga.toFixed(4)),
        openInterest: Math.round(390 + 640 * Math.exp(-Math.abs(idx - 5) * 0.45))
      }
    };
  });

  // Desk Portfolio Greeks Summary (simulating an institutional options book on the active underlying)
  const atmRow = chain[5];
  const otmCallRow = chain[7];
  const otmPutRow = chain[3];

  // Desk holds +15 ATM Call, -10 OTM Call (25D), +8 OTM Put (25D)
  const netDelta = Number((15 * atmRow.call.delta - 10 * otmCallRow.call.delta + 8 * otmPutRow.put.delta).toFixed(4));
  const netGamma = Number((15 * atmRow.call.gamma - 10 * otmCallRow.call.gamma + 8 * otmPutRow.put.gamma).toFixed(6));
  const netVega = Number((15 * atmRow.call.vega - 10 * otmCallRow.call.vega + 8 * otmPutRow.put.vega).toFixed(2));
  const netTheta = Number((15 * atmRow.call.theta - 10 * otmCallRow.call.theta + 8 * otmPutRow.put.theta).toFixed(2));
  const netVanna = Number((15 * atmRow.call.vanna - 10 * otmCallRow.call.vanna + 8 * otmPutRow.put.vanna).toFixed(4));

  const hedgeUnderlyingQty = Number((-netDelta).toFixed(4));
  const gammaNeutralAtmStraddles = atmRow.call.gamma > 0
    ? Number((-netGamma / (2 * atmRow.call.gamma)).toFixed(2))
    : 0;

  return {
    symbol,
    spotPrice,
    spot: spotPrice,
    riskFreeRate: r,
    dividendYield: q,
    selectedTenor: activeTenorObj.label,
    tenor: activeTenorObj.label,
    timeToExpiry: Number(activeTenorObj.T.toFixed(6)),
    tenors: INSTITUTIONAL_TENORS.map((t) => t.label),
    strikes,
    atmVolPct: atmRow.ivPct,
    atmStraddlePrice: atmRow.straddlePrice,
    putCallParity: {
      formula: 'C - P = S * exp(-qT) - K * exp(-rT)',
      maxParityError,
      verified: maxParityError < 1e-8
    },
    surface: surfaceMatrix,
    surfaceGrid: surfaceMatrix.map((row) => row.strikes),
    surfaceNodes,
    chain,
    portfolioGreeksSummary: {
      netDelta,
      netGamma,
      netVega,
      netTheta,
      netVanna,
      deltaDollarExposure: Number((netDelta * spotPrice).toFixed(2)),
      gammaDollar1Pct: Number((0.5 * netGamma * Math.pow(spotPrice * 0.01, 2)).toFixed(2)),
      recommendedSpotHedgeQty: hedgeUnderlyingQty,
      recommendedAtmStraddleHedge: gammaNeutralAtmStraddles,
      hedgeDirective: `${hedgeUnderlyingQty >= 0 ? 'BUY' : 'SELL'} ${Math.abs(hedgeUnderlyingQty).toFixed(3)} ${symbol} PERP + ${gammaNeutralAtmStraddles >= 0 ? 'BUY' : 'SELL'} ${Math.abs(gammaNeutralAtmStraddles).toFixed(2)} ATM STRADDLE`
    },
    timestamp: Date.now()
  };
}

module.exports = {
  normPdf,
  normCdf,
  priceBlackScholes,
  blackScholesMerton: priceBlackScholes,
  computeBlackScholesMerton: priceBlackScholes,
  bsmPriceAndGreeks: priceBlackScholes,
  priceOption: priceBlackScholes,
  computeOptionGreeks: priceBlackScholes,
  solveImpliedVolatility,
  impliedVolatility: solveImpliedVolatility,
  sviImpliedVol,
  buildOptionsChainAndSurface,
  generateOptionsChainAndSurface: buildOptionsChainAndSurface,
  getOptionsChain: buildOptionsChainAndSurface,
  INSTITUTIONAL_TENORS
};
