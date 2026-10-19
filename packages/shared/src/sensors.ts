// Phone sensors -> where the telescope tube points (for "sensor auto-align"). Pure math, no DOM.
//
// Placement: the phone lies FLAT on top of the tube, screen up, with its TOP EDGE toward the sky end of the
// tube (the open end, where the tube points). The tube axis is then the phone's +y axis.
//
// Frames (W3C DeviceOrientation): device x = right edge, y = top edge, z = out of the screen. Earth frame
// E = east, N = north, U = up. The event angles give the device->earth rotation R = Rz(alpha)·Rx(beta)·Ry(gamma):
//   alpha: rotation about U (counter-clockwise seen from above); "absolute" when 0 = magnetic north
//   beta:  rotation about the device x axis (top edge up = positive), -180..180
//   gamma: rotation about the device y axis (roll; right edge down = positive), -90..90
// The tube direction is R·[0,1,0] = (-sin α cos β, cos α cos β, sin β), so
//   altitude = β  (independent of the roll γ: a phone that slid sideways on the round tube still reads true alt)
//   heading of the long axis = atan2(-sin α, cos α) = 360 − α   (clockwise from north)
// Platforms:
//   Android Chrome: `deviceorientationabsolute` gives α relative to magnetic north (CCW) -> heading = 360 − α.
//   iOS Safari:     `webkitCompassHeading` is already the clockwise magnetic heading of the top edge; α is
//                   relative to an arbitrary start direction, so we use the compass heading instead.
import type { AlignmentHome } from './api.ts';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const norm360 = (d: number): number => ((d % 360) + 360) % 360;
const norm180 = (d: number): number => {
  const x = norm360(d);
  return x > 180 ? x - 360 : x;
};

/** Above this tube altitude the heading of the long axis is ill-conditioned (and iOS swaps axes): refuse. */
export const MAX_SENSOR_ALT_DEG = 75;
/** Heading is best below this altitude; above it the UI warns. */
export const GOOD_HEADING_ALT_DEG = 50;
/** Baseline 1-sigma heading error of a phone compass on a telescope (steel tube, motors, tripod), deg. */
export const COMPASS_BASE_SIGMA_DEG = 5;
/** Baseline 1-sigma altitude error from the phone's gravity sensor (incl. phone-on-tube seating), deg. */
export const ALT_BASE_SIGMA_DEG = 0.5;

/** One deviceorientation(absolute) event, as the browser gave it. */
export interface RawOrientation {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  /** True for `deviceorientationabsolute` (or `absolute: true` events): alpha is relative to magnetic north. */
  absolute?: boolean;
  /** iOS: clockwise degrees from magnetic north of the device's top edge. */
  webkitCompassHeading?: number | null;
  /** iOS: ± degrees of heading uncertainty; negative = invalid (needs calibration). */
  webkitCompassAccuracy?: number | null;
}

export type HeadingSource = 'ios-compass' | 'absolute-alpha';

/** Where the tube points according to one sensor sample. */
export interface TubeReading {
  altDeg: number;
  /** Magnetic heading of the tube axis (deg clockwise from magnetic north); null when the browser gives none. */
  magHeadingDeg: number | null;
  /** Phone roll about the tube axis (deg); |roll| up to ~45° is fine. */
  rollDeg: number;
  headingSource: HeadingSource | null;
  /** iOS compass accuracy (deg), null when unknown, negative when the compass needs calibration. */
  accuracyDeg: number | null;
}

type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];

/** Device -> earth (E, N, U) rotation matrix for W3C Euler angles (deg). */
export function rotationMatrix(alpha: number, beta: number, gamma: number): Mat3 {
  const cA = Math.cos(alpha * DEG), sA = Math.sin(alpha * DEG);
  const cB = Math.cos(beta * DEG), sB = Math.sin(beta * DEG);
  const cG = Math.cos(gamma * DEG), sG = Math.sin(gamma * DEG);
  return [
    [cA * cG - sA * sB * sG, -cB * sA, cA * sG + cG * sA * sB],
    [cG * sA + cA * sB * sG, cA * cB, sA * sG - cA * cG * sB],
    [-cB * sG, sB, cB * cG],
  ];
}

/** W3C Euler angles of a device -> earth rotation matrix (the inverse of rotationMatrix; beta in -90..90). */
export function eulerFromMatrix(R: Mat3): { alpha: number; beta: number; gamma: number } {
  const beta = Math.asin(Math.max(-1, Math.min(1, R[2][1]))) * RAD;
  const alpha = norm360(Math.atan2(-R[0][1], R[1][1]) * RAD);
  const gamma = Math.atan2(-R[2][0], R[2][2]) * RAD;
  return { alpha, beta, gamma };
}

/**
 * Device orientation of a phone lying on a tube that points at (az, alt), rolled by `rollDeg` about the tube
 * axis (positive = right edge down). For tests and the simulator's fake sensors. Earth frame E,N,U.
 */
export function deviceMatrixForTube(azDeg: number, altDeg: number, rollDeg = 0): Mat3 {
  const ca = Math.cos(altDeg * DEG), sa = Math.sin(altDeg * DEG);
  const y = [ca * Math.sin(azDeg * DEG), ca * Math.cos(azDeg * DEG), sa]; // tube axis
  // screen normal with no roll: "up" made perpendicular to the tube
  const z0 = [-sa * Math.sin(azDeg * DEG), -sa * Math.cos(azDeg * DEG), ca];
  const x0 = cross(y, z0); // right-handed: x = y × z
  // roll = R0 · Ry(roll): x' = x cos r − z sin r, z' = z cos r + x sin r (the W3C gamma rotation)
  const cr = Math.cos(rollDeg * DEG), sr = Math.sin(rollDeg * DEG);
  const x = x0.map((v, i) => v * cr - z0[i]! * sr);
  const z = z0.map((v, i) => v * cr + x0[i]! * sr);
  return [
    [x[0]!, y[0]!, z[0]!],
    [x[1]!, y[1]!, z[1]!],
    [x[2]!, y[2]!, z[2]!],
  ];
}

function cross(a: number[], b: number[]): number[] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

/** Tube axis (phone +y) direction from W3C Euler angles: altitude, heading relative to alpha's zero, roll. */
export function tubeFromEuler(alpha: number, beta: number, gamma: number): { altDeg: number; headingDeg: number; rollDeg: number } {
  const R = rotationMatrix(alpha, beta, gamma);
  const e = R[0][1], n = R[1][1], u = R[2][1];
  const altDeg = Math.asin(Math.max(-1, Math.min(1, u))) * RAD;
  const headingDeg = norm360(Math.atan2(e, n) * RAD);
  // roll: angle of the screen normal out of the vertical plane through the tube = gamma for |beta| < 90
  const up = [R[2][0], R[2][1], R[2][2]]; // earth "up" in device coordinates
  const rollDeg = Math.atan2(-up[0]!, up[2]!) * RAD;
  return { altDeg, headingDeg, rollDeg };
}

/**
 * One raw orientation event -> tube altitude and magnetic heading. Returns null when the event has no angles
 * (desktop browsers fire one empty event). Heading is null when the browser gives no absolute reference.
 */
export function readingFromOrientation(raw: RawOrientation): TubeReading | null {
  if (raw.beta == null || raw.gamma == null || !Number.isFinite(raw.beta) || !Number.isFinite(raw.gamma)) return null;
  const ios = raw.webkitCompassHeading != null && Number.isFinite(raw.webkitCompassHeading) && raw.webkitCompassHeading >= 0;
  let alphaAbs: number | null = null;
  let headingSource: HeadingSource | null = null;
  if (ios) {
    alphaAbs = norm360(360 - raw.webkitCompassHeading!); // iOS heading is clockwise; alpha is counter-clockwise
    headingSource = 'ios-compass';
  } else if (raw.absolute && raw.alpha != null && Number.isFinite(raw.alpha)) {
    alphaAbs = raw.alpha;
    headingSource = 'absolute-alpha';
  }
  const t = tubeFromEuler(alphaAbs ?? raw.alpha ?? 0, raw.beta, raw.gamma);
  const acc = raw.webkitCompassAccuracy;
  return {
    altDeg: t.altDeg,
    magHeadingDeg: alphaAbs == null ? null : t.headingDeg,
    rollDeg: t.rollDeg,
    headingSource,
    accuracyDeg: acc != null && Number.isFinite(acc) ? acc : null,
  };
}

/**
 * Altitude and roll of the tube from a gravity vector in device coordinates (DeviceMotion
 * accelerationIncludingGravity, averaged while still). W3C reports the reaction to gravity (+z = 9.81 when flat,
 * screen up); some iOS versions report the opposite sign: pass `inverted`.
 */
export function tubeFromGravity(g: { x: number; y: number; z: number }, inverted = false): { altDeg: number; rollDeg: number } | null {
  const k = inverted ? -1 : 1;
  const ux = k * g.x, uy = k * g.y, uz = k * g.z;
  const m = Math.hypot(ux, uy, uz);
  if (!(m > 1)) return null; // no gravity: free fall or no sensor
  return { altDeg: Math.asin(Math.max(-1, Math.min(1, uy / m))) * RAD, rollDeg: Math.atan2(-ux, uz) * RAD };
}

/** Circular mean and spread of angles (deg). std is the circular standard deviation sqrt(−2 ln R). */
export function circularMean(anglesDeg: number[]): { meanDeg: number; stdDeg: number; R: number } {
  if (!anglesDeg.length) return { meanDeg: NaN, stdDeg: NaN, R: 0 };
  let s = 0, c = 0;
  for (const a of anglesDeg) {
    s += Math.sin(a * DEG);
    c += Math.cos(a * DEG);
  }
  const R = Math.hypot(s, c) / anglesDeg.length;
  return { meanDeg: norm360(Math.atan2(s, c) * RAD), stdDeg: Math.sqrt(-2 * Math.log(Math.max(1e-12, Math.min(1, R)))) * RAD, R };
}

function meanStd(xs: number[]): { mean: number; std: number } {
  if (!xs.length) return { mean: NaN, std: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  return { mean, std: Math.sqrt(v) };
}

export interface TimedReading extends TubeReading { t: number }

export interface CaptureThresholds {
  /** Max altitude std (deg) for a still tube. */
  maxAltStdDeg: number;
  /** Max heading std (deg) for a steady compass. */
  maxHeadingStdDeg: number;
  /** Minimum samples. */
  minSamples: number;
}
export const DEFAULT_CAPTURE_THRESHOLDS: CaptureThresholds = { maxAltStdDeg: 0.3, maxHeadingStdDeg: 2, minSamples: 10 };

export interface SensorCapture {
  n: number;
  altDeg: number;
  altStdDeg: number;
  rollDeg: number;
  magHeadingDeg: number | null;
  headingStdDeg: number | null;
  /** Worst iOS compass accuracy in the window (deg), or null. */
  accuracyDeg: number | null;
  /** True when the window is usable for Home. */
  ok: boolean;
  /** Why not (moved, compass unsteady, too steep, too few samples, ...). */
  problems: string[];
  /** Non-blocking notes (steep tube, phone rolled, calibrate compass). */
  warnings: string[];
}

/** Robust summary of a few seconds of readings: mean alt, circular mean heading, spreads, and a verdict. */
export function summarizeReadings(readings: TubeReading[], th: CaptureThresholds = DEFAULT_CAPTURE_THRESHOLDS): SensorCapture {
  const problems: string[] = [];
  const warnings: string[] = [];
  const n = readings.length;
  const alt = meanStd(readings.map((r) => r.altDeg));
  const roll = meanStd(readings.map((r) => r.rollDeg));
  const withHeading = readings.filter((r) => r.magHeadingDeg != null);
  const hd = withHeading.length >= Math.max(3, n / 2) ? circularMean(withHeading.map((r) => r.magHeadingDeg!)) : null;
  const accs = readings.map((r) => r.accuracyDeg).filter((a): a is number => a != null);
  const accuracyDeg = accs.length ? (accs.some((a) => a < 0) ? -1 : Math.max(...accs)) : null;

  if (n < th.minSamples) problems.push(`only ${n} sensor readings (need ${th.minSamples})`);
  if (alt.std > th.maxAltStdDeg) problems.push(`the tube moved (altitude spread ${alt.std.toFixed(2)}°): hold it still`);
  if (hd && hd.stdDeg > th.maxHeadingStdDeg) problems.push(`the compass is unsteady (heading spread ${hd.stdDeg.toFixed(1)}°): magnetic interference or movement`);
  if (Math.abs(alt.mean) > MAX_SENSOR_ALT_DEG) problems.push(`the tube is too steep (${alt.mean.toFixed(0)}°): lower it below ${MAX_SENSOR_ALT_DEG}°`);
  else if (Math.abs(alt.mean) > GOOD_HEADING_ALT_DEG) warnings.push(`the tube is steep (${alt.mean.toFixed(0)}°): the compass is more reliable with the tube below ${GOOD_HEADING_ALT_DEG}°`);
  if (Math.abs(roll.mean) > 45) warnings.push(`the phone is rolled ${roll.mean.toFixed(0)}° on the tube: lay it flat on top`);
  if (accuracyDeg != null && (accuracyDeg < 0 || accuracyDeg > 15)) warnings.push('compass accuracy is poor: calibrate it by waving the phone in a figure-8, then put it back');
  if (!hd) warnings.push('no compass heading from this browser: only the altitude is measured');
  return {
    n,
    altDeg: alt.mean,
    altStdDeg: alt.std,
    rollDeg: roll.mean,
    magHeadingDeg: hd ? hd.meanDeg : null,
    headingStdDeg: hd ? hd.stdDeg : null,
    accuracyDeg,
    ok: problems.length === 0,
    problems,
    warnings,
  };
}

/** Readings from the last `windowMs` (for the live stability meter and the capture window). */
export function recentReadings<T extends { t: number }>(readings: T[], now: number, windowMs: number): T[] {
  return readings.filter((r) => r.t >= now - windowMs && r.t <= now);
}

/** Live stability: 0 (moving) .. 1 (rock steady), from the altitude and heading spread over ~1 s. */
export function stabilityScore(readings: TubeReading[]): number {
  if (readings.length < 3) return 0;
  const alt = meanStd(readings.map((r) => r.altDeg)).std;
  const hs = readings.filter((r) => r.magHeadingDeg != null).map((r) => r.magHeadingDeg!);
  const hd = hs.length >= 3 ? circularMean(hs).stdDeg : 0;
  const a = Math.max(0, 1 - alt / DEFAULT_CAPTURE_THRESHOLDS.maxAltStdDeg);
  const h = Math.max(0, 1 - hd / DEFAULT_CAPTURE_THRESHOLDS.maxHeadingStdDeg);
  return Math.min(a, h);
}

/**
 * Heading jumps while the altitude stays put: a sign of magnetic interference (motors running, steel nearby).
 * Returns the largest heading change (deg) between consecutive readings less than `maxGapMs` apart whose
 * altitude changed by less than `altTolDeg`.
 */
export function maxHeadingJump(readings: TimedReading[], maxGapMs = 300, altTolDeg = 0.3): number {
  let worst = 0;
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1]!, b = readings[i]!;
    if (a.magHeadingDeg == null || b.magHeadingDeg == null || b.t - a.t > maxGapMs) continue;
    if (Math.abs(b.altDeg - a.altDeg) > altTolDeg) continue;
    worst = Math.max(worst, Math.abs(norm180(b.magHeadingDeg - a.magHeadingDeg)));
  }
  return worst;
}

/** Magnetic field strength check: measured |B| (µT) vs the WMM total intensity (nT). null = fine/unknown. */
export function fieldStrengthWarning(measuredMicroTesla: number | null, expectedNanoTesla: number): string | null {
  if (measuredMicroTesla == null || !Number.isFinite(measuredMicroTesla)) return null;
  const expected = expectedNanoTesla / 1000;
  const ratio = measuredMicroTesla / expected;
  if (ratio < 0.75 || ratio > 1.25) return `magnetic field ${measuredMicroTesla.toFixed(0)} µT, expected ~${expected.toFixed(0)} µT here: metal or a motor is distorting the compass`;
  return null;
}

/** What alignHome needs: true azimuth / altitude of the tube with 1-sigma uncertainties. */
export interface SensorHome {
  azDeg: number;
  altDeg: number;
  azSigmaDeg: number;
  altSigmaDeg: number;
  magHeadingDeg: number | null;
  declinationDeg: number;
}

/**
 * Capture + declination -> Home. True az = magnetic heading + declination (east positive). Without a compass
 * heading (`magHeadingDeg` null) the user must point the tube north by eye: az 0 with a large uncertainty.
 */
export function sensorHome(c: SensorCapture, declinationDeg: number, noHeadingSigmaDeg = 10): SensorHome {
  const base = Math.max(COMPASS_BASE_SIGMA_DEG, c.accuracyDeg != null && c.accuracyDeg > 0 ? c.accuracyDeg : 0);
  const azSigmaDeg = c.magHeadingDeg == null ? noHeadingSigmaDeg : Math.hypot(base, c.headingStdDeg ?? 0);
  return {
    azDeg: c.magHeadingDeg == null ? 0 : norm360(c.magHeadingDeg + declinationDeg),
    altDeg: c.altDeg,
    azSigmaDeg: round(azSigmaDeg, 2),
    altSigmaDeg: round(Math.hypot(ALT_BASE_SIGMA_DEG, c.altStdDeg), 2),
    magHeadingDeg: c.magHeadingDeg,
    declinationDeg,
  };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** "Expect the first star within ~X°" for a sensor Home: about 2 sigma of the combined error, at least 2°. */
export function expectedFirstStarErrorDeg(home: Pick<AlignmentHome, 'azSigmaDeg' | 'altSigmaDeg' | 'altDeg'> | null | undefined): number | null {
  if (!home || home.azSigmaDeg == null || home.altSigmaDeg == null) return null;
  return Math.max(2, Math.round(2 * Math.hypot(home.azSigmaDeg, home.altSigmaDeg)));
}

/** Tripod level check: phone flat on the mount base. Tilt magnitude (deg) and the direction the base dips toward (device frame). */
export function baseTilt(beta: number, gamma: number): { tiltDeg: number; downhillDeg: number } {
  const R = rotationMatrix(0, beta, gamma);
  const up = [R[2][0], R[2][1], R[2][2]]; // earth up in device coordinates
  const tiltDeg = Math.acos(Math.max(-1, Math.min(1, up[2]!))) * RAD;
  // direction (in the phone's screen plane, clockwise from the top edge) that is lowest
  const downhillDeg = norm360(Math.atan2(-up[0]!, -up[1]!) * RAD);
  return { tiltDeg, downhillDeg };
}
