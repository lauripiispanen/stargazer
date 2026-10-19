import { describe, expect, it } from 'vitest';
import type { PointingModelParams } from './api.ts';
import type { AltAz } from './astro.ts';
import { separation } from './astro.ts';
import { encoderToSky, fitModel, offsetsFromPoint, skyToEncoder, ZERO_PARAMS, type Observation } from './pointing.ts';

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const uniform = (lo: number, hi: number) => lo + (hi - lo) * next();
  const gauss = () => Math.sqrt(-2 * Math.log(next() || 1e-12)) * Math.cos(2 * Math.PI * next());
  return { next, uniform, gauss };
}

const ARCSEC = 1 / 3600;
const ARCMIN = 1 / 60;
const sepAA = (a: AltAz, b: AltAz) => separation({ ra: a.az, dec: a.alt }, { ra: b.az, dec: b.alt });
const azDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

function randomParams(r: ReturnType<typeof rng>, full = true): PointingModelParams {
  return {
    IA: r.uniform(0, 360),
    IE: r.uniform(-30, 30),
    AN: r.uniform(-2, 2),
    AW: r.uniform(-2, 2),
    CA: full ? r.uniform(-0.5, 0.5) : 0,
    NPAE: full ? r.uniform(-0.3, 0.3) : 0,
  };
}

function observe(sky: AltAz, hidden: PointingModelParams, r?: ReturnType<typeof rng>, noiseArcmin = 0): Observation {
  const enc = skyToEncoder(sky, hidden);
  if (r && noiseArcmin > 0) {
    enc.az += (r.gauss() * noiseArcmin * ARCMIN) / Math.cos((sky.alt * Math.PI) / 180);
    enc.alt += r.gauss() * noiseArcmin * ARCMIN;
  }
  return { sky, encoder: enc };
}

/** Max sky error (deg) predicting `n` fresh random stars with the fitted model. */
function predictionError(fit: PointingModelParams, hidden: PointingModelParams, r: ReturnType<typeof rng>, altRange: [number, number] = [20, 75], n = 50): number {
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const sky = { az: r.uniform(0, 360), alt: r.uniform(...altRange) };
    const enc = skyToEncoder(sky, hidden); // where the mount really is when looking at `sky`
    worst = Math.max(worst, sepAA(encoderToSky(enc, fit), sky));
    // GoTo direction too: commanded encoder for `sky` should land on `sky`.
    const landed = encoderToSky(skyToEncoder(sky, fit), hidden);
    worst = Math.max(worst, sepAA(landed, sky));
  }
  return worst;
}

describe('forward / inverse model', () => {
  it('round-trips sky -> encoder -> sky < 0.1" for large random params', () => {
    const r = rng(1);
    for (let k = 0; k < 2000; k++) {
      const p = randomParams(r);
      const sky = { az: r.uniform(0, 360), alt: r.uniform(-10, 88) };
      const back = encoderToSky(skyToEncoder(sky, p), p);
      expect(sepAA(back, sky)).toBeLessThan(0.1 * ARCSEC);
    }
  });

  it('round-trips encoder -> sky -> encoder', () => {
    const r = rng(2);
    for (let k = 0; k < 1000; k++) {
      const p = randomParams(r);
      const sky = encoderToSky({ az: r.uniform(0, 360), alt: r.uniform(-10, 80) - p.IE }, p);
      const enc = skyToEncoder(sky, p);
      const back = skyToEncoder(encoderToSky(enc, p), p);
      expect(azDiff(back.az, enc.az) * Math.cos(((enc.alt + p.IE) * Math.PI) / 180)).toBeLessThan(0.1 * ARCSEC);
      expect(Math.abs(back.alt - enc.alt)).toBeLessThan(0.1 * ARCSEC);
    }
  });

  it('zero params is the identity; IA/IE are the sky position of encoder zero', () => {
    expect(skyToEncoder({ az: 123.4, alt: 45.6 }, ZERO_PARAMS)).toEqual({ az: expect.closeTo(123.4, 10), alt: expect.closeTo(45.6, 10) });
    const p = { ...ZERO_PARAMS, IA: 200, IE: 10 };
    const s = encoderToSky({ az: 0, alt: 0 }, p);
    expect(s.az).toBeCloseTo(200, 10);
    expect(s.alt).toBeCloseTo(10, 10);
    const e = skyToEncoder({ az: 10, alt: 30 }, p);
    expect(e.az).toBeCloseTo(170, 10); // wraps into 0..360
    expect(e.alt).toBeCloseTo(20, 10);
  });

  it('AN tilts the azimuth axis toward north, AW toward west', () => {
    // With the axis leaning north, the mount's horizon dips on the north side,
    // so a star due north sits higher above it (and a star due south lower).
    const north = skyToEncoder({ az: 0, alt: 30 }, { ...ZERO_PARAMS, AN: 1 });
    expect(north.alt).toBeCloseTo(31, 6);
    expect(skyToEncoder({ az: 180, alt: 30 }, { ...ZERO_PARAMS, AN: 1 }).alt).toBeCloseTo(29, 6);
    const west = skyToEncoder({ az: 270, alt: 30 }, { ...ZERO_PARAMS, AW: 1 });
    expect(west.alt).toBeCloseTo(31, 6);
  });

  it('offsetsFromPoint makes a point map exactly', () => {
    const base = { ...ZERO_PARAMS, AN: 0.7, AW: -1.2, CA: 0.2 };
    const sky = { az: 300, alt: 40 };
    const enc = { az: 12.3, alt: -5 };
    const p = offsetsFromPoint(sky, enc, base);
    const e = skyToEncoder(sky, p);
    expect(azDiff(e.az, enc.az)).toBeLessThan(1e-9);
    expect(e.alt).toBeCloseTo(enc.alt, 9);
  });
});

describe('fitModel', () => {
  it('no observations returns the initial params', () => {
    const f = fitModel([], { ...ZERO_PARAMS, IA: 5 });
    expect(f.solved).toEqual([]);
    expect(f.params.IA).toBe(5);
  });

  it('1 star solves IA/IE exactly and is a usable rough model', () => {
    const r = rng(3);
    for (let k = 0; k < 50; k++) {
      const hidden = { ...randomParams(r, false), AN: r.uniform(-0.3, 0.3), AW: r.uniform(-0.3, 0.3) };
      const obs = [observe({ az: r.uniform(0, 360), alt: r.uniform(20, 70) }, hidden)];
      const f = fitModel(obs);
      expect(f.solved).toEqual(['IA', 'IE']);
      expect(f.rmsArcmin).toBeLessThan(1e-6);
      // Error elsewhere is bounded by the (unsolved) tilt, roughly 2x |tilt|.
      expect(predictionError(f.params, hidden, r)).toBeLessThan(1.6);
    }
  });

  it('2 stars solve IA, IE, AN, AW (exact for a tilt-only mount)', () => {
    const r = rng(4);
    for (let k = 0; k < 50; k++) {
      const hidden = randomParams(r, false);
      const az1 = r.uniform(0, 360);
      const obs = [
        observe({ az: az1, alt: r.uniform(20, 60) }, hidden),
        observe({ az: az1 + r.uniform(70, 150), alt: r.uniform(20, 60) }, hidden),
      ];
      const f = fitModel(obs);
      expect(f.solved).toEqual(['IA', 'IE', 'AN', 'AW']);
      expect(f.degenerate).toBeUndefined();
      expect(f.rmsArcmin).toBeLessThan(1e-4);
      expect(azDiff(f.params.IA, hidden.IA)).toBeLessThan(1e-4);
      for (const n of ['IE', 'AN', 'AW'] as const) expect(Math.abs(f.params[n] - hidden[n])).toBeLessThan(1e-4);
      expect(predictionError(f.params, hidden, r)).toBeLessThan(1 * ARCSEC);
    }
  });

  it('3 stars add CA', () => {
    const r = rng(5);
    for (let k = 0; k < 30; k++) {
      const hidden = { ...randomParams(r, false), CA: r.uniform(-0.5, 0.5) };
      const obs = [0, 120, 240].map((a, i) => observe({ az: a + r.uniform(-20, 20), alt: [25, 50, 70][i] }, hidden));
      const f = fitModel(obs);
      expect(f.solved).toEqual(['IA', 'IE', 'AN', 'AW', 'CA']);
      expect(Math.abs(f.params.CA - hidden.CA)).toBeLessThan(1e-3);
      expect(predictionError(f.params, hidden, r)).toBeLessThan(2 * ARCSEC);
    }
  });

  it('5 noisy stars recover the full model and predict new stars well', () => {
    const r = rng(6);
    for (let k = 0; k < 30; k++) {
      const hidden = randomParams(r);
      const obs = [0, 72, 144, 216, 288].map((a, i) => observe({ az: a + r.uniform(-15, 15), alt: [20, 35, 50, 62, 74][i] }, hidden, r, 0.3));
      const f = fitModel(obs);
      expect(f.solved).toEqual(['IA', 'IE', 'AN', 'AW', 'CA', 'NPAE']);
      expect(f.rmsArcmin).toBeLessThan(1.5);
      expect(predictionError(f.params, hidden, r)).toBeLessThan(5 * ARCMIN);
    }
  });

  it('recovers random hidden params from many noisy stars (IA anywhere, IE to ±30°, tilts to 2°)', () => {
    const r = rng(7);
    for (let k = 0; k < 40; k++) {
      const hidden = randomParams(r);
      const obs: Observation[] = [];
      for (let i = 0; i < 10; i++) obs.push(observe({ az: r.uniform(0, 360), alt: r.uniform(15, 80) }, hidden, r, 0.5));
      const f = fitModel(obs);
      expect(f.degenerate).toBeUndefined();
      expect(f.rmsArcmin).toBeLessThan(1.5);
      // IA, CA (sec E) and NPAE (tan E) are strongly correlated over 15..80 deg altitude,
      // so individually they are recovered less tightly than the prediction quality suggests.
      expect(azDiff(f.params.IA, hidden.IA)).toBeLessThan(0.3);
      expect(Math.abs(f.params.IE - hidden.IE)).toBeLessThan(0.05);
      expect(Math.abs(f.params.AN - hidden.AN)).toBeLessThan(0.05);
      expect(Math.abs(f.params.AW - hidden.AW)).toBeLessThan(0.05);
      expect(Math.abs(f.params.CA - hidden.CA)).toBeLessThan(0.3);
      expect(Math.abs(f.params.NPAE - hidden.NPAE)).toBeLessThan(0.3);
      expect(predictionError(f.params, hidden, r)).toBeLessThan(3 * ARCMIN);
      expect(f.residualsArcmin).toHaveLength(10);
    }
  });

  it('handles the azimuth wrap (IA near 0/360, encoder az straddling 0)', () => {
    const r = rng(8);
    for (const IA of [0.001, 359.999, 180, 90.5]) {
      const hidden = { IA, IE: -12, AN: 1.1, AW: -0.8, CA: 0.1, NPAE: -0.05 };
      const obs = [350, 5, 100, 200, 280].map((a, i) => observe({ az: a, alt: [30, 60, 25, 45, 70][i] }, hidden, r, 0.2));
      const f = fitModel(obs);
      expect(azDiff(f.params.IA, IA)).toBeLessThan(0.1);
      expect(f.params.IA).toBeGreaterThanOrEqual(0);
      expect(f.params.IA).toBeLessThan(360);
      expect(predictionError(f.params, hidden, r)).toBeLessThan(3 * ARCMIN);
    }
  });

  it('converges from a badly wrong `initial` (re-seeds from the first star)', () => {
    const r = rng(9);
    const hidden = randomParams(r);
    const obs = [10, 100, 190, 280].map((a, i) => observe({ az: a, alt: [25, 45, 65, 35][i] }, hidden));
    const f = fitModel(obs, { ...ZERO_PARAMS, IA: hidden.IA + 170, IE: hidden.IE - 25 });
    expect(f.rmsArcmin).toBeLessThan(0.01);
    expect(predictionError(f.params, hidden, r)).toBeLessThan(1 * ARCSEC);
  });

  it('keeps unsolved params from `initial`', () => {
    const hidden = { IA: 40, IE: 3, AN: 0.5, AW: -0.4, CA: 0, NPAE: 0 };
    const obs = [observe({ az: 100, alt: 40 }, hidden)];
    const f = fitModel(obs, { ...ZERO_PARAMS, AN: 0.5, AW: -0.4 });
    expect(f.params.AN).toBe(0.5);
    expect(predictionError(f.params, hidden, rng(1))).toBeLessThan(1 * ARCSEC);
  });

  it('flags near-degenerate geometry (2 stars at nearly the same azimuth) instead of returning garbage', () => {
    const r = rng(10);
    const hidden = randomParams(r, false);
    const obs = [observe({ az: 120, alt: 40 }, hidden, r, 0.5), observe({ az: 121, alt: 41 }, hidden, r, 0.5)];
    const f = fitModel(obs);
    expect(f.degenerate).toBe(true);
    expect(f.solved).toEqual(['IA', 'IE']);
    expect(f.warnings?.length).toBeGreaterThan(0);
    // Params stay sane: no wild tilts.
    expect(f.params.AN).toBe(0);
    expect(f.params.AW).toBe(0);
  });

  it('flags 4 stars all at the same altitude (CA/NPAE indistinguishable from IA)', () => {
    const r = rng(11);
    const hidden = randomParams(r);
    const obs = [0, 90, 180, 270].map((a) => observe({ az: a, alt: 40 }, hidden, r, 0.3));
    const f = fitModel(obs);
    expect(f.degenerate).toBe(true);
    expect(f.solved).not.toContain('NPAE');
    expect(f.rmsArcmin).toBeLessThan(2);
    // Still predicts well near that altitude.
    expect(predictionError(f.params, hidden, r, [35, 45])).toBeLessThan(5 * ARCMIN);
  });

  it('copes with stars near the zenith', () => {
    const r = rng(12);
    for (let k = 0; k < 20; k++) {
      const hidden = randomParams(r);
      const obs = [
        observe({ az: 30, alt: 87.5 }, hidden, r, 0.3),
        observe({ az: 150, alt: 30 }, hidden, r, 0.3),
        observe({ az: 270, alt: 50 }, hidden, r, 0.3),
        observe({ az: 200, alt: 85 }, hidden, r, 0.3),
        observe({ az: 330, alt: 22 }, hidden, r, 0.3),
        observe({ az: 80, alt: 65 }, hidden, r, 0.3),
      ];
      const f = fitModel(obs);
      for (const v of Object.values(f.params)) expect(Number.isFinite(v)).toBe(true);
      expect(f.rmsArcmin).toBeLessThan(2);
      expect(predictionError(f.params, hidden, r)).toBeLessThan(5 * ARCMIN);
    }
  });

  it('a single zenith star still yields finite offsets', () => {
    const hidden = { IA: 77, IE: 4, AN: 0, AW: 0, CA: 0, NPAE: 0 };
    const f = fitModel([observe({ az: 10, alt: 89.9 }, hidden)]);
    expect(Number.isFinite(f.params.IA)).toBe(true);
    expect(f.rmsArcmin).toBeLessThan(0.01);
  });

  it('is fast (10-star fit well under 50 ms)', () => {
    const r = rng(13);
    const hidden = randomParams(r);
    const obs: Observation[] = [];
    for (let i = 0; i < 10; i++) obs.push(observe({ az: r.uniform(0, 360), alt: r.uniform(15, 80) }, hidden, r, 0.5));
    const t0 = performance.now();
    fitModel(obs);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
