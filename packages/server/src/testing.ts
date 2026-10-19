// Test helpers: a simple stand-in for the astro/pointing functions and shared fixtures.
import type { GeoLocation, PointingModelParams } from '@stargazer/shared/api.ts';
import { type AstroApi, mod360, wrap180 } from './astroApi.ts';

export const TEST_LOCATION: GeoLocation = { lat: 60, lon: 25, elevation: 0, source: 'manual' };

/**
 * Toy sky: alt-az = (ra + 15″/s · (t − t0), dec), so radec targets drift in azimuth at exactly 15″/s.
 * Pointing model: encoder = sky − (IA, IE). The Sun sits at `sun` (default az 200°, alt −30°, i.e. night).
 */
export function fakeAstro(t0 = Date.now(), sun = { az: 200, alt: -30 }): AstroApi {
  const drift = (t: number) => ((t - t0) / 1000) * (15 / 3600);
  const deg = Math.PI / 180;
  return {
    targetAltAz(t, _loc, time) {
      if (t.kind === 'altaz') return { az: t.az, alt: t.alt };
      if (t.kind === 'body') return t.body === 'Sun' ? { ...sun } : { az: 100, alt: 30 };
      return { az: mod360(t.ra + drift(time)), alt: t.dec };
    },
    altAzToRaDec: (p, _loc, time) => ({ ra: mod360(p.az - drift(time)), dec: p.alt }),
    separation(a, b) {
      const c = Math.sin(a.dec * deg) * Math.sin(b.dec * deg) + Math.cos(a.dec * deg) * Math.cos(b.dec * deg) * Math.cos((a.ra - b.ra) * deg);
      return Math.acos(Math.min(1, Math.max(-1, c))) / deg;
    },
    skyToEncoder: (s, p) => ({ az: mod360(s.az - p.IA), alt: s.alt - p.IE }),
    encoderToSky: (e, p) => ({ az: mod360(e.az + p.IA), alt: e.alt + p.IE }),
    fitModel(obs, initial) {
      const n = obs.length;
      const IA = obs.reduce((s, o) => s + wrap180(o.sky.az - o.encoder.az), 0) / n;
      const IE = obs.reduce((s, o) => s + (o.sky.alt - o.encoder.alt), 0) / n;
      const params: PointingModelParams = { ...(initial ?? { IA: 0, IE: 0, AN: 0, AW: 0, CA: 0, NPAE: 0 }), IA, IE };
      const residualsArcmin = obs.map((o) => Math.hypot(wrap180(o.sky.az - o.encoder.az - IA), o.sky.alt - o.encoder.alt - IE) * 60);
      const rmsArcmin = Math.sqrt(residualsArcmin.reduce((s, r) => s + r * r, 0) / n);
      return { params, solved: ['IA', 'IE'], residualsArcmin, rmsArcmin };
    },
    offsetsFromPoint: (sky, enc, base) => ({ ...(base ?? { IA: 0, IE: 0, AN: 0, AW: 0, CA: 0, NPAE: 0 }), IA: mod360(sky.az - enc.az), IE: sky.alt - enc.alt }),
  };
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
