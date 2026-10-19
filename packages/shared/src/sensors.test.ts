import { describe, expect, it } from 'vitest';
import {
  baseTilt, circularMean, deviceMatrixForTube, eulerFromMatrix, expectedFirstStarErrorDeg, fieldStrengthWarning, MAX_SENSOR_ALT_DEG,
  maxHeadingJump, readingFromOrientation, rotationMatrix, sensorHome, stabilityScore, summarizeReadings, tubeFromEuler, tubeFromGravity,
  type RawOrientation, type TimedReading, type TubeReading,
} from './sensors.ts';

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Small deterministic PRNG (mulberry32) with a Gaussian. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, gauss: () => Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next()) };
}

/** What Android Chrome's deviceorientationabsolute would report for a phone on a tube at (magAz, alt) rolled by roll. */
function androidEvent(magAz: number, alt: number, roll = 0): RawOrientation {
  const e = eulerFromMatrix(deviceMatrixForTube(magAz, alt, roll));
  return { alpha: e.alpha, beta: e.beta, gamma: e.gamma, absolute: true };
}
/** What iOS Safari would report: alpha relative to an arbitrary start (here offset by 123°), plus webkitCompassHeading. */
function iosEvent(magAz: number, alt: number, roll = 0, accuracy = 10): RawOrientation {
  const e = eulerFromMatrix(deviceMatrixForTube(magAz, alt, roll));
  return { alpha: (e.alpha + 123) % 360, beta: e.beta, gamma: e.gamma, absolute: false, webkitCompassHeading: (360 - e.alpha) % 360, webkitCompassAccuracy: accuracy };
}

describe('rotation matrix and Euler angles', () => {
  it('round-trips W3C Euler angles', () => {
    for (const [a, b, g] of [[0, 0, 0], [30, 20, -10], [350, -40, 60], [180, 70, 5], [90, 10, -80]] as const) {
      const e = eulerFromMatrix(rotationMatrix(a, b, g));
      expect(wrap180(e.alpha - a)).toBeCloseTo(0, 9);
      expect(e.beta).toBeCloseTo(b, 9);
      expect(e.gamma).toBeCloseTo(g, 9);
    }
  });
  it('a phone lying flat with its top edge north has alpha = beta = gamma = 0', () => {
    const e = eulerFromMatrix(deviceMatrixForTube(0, 0, 0));
    expect(e.alpha).toBeCloseTo(0, 9);
    expect(e.beta).toBeCloseTo(0, 9);
    expect(e.gamma).toBeCloseTo(0, 9);
  });
  it('a tube pointing east has alpha = 270 (Android alpha is counter-clockwise)', () => {
    expect(eulerFromMatrix(deviceMatrixForTube(90, 0)).alpha).toBeCloseTo(270, 9);
  });
});

describe('tube direction from orientation', () => {
  it('altitude = beta, heading = 360 − alpha, for any roll', () => {
    for (const roll of [0, 15, -30, 44]) {
      const t = tubeFromEuler(20, 35, roll);
      expect(t.altDeg).toBeCloseTo(35, 9);
      expect(t.headingDeg).toBeCloseTo(340, 9);
      expect(t.rollDeg).toBeCloseTo(roll, 9);
    }
  });

  it('recovers synthetic tube directions on Android (deviceorientationabsolute)', () => {
    for (const [az, alt, roll] of [[0, 0, 0], [45, 10, 0], [123.4, 37.5, 25], [271, -4, -20], [359.5, 60, 40], [180, 74, -10]] as const) {
      const r = readingFromOrientation(androidEvent(az, alt, roll))!;
      expect(r.headingSource).toBe('absolute-alpha');
      expect(wrap180(r.magHeadingDeg! - az)).toBeCloseTo(0, 6);
      expect(r.altDeg).toBeCloseTo(alt, 6);
      expect(r.rollDeg).toBeCloseTo(roll, 6);
    }
  });

  it('recovers synthetic tube directions on iOS (webkitCompassHeading; alpha is relative and ignored)', () => {
    for (const [az, alt, roll] of [[10, 5, 0], [200, 30, -15], [300.25, 55, 35]] as const) {
      const r = readingFromOrientation(iosEvent(az, alt, roll))!;
      expect(r.headingSource).toBe('ios-compass');
      expect(wrap180(r.magHeadingDeg! - az)).toBeCloseTo(0, 6);
      expect(r.altDeg).toBeCloseTo(alt, 6);
      expect(r.accuracyDeg).toBe(10);
    }
  });

  it('iOS compass heading is used as-is (clockwise); Android alpha is converted (360 − alpha)', () => {
    expect(readingFromOrientation({ alpha: 0, beta: 0, gamma: 0, webkitCompassHeading: 90 })!.magHeadingDeg).toBeCloseTo(90, 9);
    expect(readingFromOrientation({ alpha: 90, beta: 0, gamma: 0, absolute: true })!.magHeadingDeg).toBeCloseTo(270, 9);
  });

  it('roll does not corrupt the altitude (phone slid sideways on the round tube)', () => {
    const flat = readingFromOrientation(androidEvent(80, 25, 0))!;
    const rolled = readingFromOrientation(androidEvent(80, 25, 40))!;
    expect(rolled.altDeg).toBeCloseTo(flat.altDeg, 9);
    expect(rolled.magHeadingDeg).toBeCloseTo(flat.magHeadingDeg!, 6);
  });

  it('no absolute reference -> altitude only', () => {
    const r = readingFromOrientation({ alpha: 42, beta: 12, gamma: 3, absolute: false })!;
    expect(r.magHeadingDeg).toBeNull();
    expect(r.altDeg).toBeCloseTo(12, 9);
  });

  it('ignores empty events (desktop browsers fire one with nulls)', () => {
    expect(readingFromOrientation({ alpha: null, beta: null, gamma: null })).toBeNull();
  });

  it('altitude from gravity, W3C and inverted (iOS) sign conventions', () => {
    const R = deviceMatrixForTube(0, 30, 20);
    const up = [R[2][0], R[2][1], R[2][2]]; // earth up in device coordinates
    const g = { x: up[0]! * 9.81, y: up[1]! * 9.81, z: up[2]! * 9.81 };
    expect(tubeFromGravity(g)!.altDeg).toBeCloseTo(30, 9);
    expect(tubeFromGravity(g)!.rollDeg).toBeCloseTo(20, 9);
    expect(tubeFromGravity({ x: -g.x, y: -g.y, z: -g.z }, true)!.altDeg).toBeCloseTo(30, 9);
    expect(tubeFromGravity({ x: 0, y: 0, z: 0 })).toBeNull();
  });
});

describe('averaging', () => {
  it('circular mean handles the 359/1 wrap', () => {
    const c = circularMean([358, 359, 0, 1, 2]);
    expect(wrap180(c.meanDeg)).toBeCloseTo(0, 9);
    expect(c.stdDeg).toBeGreaterThan(1);
    expect(c.stdDeg).toBeLessThan(2);
  });

  it('summarises a still capture with noise and accepts it', () => {
    const r = rng(1);
    const readings: TubeReading[] = Array.from({ length: 60 }, () => readingFromOrientation(androidEvent(359 + r.gauss() * 0.8, 20 + r.gauss() * 0.05, 5))!);
    const c = summarizeReadings(readings);
    expect(c.ok).toBe(true);
    expect(Math.abs(wrap180(c.magHeadingDeg! - 359))).toBeLessThan(0.4);
    expect(c.altDeg).toBeCloseTo(20, 1);
    expect(c.headingStdDeg!).toBeGreaterThan(0.5);
    expect(c.headingStdDeg!).toBeLessThan(1.2);
  });

  it('rejects movement and an unsteady compass', () => {
    const moving = Array.from({ length: 30 }, (_, i) => readingFromOrientation(androidEvent(90, 10 + i * 0.1))!);
    expect(summarizeReadings(moving).ok).toBe(false);
    expect(summarizeReadings(moving).problems.join()).toMatch(/moved/);
    const r = rng(2);
    const jumpy = Array.from({ length: 30 }, () => readingFromOrientation(androidEvent(90 + r.gauss() * 6, 10))!);
    expect(summarizeReadings(jumpy).problems.join()).toMatch(/compass/);
  });

  it('refuses a tube steeper than the limit and warns when steep', () => {
    const steep = Array.from({ length: 20 }, () => readingFromOrientation(androidEvent(10, MAX_SENSOR_ALT_DEG + 3))!);
    expect(summarizeReadings(steep).ok).toBe(false);
    const fairlySteep = Array.from({ length: 20 }, () => readingFromOrientation(androidEvent(10, 60))!);
    const c = summarizeReadings(fairlySteep);
    expect(c.ok).toBe(true);
    expect(c.warnings.join()).toMatch(/steep/);
  });

  it('suggests a figure-8 calibration when the iOS compass accuracy is poor', () => {
    const poor = Array.from({ length: 20 }, () => readingFromOrientation(iosEvent(10, 10, 0, 25))!);
    expect(summarizeReadings(poor).warnings.join()).toMatch(/figure-8/);
    const invalid = Array.from({ length: 20 }, () => readingFromOrientation(iosEvent(10, 10, 0, -1))!);
    expect(summarizeReadings(invalid).warnings.join()).toMatch(/figure-8/);
  });

  it('stability score and heading-jump detection', () => {
    const still = Array.from({ length: 10 }, () => readingFromOrientation(androidEvent(45, 10))!);
    expect(stabilityScore(still)).toBeCloseTo(1, 6);
    const timed: TimedReading[] = [0, 100, 200, 300].map((t, i) => ({ ...readingFromOrientation(androidEvent(i === 2 ? 60 : 45, 10))!, t }));
    expect(maxHeadingJump(timed)).toBeCloseTo(15, 6);
  });

  it('field strength sanity check', () => {
    expect(fieldStrengthWarning(52, 52600)).toBeNull();
    expect(fieldStrengthWarning(80, 52600)).toMatch(/distorting/);
    expect(fieldStrengthWarning(null, 52600)).toBeNull();
  });
});

describe('sensor Home', () => {
  it('true azimuth = magnetic heading + declination, with uncertainties', () => {
    const readings = Array.from({ length: 30 }, () => readingFromOrientation(androidEvent(355, 15))!);
    const h = sensorHome(summarizeReadings(readings), 10.5);
    expect(h.azDeg).toBeCloseTo(5.5, 6);
    expect(h.altDeg).toBeCloseTo(15, 6);
    expect(h.azSigmaDeg).toBeGreaterThanOrEqual(5);
    expect(h.altSigmaDeg).toBeGreaterThanOrEqual(0.5);
    expect(h.altSigmaDeg).toBeLessThan(1);
    // west declination (Boston ~ −14°)
    expect(sensorHome(summarizeReadings(readings), -14).azDeg).toBeCloseTo(341, 6);
  });

  it('without a compass heading: az 0 (pointed north by eye) with a large sigma', () => {
    const readings = Array.from({ length: 20 }, () => readingFromOrientation({ alpha: 10, beta: 5, gamma: 0 })!);
    const h = sensorHome(summarizeReadings(readings), 10);
    expect(h.azDeg).toBe(0);
    expect(h.azSigmaDeg).toBe(10);
  });

  it('expected first-star error is about 2 sigma', () => {
    expect(expectedFirstStarErrorDeg({ azSigmaDeg: 5, altSigmaDeg: 0.5, altDeg: 10 })).toBe(10);
    expect(expectedFirstStarErrorDeg({ azSigmaDeg: 0.5, altSigmaDeg: 0.2, altDeg: 10 })).toBe(2);
    expect(expectedFirstStarErrorDeg(null)).toBeNull();
  });
});

describe('tripod level check', () => {
  it('flat base = 0 tilt; top edge raised dips toward the bottom edge', () => {
    expect(baseTilt(0, 0).tiltDeg).toBeCloseTo(0, 9);
    const t = baseTilt(2, 0);
    expect(t.tiltDeg).toBeCloseTo(2, 9);
    expect(t.downhillDeg).toBeCloseTo(180, 6);
    expect(baseTilt(1, 1).tiltDeg).toBeCloseTo(Math.SQRT2, 2);
  });
});
