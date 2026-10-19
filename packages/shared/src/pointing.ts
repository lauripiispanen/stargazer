// Alt-az pointing model (PROTOCOL.md §7.2). Pure math, no I/O.
// "sky" = apparent topocentric alt-az (deg); "encoder" = raw mount encoder degrees (az 0..360 wrap, alt signed).
//
// Conventions (the simulator must use these same functions for its hidden "truth"):
//   1. v = unit vector of sky (Az, Alt) in a local frame x=North, y=East, z=Up.
//   2. v' = R v with R = Rx(-AW) · Ry(-AN). The mount's azimuth axis therefore points
//      AN degrees toward north and AW degrees toward west of the zenith.
//   3. (A', E') = spherical angles of v' (A' measured N->E).
//   4. A_e = A' - IA + CA·sec E' + NPAE·tan E'   (wrapped to 0..360)
//      E_e = E' - IE                              (wrapped to -180..180)
//   So IA / IE are the sky azimuth / altitude at which the encoders read zero
//   (powering on pointing north and level gives IA = IE = 0).
import type { PointingModelParams } from './api.ts';
import type { AltAz } from './astro.ts';

export const ZERO_PARAMS: PointingModelParams = { IA: 0, IE: 0, AN: 0, AW: 0, CA: 0, NPAE: 0 };

export interface Observation { sky: AltAz; encoder: { az: number; alt: number } }
export interface FitResult {
  params: PointingModelParams;
  solved: (keyof PointingModelParams)[];
  residualsArcmin: number[]; // per observation, same order
  rmsArcmin: number;
  /** True when the star geometry could not constrain the progressive parameter set and some were dropped. */
  degenerate?: boolean;
  /** Human-readable notes (dropped params, poor geometry, non-convergence). */
  warnings?: string[];
  /** 1-sigma uncertainty (deg) of each solved param, assuming 1 arcmin centring error per axis. */
  sigmaDeg?: Partial<PointingModelParams>;
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const PARAM_ORDER: (keyof PointingModelParams)[] = ['IA', 'IE', 'AN', 'AW', 'CA', 'NPAE'];
/** Clamp for sec/tan E' so the model stays finite at the zenith (|E'| <= ~89.4 deg). */
const MIN_COS = 0.01;

const norm360 = (d: number): number => ((d % 360) + 360) % 360;
const norm180 = (d: number): number => {
  const x = norm360(d);
  return x > 180 ? x - 360 : x;
};

/** v' = Rx(-AW) · Ry(-AN) · v */
function tiltForward(v: number[], AN: number, AW: number): number[] {
  const ca = Math.cos(AN * DEG), sa = Math.sin(AN * DEG);
  const cw = Math.cos(AW * DEG), sw = Math.sin(AW * DEG);
  // Ry(-AN): [[c,0,-s],[0,1,0],[s,0,c]]
  const x1 = ca * v[0] - sa * v[2];
  const y1 = v[1];
  const z1 = sa * v[0] + ca * v[2];
  // Rx(-AW): [[1,0,0],[0,c,s],[0,-s,c]]
  return [x1, cw * y1 + sw * z1, -sw * y1 + cw * z1];
}
/** v = Ry(AN) · Rx(AW) · v'  (transpose of tiltForward) */
function tiltInverse(v: number[], AN: number, AW: number): number[] {
  const ca = Math.cos(AN * DEG), sa = Math.sin(AN * DEG);
  const cw = Math.cos(AW * DEG), sw = Math.sin(AW * DEG);
  const x1 = v[0];
  const y1 = cw * v[1] - sw * v[2];
  const z1 = sw * v[1] + cw * v[2];
  return [ca * x1 + sa * z1, y1, -sa * x1 + ca * z1];
}

function secTan(E: number): { sec: number; tan: number } {
  const c = Math.max(Math.abs(Math.cos(E * DEG)), MIN_COS);
  return { sec: 1 / c, tan: Math.sin(E * DEG) / c };
}

/** sky -> encoder */
export function skyToEncoder(sky: AltAz, p: PointingModelParams): { az: number; alt: number } {
  const ce = Math.cos(sky.alt * DEG);
  const v = [ce * Math.cos(sky.az * DEG), ce * Math.sin(sky.az * DEG), Math.sin(sky.alt * DEG)];
  const w = tiltForward(v, p.AN, p.AW);
  const A = Math.atan2(w[1], w[0]) * RAD;
  const E = Math.asin(Math.max(-1, Math.min(1, w[2]))) * RAD;
  const { sec, tan } = secTan(E);
  return { az: norm360(A - p.IA + p.CA * sec + p.NPAE * tan), alt: norm180(E - p.IE) };
}

/**
 * encoder -> sky. Exact inverse of skyToEncoder: E' follows directly from the
 * encoder altitude, after which the azimuth terms are known in closed form.
 */
export function encoderToSky(enc: { az: number; alt: number }, p: PointingModelParams): AltAz {
  const E = enc.alt + p.IE;
  const { sec, tan } = secTan(E);
  const A = enc.az + p.IA - p.CA * sec - p.NPAE * tan;
  const ce = Math.cos(E * DEG);
  const w = [ce * Math.cos(A * DEG), ce * Math.sin(A * DEG), Math.sin(E * DEG)];
  const v = tiltInverse(w, p.AN, p.AW);
  return {
    az: norm360(Math.atan2(v[1], v[0]) * RAD),
    alt: Math.asin(Math.max(-1, Math.min(1, v[2]))) * RAD,
  };
}

/** IA/IE that make `sky` map exactly onto `encoder`, keeping the other params of `base`. */
export function offsetsFromPoint(sky: AltAz, encoder: { az: number; alt: number }, base: PointingModelParams = ZERO_PARAMS): PointingModelParams {
  const p0 = { ...base, IA: 0, IE: 0 };
  const e0 = skyToEncoder(sky, p0); // encoder reading with zero offsets
  return { ...base, IA: norm360(e0.az - encoder.az), IE: e0.alt - encoder.alt };
}

/** Parameters solved for a given number of observations (progressive model). */
export function paramsForCount(n: number): (keyof PointingModelParams)[] {
  if (n <= 0) return [];
  if (n === 1) return ['IA', 'IE'];
  if (n === 2) return ['IA', 'IE', 'AN', 'AW'];
  if (n === 3) return ['IA', 'IE', 'AN', 'AW', 'CA'];
  return [...PARAM_ORDER];
}

/** Residual vector (arcmin): [dA·cos(alt), dE] per observation, encoder space. */
function residualVector(obs: Observation[], p: PointingModelParams): number[] {
  const r: number[] = [];
  for (const o of obs) {
    const pred = skyToEncoder(o.sky, p);
    r.push(norm180(pred.az - o.encoder.az) * Math.cos(o.sky.alt * DEG) * 60);
    r.push(norm180(pred.alt - o.encoder.alt) * 60);
  }
  return r;
}

const sumSq = (r: number[]): number => r.reduce((s, x) => s + x * x, 0);

function withValues(base: PointingModelParams, names: (keyof PointingModelParams)[], x: number[]): PointingModelParams {
  const p = { ...base };
  names.forEach((n, i) => (p[n] = x[i]));
  return p;
}

function jacobian(obs: Observation[], base: PointingModelParams, names: (keyof PointingModelParams)[], x: number[], r0: number[]): number[][] {
  const h = 1e-6;
  const cols = names.map((_, j) => {
    const xh = x.slice();
    xh[j] += h;
    const r = residualVector(obs, withValues(base, names, xh));
    return r.map((ri, i) => (ri - r0[i]) / h);
  });
  // rows = residuals, cols = params
  return r0.map((_, i) => cols.map((c) => c[i]));
}

/** Solve A x = b (small dense, partial pivoting). Returns null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-300) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

function invert(A: number[][]): number[][] | null {
  const n = A.length;
  const cols: number[][] = [];
  for (let j = 0; j < n; j++) {
    const e = new Array(n).fill(0);
    e[j] = 1;
    const c = solve(A, e);
    if (!c || c.some((v) => !Number.isFinite(v))) return null;
    cols.push(c);
  }
  return A.map((_, i) => cols.map((c) => c[i]));
}

const normalMatrix = (J: number[][]): number[][] =>
  J[0].map((_, a) => J[0].map((_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));

/** Levenberg-Marquardt over the named params. Returns the best params found. */
function levenbergMarquardt(obs: Observation[], start: PointingModelParams, names: (keyof PointingModelParams)[]): { params: PointingModelParams; converged: boolean } {
  let x = names.map((n) => start[n]);
  let r = residualVector(obs, start);
  let cost = sumSq(r);
  let lambda = 1e-3;
  let converged = false;
  for (let iter = 0; iter < 200 && !converged; iter++) {
    const J = jacobian(obs, start, names, x, r);
    const A = normalMatrix(J);
    const g = names.map((_, a) => J.reduce((s, row, i) => s + row[a] * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 30; tries++) {
      const Ad = A.map((row, i) => row.map((v, j) => (i === j ? v + lambda * Math.max(v, 1e-9) : v)));
      const step = solve(Ad, g.map((v) => -v));
      if (!step) {
        lambda *= 10;
        continue;
      }
      const xn = x.map((v, i) => v + step[i]);
      const rn = residualVector(obs, withValues(start, names, xn));
      const cn = sumSq(rn);
      if (cn <= cost) {
        const stepSize = Math.max(...step.map(Math.abs));
        x = xn;
        r = rn;
        const rel = (cost - cn) / Math.max(cost, 1e-30);
        cost = cn;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        if (stepSize < 1e-10 || rel < 1e-14 || cost < 1e-20) converged = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) converged = true; // cannot improve further: at a minimum (to numerical precision)
  }
  return { params: withValues(start, names, x), converged };
}

/** Assumed centring error per axis (arcmin) for parameter-uncertainty estimates. */
const SIGMA_ARCMIN = 1;
/** A parameter whose 1-sigma uncertainty exceeds this (deg) is considered unconstrained. */
const MAX_SIGMA_DEG = 0.5;
/** Above this (deg) the fit is kept but flagged as weak. */
const WEAK_SIGMA_DEG = 0.15;

function paramSigmas(obs: Observation[], p: PointingModelParams, names: (keyof PointingModelParams)[]): number[] | null {
  const x = names.map((n) => p[n]);
  const r = residualVector(obs, p);
  const J = jacobian(obs, p, names, x, r);
  const inv = invert(normalMatrix(J));
  if (!inv) return null;
  return names.map((_, i) => SIGMA_ARCMIN * Math.sqrt(Math.max(inv[i][i], 0)));
}

/**
 * Fit params from observations. 1 obs: IA,IE. 2: +AN,AW. 3: +CA. >=4: +NPAE.
 * `initial` seeds the solver (e.g. from alignHome) and supplies the values of unsolved params.
 * If the star geometry cannot constrain a parameter (e.g. two stars at nearly the same azimuth),
 * the highest-order params are dropped (NPAE, CA, then AN+AW) and `degenerate`/`warnings` are set.
 */
export function fitModel(obs: Observation[], initial?: PointingModelParams): FitResult {
  const base = { ...ZERO_PARAMS, ...(initial ?? {}) };
  if (obs.length === 0) return { params: base, solved: [], residualsArcmin: [], rmsArcmin: 0 };

  // Starting point: whichever of `initial` / first-star offsets fits better.
  const candidates = [offsetsFromPoint(obs[0].sky, obs[0].encoder, base), offsetsFromPoint(obs[0].sky, obs[0].encoder, ZERO_PARAMS)];
  if (initial) candidates.push(base);
  let start = candidates[0];
  let best = Infinity;
  for (const c of candidates) {
    const cost = sumSq(residualVector(obs, c));
    if (cost < best) [best, start] = [cost, c];
  }

  const warnings: string[] = [];
  let names = paramsForCount(obs.length);
  const wanted = names.length;
  let result = levenbergMarquardt(obs, start, names);
  let sigmas = paramSigmas(obs, result.params, names);

  // Drop unconstrained higher-order terms until the remaining set is well determined.
  while (names.length > 2 && (!sigmas || sigmas.some((s, i) => !(s <= MAX_SIGMA_DEG) && i >= 2))) {
    const drop: (keyof PointingModelParams)[] = names.includes('NPAE') ? ['NPAE'] : names.includes('CA') ? ['CA'] : ['AN', 'AW'];
    warnings.push(`Star geometry cannot constrain ${drop.join('/')}; held at initial value. Add stars spread in azimuth and altitude.`);
    names = names.filter((n) => !drop.includes(n));
    const reset = { ...result.params };
    for (const d of drop) reset[d] = base[d];
    result = levenbergMarquardt(obs, offsetsFromPoint(obs[0].sky, obs[0].encoder, reset), names);
    sigmas = paramSigmas(obs, result.params, names);
  }
  if (!result.converged) warnings.push('Fit did not fully converge.');
  if (sigmas && names.length > 2 && sigmas.some((s, i) => i >= 2 && s > WEAK_SIGMA_DEG)) {
    warnings.push('Weak star geometry: model terms are poorly determined. Prefer stars >= 60° apart in azimuth and at different altitudes.');
  }

  const params = { ...result.params, IA: norm360(result.params.IA) };
  const r = residualVector(obs, params);
  const residualsArcmin = obs.map((_, i) => Math.hypot(r[2 * i], r[2 * i + 1]));
  const rmsArcmin = Math.sqrt(residualsArcmin.reduce((s, x) => s + x * x, 0) / obs.length);
  const sigmaDeg: Partial<PointingModelParams> = {};
  if (sigmas) names.forEach((n, i) => (sigmaDeg[n] = sigmas![i]));
  const fit: FitResult = { params, solved: names, residualsArcmin, rmsArcmin, sigmaDeg };
  if (names.length < wanted) fit.degenerate = true;
  if (warnings.length) fit.warnings = warnings;
  return fit;
}
