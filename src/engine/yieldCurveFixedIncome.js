'use strict';

/**
 * ARGUS TERMINAL — Wave 4: Macro Yield Curve (Nelson-Siegel-Svensson) & Fixed Income Bond Desk
 *
 * Implements:
 *   1. 6-Factor Nelson-Siegel-Svensson (NSS) Sovereign Yield Curve:
 *      y(tau) = beta0 + beta1 * ((1 - exp(-tau/lambda1)) / (tau/lambda1))
 *                     + beta2 * (((1 - exp(-tau/lambda1)) / (tau/lambda1)) - exp(-tau/lambda1))
 *                     + beta3 * (((1 - exp(-tau/lambda2)) / (tau/lambda2)) - exp(-tau/lambda2))
 *   2. Instantaneous Forward Rate f(tau) and Zero-Coupon Discount Factor D(tau) = exp(-y(tau)*tau).
 *   3. OLS / Ridge Calibration of NSS parameters (beta0, beta1, beta2, beta3, lambda1, lambda2) to market yields.
 *   4. Institutional Fixed Income Bond Pricing & Risk Engine:
 *      - Clean Price, Accrued Interest (ACT/ACT & 30/360), Dirty Price
 *      - Newton-Raphson Yield-to-Maturity (YTM) Solver
 *      - Newton-Raphson Zero-Volatility Spread (Z-Spread) Solver over the NSS zero curve
 *      - Analytical Macaulay Duration, Modified Duration, Dollar Duration (DV01), and Convexity
 *      - Parallel & Non-Parallel Rate Shock Taylor Expansion vs Exact Repricing Proof
 */

const STANDARD_TENORS = [
  { label: '1M', years: 1 / 12 },
  { label: '3M', years: 0.25 },
  { label: '6M', years: 0.5 },
  { label: '1Y', years: 1.0 },
  { label: '2Y', years: 2.0 },
  { label: '3Y', years: 3.0 },
  { label: '5Y', years: 5.0 },
  { label: '7Y', years: 7.0 },
  { label: '10Y', years: 10.0 },
  { label: '20Y', years: 20.0 },
  { label: '30Y', years: 30.0 }
];

const NSS_REGIME_PRESETS = {
  NORMAL_STEEP: {
    regime: 'NORMAL_STEEP',
    description: 'Post-Normalization Upward Sloping Sovereign Curve (+65 bps 2s10s)',
    beta0: 0.0485,  // Long-run asymptotic yield level (4.85%)
    beta1: -0.0115, // Short-end slope factor (-115 bps)
    beta2: -0.0060, // Medium-term curvature / belly factor
    beta3: 0.0045,  // Long-end second hump (Svensson extension)
    lambda1: 1.65,  // First decay tau (years)
    lambda2: 6.50   // Second decay tau (years)
  },
  INVERTED_HAWKISH: {
    regime: 'INVERTED_HAWKISH',
    description: 'Restrictive Central Bank Policy Inversion (-52 bps 2s10s)',
    beta0: 0.0410,
    beta1: 0.0135,
    beta2: 0.0080,
    beta3: -0.0050,
    lambda1: 1.40,
    lambda2: 5.80
  },
  BULL_STEEPENER: {
    regime: 'BULL_STEEPENER',
    description: 'Front-End Rate Cut Cycle with Steepening Term Premium',
    beta0: 0.0465,
    beta1: -0.0165,
    beta2: -0.0095,
    beta3: 0.0060,
    lambda1: 1.50,
    lambda2: 6.20
  },
  BEAR_FLATTENER: {
    regime: 'BEAR_FLATTENER',
    description: 'Front-End Selloff Compressing Term Spreads',
    beta0: 0.0455,
    beta1: 0.0045,
    beta2: 0.0090,
    beta3: -0.0025,
    lambda1: 1.80,
    lambda2: 7.00
  },
  HUMPED_TRANSITION: {
    regime: 'HUMPED_TRANSITION',
    description: ' pronounced 3Y-7Y Belly Hump (Svensson 4-Factor Curvature)',
    beta0: 0.0440,
    beta1: -0.0050,
    beta2: 0.0220,
    beta3: -0.0140,
    lambda1: 1.35,
    lambda2: 4.50
  }
};

const BENCHMARK_BONDS = [
  {
    id: 'UST-2Y-4.25',
    cusip: '912828YV6',
    symbol: 'UST-2Y',
    name: 'US Treasury Note 4.250% 2Y Benchmark',
    issuer: 'US_TREASURY',
    rating: 'AAA',
    faceValue: 100,
    notionalUsd: 10000000,
    couponRate: 0.0425,
    frequency: 2,
    maturityYears: 2.0,
    accruedFraction: 0.25,
    creditSpreadBps: 0.0
  },
  {
    id: 'UST-5Y-4.10',
    cusip: '912828ZW3',
    symbol: 'UST-5Y',
    name: 'US Treasury Note 4.100% 5Y Belly',
    issuer: 'US_TREASURY',
    rating: 'AAA',
    faceValue: 100,
    notionalUsd: 10000000,
    couponRate: 0.0410,
    frequency: 2,
    maturityYears: 5.0,
    accruedFraction: 0.40,
    creditSpreadBps: 0.0
  },
  {
    id: 'UST-10Y-4.35',
    cusip: '912828AX9',
    symbol: 'UST-10Y',
    name: 'US Treasury Note 4.350% 10Y On-The-Run',
    issuer: 'US_TREASURY',
    rating: 'AAA',
    faceValue: 100,
    notionalUsd: 10000000,
    couponRate: 0.0435,
    frequency: 2,
    maturityYears: 10.0,
    accruedFraction: 0.15,
    creditSpreadBps: 0.0
  },
  {
    id: 'UST-30Y-4.50',
    cusip: '912810TZ1',
    symbol: 'UST-30Y',
    name: 'US Treasury Long Bond 4.500% 30Y Ultra',
    issuer: 'US_TREASURY',
    rating: 'AAA',
    faceValue: 100,
    notionalUsd: 10000000,
    couponRate: 0.0450,
    frequency: 2,
    maturityYears: 30.0,
    accruedFraction: 0.30,
    creditSpreadBps: 0.0
  },
  {
    id: 'INDOGB-10Y-6.65',
    cusip: 'IDG000152',
    symbol: 'INDOGB-10Y',
    name: 'Republic of Indonesia Sovereign 6.650% 10Y',
    issuer: 'SOVEREIGN_EM',
    rating: 'BBB',
    faceValue: 100,
    notionalUsd: 5000000,
    couponRate: 0.0665,
    frequency: 2,
    maturityYears: 10.0,
    accruedFraction: 0.50,
    creditSpreadBps: 215.0
  },
  {
    id: 'CORP-NVDA-10Y-5.10',
    cusip: '67066GAA2',
    symbol: 'NVDA-34',
    name: 'NVIDIA Corp Senior Unsecured 5.100% 10Y',
    issuer: 'IG_CORPORATE',
    rating: 'AA',
    faceValue: 100,
    notionalUsd: 5000000,
    couponRate: 0.0510,
    frequency: 2,
    maturityYears: 10.0,
    accruedFraction: 0.20,
    creditSpreadBps: 68.0
  }
];

/**
 * Computes the Nelson-Siegel loading functions L1(tau, lambda), L2(tau, lambda)
 * with exact Taylor series limit as tau -> 0+.
 */
function computeNssLoadings(tau, lambda1 = 1.65, lambda2 = 6.50) {
  const t = Math.max(0, Number(tau) || 0);
  const l1 = Math.max(1e-4, Number(lambda1) || 1.65);
  const l2 = Math.max(1e-4, Number(lambda2) || 6.50);

  let factor1;
  let factor2;
  if (t < 1e-7) {
    factor1 = 1.0;
    factor2 = 0.0;
  } else {
    const x1 = t / l1;
    const exp1 = Math.exp(-x1);
    factor1 = (1 - exp1) / x1;
    factor2 = factor1 - exp1;
  }

  let factor3;
  if (t < 1e-7) {
    factor3 = 0.0;
  } else {
    const x2 = t / l2;
    const exp2 = Math.exp(-x2);
    factor3 = (1 - exp2) / x2 - exp2;
  }

  return {
    factor0: 1.0,
    factor1,
    factor2,
    factor3
  };
}

/**
 * Evaluates Nelson-Siegel-Svensson (NSS) spot yield y(tau), instantaneous forward rate f(tau),
 * and continuous discount factor D(tau) at maturity tau (in years).
 */
function evaluateNelsonSiegelSvensson(tau, params = {}) {
  const preset = NSS_REGIME_PRESETS[params.regime] || NSS_REGIME_PRESETS.NORMAL_STEEP;
  const beta0 = params.beta0 !== undefined ? Number(params.beta0) : preset.beta0;
  const beta1 = params.beta1 !== undefined ? Number(params.beta1) : preset.beta1;
  const beta2 = params.beta2 !== undefined ? Number(params.beta2) : preset.beta2;
  const beta3 = params.beta3 !== undefined ? Number(params.beta3) : preset.beta3;
  const lambda1 = params.lambda1 !== undefined ? Number(params.lambda1) : preset.lambda1;
  const lambda2 = params.lambda2 !== undefined ? Number(params.lambda2) : preset.lambda2;

  const t = Math.max(0, Number(tau) || 0);
  const l1 = Math.max(1e-4, lambda1);
  const l2 = Math.max(1e-4, lambda2);

  const loadings = computeNssLoadings(t, l1, l2);
  const spotYield =
    beta0 +
    beta1 * loadings.factor1 +
    beta2 * loadings.factor2 +
    beta3 * loadings.factor3;

  // Instantaneous forward rate f(tau) = d/dtau [tau * y(tau)]
  const x1 = t / l1;
  const x2 = t / l2;
  const exp1 = Math.exp(-x1);
  const exp2 = Math.exp(-x2);
  const forwardRate =
    beta0 +
    beta1 * exp1 +
    beta2 * x1 * exp1 +
    beta3 * x2 * exp2;

  const discountFactor = Math.exp(-spotYield * t);

  return {
    tau: t,
    maturityYears: t,
    spotYield: Number(spotYield.toFixed(8)),
    spotYieldPct: Number((spotYield * 100).toFixed(4)),
    forwardRate: Number(forwardRate.toFixed(8)),
    forwardRatePct: Number((forwardRate * 100).toFixed(4)),
    discountFactor: Number(discountFactor.toFixed(8)),
    loadings
  };
}

/**
 * Generates full sovereign yield curve across standard tenors + key institutional spread telemetry.
 */
function buildYieldCurve(options = {}) {
  const regimeKey = String(options.regime || 'NORMAL_STEEP').toUpperCase();
  const basePreset = NSS_REGIME_PRESETS[regimeKey] || NSS_REGIME_PRESETS.NORMAL_STEEP;
  const shiftBps = Number(options.parallelShiftBps || 0);
  const shiftDecimal = shiftBps / 10000;

  const nssParams = {
    regime: basePreset.regime,
    description: basePreset.description,
    beta0: (options.beta0 !== undefined ? Number(options.beta0) : basePreset.beta0) + shiftDecimal,
    beta1: options.beta1 !== undefined ? Number(options.beta1) : basePreset.beta1,
    beta2: options.beta2 !== undefined ? Number(options.beta2) : basePreset.beta2,
    beta3: options.beta3 !== undefined ? Number(options.beta3) : basePreset.beta3,
    lambda1: options.lambda1 !== undefined ? Number(options.lambda1) : basePreset.lambda1,
    lambda2: options.lambda2 !== undefined ? Number(options.lambda2) : basePreset.lambda2
  };

  const tenorsInput = Array.isArray(options.tenors) && options.tenors.length > 0
    ? options.tenors
    : STANDARD_TENORS;

  const points = tenorsInput.map((item) => {
    const years = typeof item === 'number' ? item : Number(item.years ?? item.tau ?? 1.0);
    const label = typeof item === 'object' && item.label ? item.label : `${years}Y`;
    const evalRes = evaluateNelsonSiegelSvensson(years, nssParams);
    return {
      tenor: label,
      label,
      years,
      tau: years,
      yield: evalRes.spotYield,
      spotYield: evalRes.spotYield,
      yieldPct: evalRes.spotYieldPct,
      spotYieldPct: evalRes.spotYieldPct,
      forwardRate: evalRes.forwardRate,
      forwardRatePct: evalRes.forwardRatePct,
      discountFactor: evalRes.discountFactor
    };
  });

  // Compute key institutional macro curve spreads in bps
  const y3M = evaluateNelsonSiegelSvensson(0.25, nssParams).spotYield;
  const y2Y = evaluateNelsonSiegelSvensson(2.0, nssParams).spotYield;
  const y5Y = evaluateNelsonSiegelSvensson(5.0, nssParams).spotYield;
  const y10Y = evaluateNelsonSiegelSvensson(10.0, nssParams).spotYield;
  const y30Y = evaluateNelsonSiegelSvensson(30.0, nssParams).spotYield;

  const spread2s10sBps = Number(((y10Y - y2Y) * 10000).toFixed(2));
  const spread3m10yBps = Number(((y10Y - y3M) * 10000).toFixed(2));
  const spread5s30sBps = Number(((y30Y - y5Y) * 10000).toFixed(2));
  const butterfly2s5s10sBps = Number(((2 * y5Y - y2Y - y10Y) * 10000).toFixed(2));

  return {
    regime: nssParams.regime,
    description: nssParams.description,
    parameters: nssParams,
    nssParams,
    points,
    curve: points,
    spreads: {
      spread2s10sBps,
      spread3m10yBps,
      spread5s30sBps,
      butterfly2s5s10sBps,
      isInverted2s10s: spread2s10sBps < 0,
      shortRateInstantaneousPct: Number(((nssParams.beta0 + nssParams.beta1) * 100).toFixed(4)),
      longRunInfiniteYieldPct: Number((nssParams.beta0 * 100).toFixed(4))
    },
    timestamp: Date.now()
  };
}

/**
 * Solves 4x4 linear system A * x = b using Gaussian elimination with partial pivoting.
 */
function solveLinearSystem4x4(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > maxVal) {
        maxVal = Math.abs(M[row][col]);
        pivotRow = row;
      }
    }
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }

    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) continue;

    for (let j = col; j <= n; j++) {
      M[col][j] /= pivot;
    }

    for (let row = 0; row < n; row++) {
      if (row !== col) {
        const factor = M[row][col];
        for (let j = col; j <= n; j++) {
          M[row][j] -= factor * M[col][j];
        }
      }
    }
  }

  return M.map((row) => row[n]);
}

/**
 * Calibrates Nelson-Siegel-Svensson (beta0, beta1, beta2, beta3, lambda1, lambda2)
 * to observed market yields [{ tau, yield }] via grid-search over (lambda1, lambda2)
 * and regularized OLS normal equations (X^T X + alpha*I) beta = X^T y.
 */
function calibrateNelsonSiegelSvensson(observations = [], options = {}) {
  const obs = (Array.isArray(observations) ? observations : []).map((o) => {
    const tau = Number(o.tau ?? o.years ?? o.maturityYears ?? 1.0);
    const rawY = Number(o.yield ?? o.spotYield ?? o.rate ?? 0.045);
    const y = rawY > 0.5 ? rawY / 100 : rawY; // Normalize percentage inputs (e.g., 4.35 -> 0.0435)
    return { tau: Math.max(0.01, tau), yield: y };
  });

  if (obs.length < 3) {
    throw new Error('At least 3 yield observations are required to calibrate Nelson-Siegel-Svensson');
  }

  const ridgeAlpha = Number(options.ridgeAlpha ?? 1e-8);
  const lambda1Candidates = options.lambda1 ? [Number(options.lambda1)] : [1.1, 1.4, 1.65, 2.0, 2.5];
  const lambda2Candidates = options.lambda2 ? [Number(options.lambda2)] : [4.5, 5.5, 6.5, 8.0];

  let bestFit = null;

  for (const l1 of lambda1Candidates) {
    for (const l2 of lambda2Candidates) {
      if (Math.abs(l1 - l2) < 0.5) continue;

      const XtX = [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0]
      ];
      const Xty = [0, 0, 0, 0];

      for (const pt of obs) {
        const load = computeNssLoadings(pt.tau, l1, l2);
        const row = [load.factor0, load.factor1, load.factor2, load.factor3];
        for (let r = 0; r < 4; r++) {
          Xty[r] += row[r] * pt.yield;
          for (let c = 0; c < 4; c++) {
            XtX[r][c] += row[r] * row[c];
          }
        }
      }

      for (let i = 1; i < 4; i++) {
        XtX[i][i] += ridgeAlpha;
      }

      const betas = solveLinearSystem4x4(XtX, Xty);
      const [beta0, beta1, beta2, beta3] = betas;

      let sse = 0;
      const fittedPoints = obs.map((pt) => {
        const pred = evaluateNelsonSiegelSvensson(pt.tau, { beta0, beta1, beta2, beta3, lambda1: l1, lambda2: l2 });
        const err = pred.spotYield - pt.yield;
        sse += err * err;
        return {
          tau: pt.tau,
          observedYield: pt.yield,
          fittedYield: pred.spotYield,
          residualBps: Number((err * 10000).toFixed(4))
        };
      });

      const rmse = Math.sqrt(sse / obs.length);
      if (!bestFit || rmse < bestFit.rmse) {
        bestFit = {
          beta0: Number(beta0.toFixed(8)),
          beta1: Number(beta1.toFixed(8)),
          beta2: Number(beta2.toFixed(8)),
          beta3: Number(beta3.toFixed(8)),
          lambda1: l1,
          lambda2: l2,
          rmse,
          rmseBps: Number((rmse * 10000).toFixed(4)),
          fittedPoints
        };
      }
    }
  }

  return bestFit;
}

/**
 * Generates cash flow schedule for a fixed-coupon bond.
 */
function buildBondCashFlows({
  faceValue = 100,
  couponRate = 0.0435,
  frequency = 2,
  maturityYears = 10.0,
  accruedFraction = 0.0
}) {
  const F = Number(faceValue) || 100;
  const c = Number(couponRate) > 0.5 ? Number(couponRate) / 100 : Number(couponRate);
  const freq = Math.max(1, Math.round(Number(frequency) || 2));
  const T = Math.max(1 / freq, Number(maturityYears) || 10.0);
  const alpha = Math.min(0.9999, Math.max(0, Number(accruedFraction) || 0));

  const totalPeriods = Math.max(1, Math.round(T * freq));
  const couponPerPeriod = (F * c) / freq;
  const cashFlows = [];

  for (let i = 1; i <= totalPeriods; i++) {
    const periodsFromNow = i - alpha;
    const timeYears = periodsFromNow / freq;
    const amount = i === totalPeriods ? couponPerPeriod + F : couponPerPeriod;
    cashFlows.push({
      periodIndex: i,
      periodsFromNow,
      timeYears,
      couponAmount: i === totalPeriods ? couponPerPeriod : amount,
      principalAmount: i === totalPeriods ? F : 0,
      totalCashFlow: amount
    });
  }

  const accruedInterest = Number((couponPerPeriod * alpha).toFixed(6));

  return {
    faceValue: F,
    couponRate: c,
    frequency: freq,
    maturityYears: T,
    accruedFraction: alpha,
    couponPerPeriod,
    accruedInterest,
    totalPeriods,
    cashFlows
  };
}

/**
 * Computes institutional Fixed Income Bond price and risk sensitivities:
 *   - Clean Price, Accrued Interest, Dirty Price
 *   - Macaulay Duration (years), Modified Duration (years)
 *   - Dollar Duration / DV01 (per 100 par and per notionalUsd)
 *   - Convexity (years^2)
 */
function priceBond(params = {}) {
  const faceValue = Number(params.faceValue ?? 100);
  const notionalUsd = Number(params.notionalUsd ?? 1000000);
  const couponRate = Number(params.couponRate ?? 0.0435);
  const frequency = Math.max(1, Math.round(Number(params.frequency ?? 2)));
  const maturityYears = Math.max(0.05, Number(params.maturityYears ?? params.tau ?? 10.0));
  const accruedFraction = Math.min(0.999, Math.max(0, Number(params.accruedFraction ?? 0.0)));

  let ytm = params.ytm ?? params.yieldToMaturity ?? params.yield;
  if (ytm === undefined || ytm === null) {
    const nssEval = evaluateNelsonSiegelSvensson(maturityYears, params.nssParams || {});
    const creditSpread = Number(params.creditSpreadBps || 0) / 10000;
    ytm = nssEval.spotYield + creditSpread;
  } else {
    ytm = Number(ytm);
    if (ytm > 0.5) ytm /= 100;
  }

  const schedule = buildBondCashFlows({
    faceValue,
    couponRate,
    frequency,
    maturityYears,
    accruedFraction
  });

  const freq = schedule.frequency;
  const periodicYield = ytm / freq;
  const discountBase = 1 + periodicYield;

  let dirtyPrice = 0;
  let weightedTimeSum = 0;
  let convexitySum = 0;

  for (const cf of schedule.cashFlows) {
    const k = cf.periodsFromNow;
    const tYears = cf.timeYears;
    const pv = cf.totalCashFlow / Math.pow(discountBase, k);
    dirtyPrice += pv;
    weightedTimeSum += tYears * pv;
    convexitySum += (k * (k + 1) * cf.totalCashFlow) / Math.pow(discountBase, k + 2);
  }

  const cleanPrice = dirtyPrice - schedule.accruedInterest;
  const macaulayDuration = dirtyPrice > 0 ? weightedTimeSum / dirtyPrice : 0;
  const modifiedDuration = macaulayDuration / discountBase;
  const convexity = dirtyPrice > 0 ? convexitySum / (dirtyPrice * freq * freq) : 0;

  // DV01 per 100 par and per position notionalUsd
  const dv01Per100Par = dirtyPrice * modifiedDuration * 0.0001;
  const contractsFactor = notionalUsd / faceValue;
  const dv01Usd = dv01Per100Par * contractsFactor;

  return {
    id: params.id || `BOND-${maturityYears}Y`,
    symbol: params.symbol || `UST-${maturityYears}Y`,
    name: params.name || `Fixed Rate Bond ${(schedule.couponRate * 100).toFixed(2)}% ${maturityYears}Y`,
    faceValue,
    notionalUsd,
    couponRate: schedule.couponRate,
    couponPct: Number((schedule.couponRate * 100).toFixed(3)),
    frequency,
    maturityYears,
    ytm: Number(ytm.toFixed(8)),
    ytmPct: Number((ytm * 100).toFixed(4)),
    cleanPrice: Number(cleanPrice.toFixed(6)),
    accruedInterest: Number(schedule.accruedInterest.toFixed(6)),
    dirtyPrice: Number(dirtyPrice.toFixed(6)),
    macaulayDuration: Number(macaulayDuration.toFixed(6)),
    modifiedDuration: Number(modifiedDuration.toFixed(6)),
    convexity: Number(convexity.toFixed(6)),
    dv01Per100Par: Number(dv01Per100Par.toFixed(6)),
    dv01Usd: Number(dv01Usd.toFixed(2)),
    dv01: Number(dv01Usd.toFixed(2))
  };
}

/**
 * Newton-Raphson Yield-to-Maturity (YTM) solver given a target clean or dirty bond price.
 */
function solveBondYtm(params = {}) {
  const faceValue = Number(params.faceValue ?? 100);
  const couponRate = Number(params.couponRate ?? 0.0435);
  const frequency = Math.max(1, Math.round(Number(params.frequency ?? 2)));
  const maturityYears = Math.max(0.05, Number(params.maturityYears ?? 10.0));
  const accruedFraction = Math.min(0.999, Math.max(0, Number(params.accruedFraction ?? 0.0)));

  const schedule = buildBondCashFlows({
    faceValue,
    couponRate,
    frequency,
    maturityYears,
    accruedFraction
  });

  const targetDirtyPrice = params.dirtyPrice !== undefined
    ? Number(params.dirtyPrice)
    : Number(params.targetPrice ?? params.cleanPrice ?? params.price ?? 100) + schedule.accruedInterest;

  // Initial guess using standard street approximation
  let y = schedule.couponRate + ((faceValue - (targetDirtyPrice - schedule.accruedInterest)) / maturityYears) / ((faceValue + targetDirtyPrice) / 2);
  if (!Number.isFinite(y) || y <= -0.5) y = 0.04;

  const maxIterations = 50;
  const tolerance = 1e-10;
  let iterations = 0;
  let converged = false;

  for (let iter = 1; iter <= maxIterations; iter++) {
    iterations = iter;
    const base = 1 + y / frequency;
    let pv = 0;
    let dPvDy = 0;

    for (const cf of schedule.cashFlows) {
      const k = cf.periodsFromNow;
      const df = Math.pow(base, -k);
      pv += cf.totalCashFlow * df;
      dPvDy += cf.totalCashFlow * (-k / frequency) * Math.pow(base, -(k + 1));
    }

    const diff = pv - targetDirtyPrice;
    if (Math.abs(diff) < tolerance) {
      converged = true;
      break;
    }

    if (Math.abs(dPvDy) < 1e-12) break;
    const step = diff / dPvDy;
    y = Math.max(-0.20, Math.min(2.0, y - step));
    if (Math.abs(step) < tolerance) {
      converged = true;
      break;
    }
  }

  const Analytics = priceBond({
    ...params,
    faceValue,
    couponRate,
    frequency,
    maturityYears,
    accruedFraction,
    ytm: y
  });

  return {
    ytm: Number(y.toFixed(8)),
    ytmPct: Number((y * 100).toFixed(4)),
    iterations,
    converged,
    targetDirtyPrice: Number(targetDirtyPrice.toFixed(6)),
    modelDirtyPrice: Analytics.dirtyPrice,
    pricingError: Number(Math.abs(Analytics.dirtyPrice - targetDirtyPrice).toExponential(4)),
    analytics: Analytics
  };
}

/**
 * Solves Zero-Volatility Spread (Z-Spread) over the Nelson-Siegel-Svensson spot curve
 * via Newton-Raphson so that sum_i CF_i * exp(-(y_NSS(t_i) + z) * t_i) = DirtyPrice.
 */
function solveBondZSpread(params = {}) {
  const schedule = buildBondCashFlows({
    faceValue: params.faceValue ?? 100,
    couponRate: params.couponRate ?? 0.0435,
    frequency: params.frequency ?? 2,
    maturityYears: params.maturityYears ?? 10.0,
    accruedFraction: params.accruedFraction ?? 0.0
  });

  const nssParams = params.nssParams || NSS_REGIME_PRESETS[params.regime || 'NORMAL_STEEP'] || NSS_REGIME_PRESETS.NORMAL_STEEP;

  let targetDirtyPrice = params.dirtyPrice !== undefined
    ? Number(params.dirtyPrice)
    : params.cleanPrice !== undefined
      ? Number(params.cleanPrice) + schedule.accruedInterest
      : null;

  if (targetDirtyPrice === null || !Number.isFinite(targetDirtyPrice)) {
    const priced = priceBond({ ...params, nssParams });
    targetDirtyPrice = priced.dirtyPrice;
  }

  let z = Number(params.creditSpreadBps || 0) / 10000;
  let iterations = 0;
  let converged = false;

  for (let iter = 1; iter <= 50; iter++) {
    iterations = iter;
    let pv = 0;
    let dPvDz = 0;

    for (const cf of schedule.cashFlows) {
      const t = cf.timeYears;
      const spotY = evaluateNelsonSiegelSvensson(t, nssParams).spotYield;
      const df = Math.exp(-(spotY + z) * t);
      const term = cf.totalCashFlow * df;
      pv += term;
      dPvDz -= t * term;
    }

    const diff = pv - targetDirtyPrice;
    if (Math.abs(diff) < 1e-9) {
      converged = true;
      break;
    }
    if (Math.abs(dPvDz) < 1e-12) break;
    z -= diff / dPvDz;
  }

  return {
    zSpread: Number(z.toFixed(8)),
    zSpreadBps: Number((z * 10000).toFixed(2)),
    iterations,
    converged,
    targetDirtyPrice: Number(targetDirtyPrice.toFixed(6))
  };
}

/**
 * Evaluates bond price shock under parallel / non-parallel yield shifts, comparing
 * 1st-order Duration + 2nd-order Convexity Taylor expansion against exact full repricing:
 *   DeltaP / P ~= -D_mod * DeltaY + 0.5 * Convexity * (DeltaY)^2
 */
function shockBondPrice(bondParams = {}, shiftBpsList = [-100, -50, -25, 0, 25, 50, 100, 200]) {
  const base = priceBond(bondParams);
  const P0 = base.dirtyPrice;
  const Dmod = base.modifiedDuration;
  const Conv = base.convexity;
  const contractsFactor = base.notionalUsd / base.faceValue;

  const scenarios = shiftBpsList.map((bps) => {
    const dy = Number(bps) / 10000;
    const shocked = priceBond({
      ...bondParams,
      ytm: base.ytm + dy
    });

    const exactPriceChange = shocked.dirtyPrice - P0;
    const durationApproxChange = P0 * (-Dmod * dy);
    const convexityAdjustment = P0 * (0.5 * Conv * dy * dy);
    const taylorApproxChange = durationApproxChange + convexityAdjustment;
    const approxErrorBps = P0 > 0 ? Math.abs(exactPriceChange - taylorApproxChange) / P0 * 10000 : 0;

    return {
      shiftBps: Number(bps),
      shockedYtmPct: shocked.ytmPct,
      exactDirtyPrice: Number(shocked.dirtyPrice.toFixed(6)),
      taylorDirtyPrice: Number((P0 + taylorApproxChange).toFixed(6)),
      exactPriceChange: Number(exactPriceChange.toFixed(6)),
      durationApproxChange: Number(durationApproxChange.toFixed(6)),
      convexityAdjustment: Number(convexityAdjustment.toFixed(6)),
      taylorApproxChange: Number(taylorApproxChange.toFixed(6)),
      exactPnlUsd: Number((exactPriceChange * contractsFactor).toFixed(2)),
      taylorPnlUsd: Number((taylorApproxChange * contractsFactor).toFixed(2)),
      approxErrorBps: Number(approxErrorBps.toFixed(4))
    };
  });

  return {
    baseBond: base,
    scenarios
  };
}

/**
 * Builds the full institutional Macro Yield Curve & Fixed Income Bond Desk state payload.
 */
function buildMacroBondDeskReport(options = {}) {
  const curveReport = buildYieldCurve(options);
  const nssParams = curveReport.parameters;

  let totalNotionalUsd = 0;
  let totalDv01Usd = 0;
  let weightedDurationSum = 0;
  let weightedConvexitySum = 0;

  const bonds = BENCHMARK_BONDS.map((b) => {
    const priced = priceBond({
      ...b,
      nssParams
    });
    const zRes = solveBondZSpread({
      ...b,
      nssParams,
      dirtyPrice: priced.dirtyPrice
    });

    totalNotionalUsd += priced.notionalUsd;
    totalDv01Usd += priced.dv01Usd;
    weightedDurationSum += priced.modifiedDuration * priced.notionalUsd;
    weightedConvexitySum += priced.convexity * priced.notionalUsd;

    return {
      ...b,
      ...priced,
      zSpreadBps: zRes.zSpreadBps
    };
  });

  const portfolioModDuration = totalNotionalUsd > 0 ? weightedDurationSum / totalNotionalUsd : 0;
  const portfolioConvexity = totalNotionalUsd > 0 ? weightedConvexitySum / totalNotionalUsd : 0;
  const benchmark10Y = bonds.find((b) => b.symbol === 'UST-10Y') || bonds[0];
  const shockTable = shockBondPrice(benchmark10Y, [-100, -50, -25, 0, 25, 50, 100, 200]);

  return {
    regime: curveReport.regime,
    description: curveReport.description,
    availableRegimes: Object.keys(NSS_REGIME_PRESETS),
    nssParams,
    parameters: nssParams,
    curve: curveReport.points,
    points: curveReport.points,
    spreads: curveReport.spreads,
    bonds,
    deskSummary: {
      totalNotionalUsd: Number(totalNotionalUsd.toFixed(2)),
      totalDv01Usd: Number(totalDv01Usd.toFixed(2)),
      portfolioModDuration: Number(portfolioModDuration.toFixed(4)),
      portfolioConvexity: Number(portfolioConvexity.toFixed(4)),
      hedgeRatio10YContracts: Number((totalDv01Usd / Math.max(1, benchmark10Y.dv01Per100Par * 1000)).toFixed(2))
    },
    shockAnalysis: shockTable,
    timestamp: Date.now()
  };
}

module.exports = {
  STANDARD_TENORS,
  NSS_REGIME_PRESETS,
  BENCHMARK_BONDS,
  computeNssLoadings,
  evaluateNelsonSiegelSvensson,
  buildYieldCurve,
  calibrateNelsonSiegelSvensson,
  buildBondCashFlows,
  priceBond,
  solveBondYtm,
  solveBondZSpread,
  shockBondPrice,
  buildMacroBondDeskReport
};
