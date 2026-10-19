import { describe, expect, it } from 'vitest';
import * as Astronomy from 'astronomy-engine';
import type { GeoLocation, SolarBody } from './api.ts';
import {
  altAzToRaDec, bodyRaDec, localSiderealDeg, moonInfo, raDecToAltAz, separation, skyFrame,
  targetAltAz, twilight,
} from './astro.ts';

const helsinki: GeoLocation = { lat: 60.17, lon: 24.94, elevation: 20, source: 'manual' };
const sydney: GeoLocation = { lat: -33.87, lon: 151.21, elevation: 50, source: 'manual' };
const T = Date.UTC(2026, 9, 18, 20, 0, 0); // 2026-10-18 20:00 UTC
const ARCSEC = 1 / 3600;

const VEGA = { ra: 279.23473479, dec: 38.78368896 };
const POLARIS = { ra: 37.95456067, dec: 89.26410897 };
const SIRIUS = { ra: 101.28715533, dec: -16.71611586 };

/** Reference: astronomy-engine's own star pipeline (apparent of date + aberration + Horizon refraction). */
function reference(p: { ra: number; dec: number }, loc: GeoLocation, time: number) {
  Astronomy.DefineStar(Astronomy.Body.Star1, p.ra / 15, p.dec, 1000);
  const obs = new Astronomy.Observer(loc.lat, loc.lon, loc.elevation);
  const eq = Astronomy.Equator(Astronomy.Body.Star1, new Date(time), obs, true, true);
  const hor = Astronomy.Horizon(new Date(time), obs, eq.ra, eq.dec, 'normal');
  return { az: hor.azimuth, alt: hor.altitude };
}

const angDiff = (a: { az: number; alt: number }, b: { az: number; alt: number }) =>
  separation({ ra: a.az, dec: a.alt }, { ra: b.az, dec: b.alt });

describe('raDecToAltAz', () => {
  it('matches astronomy-engine Horizon for Vega, Polaris, Sirius at several places/times (< 1.5")', () => {
    for (const loc of [helsinki, sydney, { lat: 0, lon: -70, elevation: 0, source: 'manual' as const }]) {
      for (const dt of [0, 3.3e6, 2.1e7, 86400000 * 100, -86400000 * 3650]) {
        for (const star of [VEGA, POLARIS, SIRIUS]) {
          const t = T + dt;
          const ours = raDecToAltAz(star, loc, t);
          const ref = reference(star, loc, t);
          if (ref.alt < -1) continue; // refraction model is clamped below the horizon
          expect(angDiff(ours, ref)).toBeLessThan(1.5 * ARCSEC);
        }
      }
    }
  });

  it('gives Polaris altitude close to the latitude', () => {
    for (const lat of [10, 35, 60.17, 75]) {
      const loc: GeoLocation = { lat, lon: 24.94, elevation: 0, source: 'manual' };
      for (let h = 0; h < 24; h += 3) {
        const p = raDecToAltAz(POLARIS, loc, T + h * 3.6e6);
        expect(Math.abs(p.alt - lat)).toBeLessThan(1.0); // Polaris is ~0.7 deg from the pole
        expect(Math.min(p.az, 360 - p.az)).toBeLessThan(1.6 / Math.cos(lat * Math.PI / 180));
      }
    }
  });

  it('known value: Vega from Helsinki at 2026-10-18 20:00 UTC (independent GMST + crude precession estimate)', () => {
    // Hand calculation: LST 352.26 deg, Vega RA precessed by ~+0.335 deg -> alt 41.21 (+0.02 refraction), az 278.44.
    const p = raDecToAltAz(VEGA, helsinki, T);
    expect(Math.abs(p.alt - 41.22)).toBeLessThan(0.05);
    expect(Math.abs(p.az - 278.44)).toBeLessThan(0.2); // crude estimate ignores nutation and dec precession
  });

  it('round-trips with altAzToRaDec (< 0.01")', () => {
    for (let i = 0; i < 200; i++) {
      const ra = (i * 137.508) % 360;
      const dec = -85 + ((i * 53.3) % 170);
      const t = T + i * 7.7e5;
      const aa = raDecToAltAz({ ra, dec }, helsinki, t);
      if (aa.alt < -1) continue;
      const back = altAzToRaDec(aa, helsinki, t);
      expect(separation(back, { ra, dec })).toBeLessThan(0.01 * ARCSEC);
    }
  });

  it('is fast enough to rank thousands of objects', () => {
    const start = performance.now();
    const f = skyFrame(helsinki, T);
    for (let i = 0; i < 20000; i++) f.toAltAz({ ra: (i * 0.018) % 360, dec: (i % 170) - 85 });
    const perCallFrame = (performance.now() - start) / 20000;
    const start2 = performance.now();
    for (let i = 0; i < 5000; i++) raDecToAltAz(VEGA, helsinki, T + i * 10);
    const perCall = (performance.now() - start2) / 5000;
    expect(perCallFrame).toBeLessThan(0.02); // ms
    expect(perCall).toBeLessThan(0.05); // ms
  });
});

describe('bodies and targets', () => {
  it('targetAltAz for bodies matches astronomy-engine topocentric apparent positions (< 2")', () => {
    const bodies: SolarBody[] = ['Moon', 'Sun', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
    const obs = new Astronomy.Observer(helsinki.lat, helsinki.lon, helsinki.elevation);
    for (const body of bodies) {
      for (const dt of [0, 5e6, 3e7]) {
        const t = T + dt;
        const eq = Astronomy.Equator(body as Astronomy.Body, new Date(t), obs, true, true);
        const hor = Astronomy.Horizon(new Date(t), obs, eq.ra, eq.dec, 'normal');
        if (hor.altitude < -1) continue;
        const ours = targetAltAz({ kind: 'body', body, name: body }, helsinki, t);
        expect(angDiff(ours, { az: hor.azimuth, alt: hor.altitude })).toBeLessThan(2 * ARCSEC);
      }
    }
  });

  it('bodyRaDec returns magnitude and distance', () => {
    const j = bodyRaDec('Jupiter', helsinki, T);
    expect(j.mag).toBeLessThan(-1.5);
    expect(j.distanceAu).toBeGreaterThan(3.9);
    expect(j.distanceAu).toBeLessThan(6.5);
    const m = bodyRaDec('Moon', helsinki, T);
    expect(m.distanceAu * 149597870.7).toBeGreaterThan(350000);
    expect(m.distanceAu * 149597870.7).toBeLessThan(410000);
  });

  it('handles radec and altaz targets', () => {
    expect(targetAltAz({ kind: 'altaz', az: 370, alt: 10, name: 'x' }, helsinki, T)).toEqual({ az: 10, alt: 10 });
    const v = targetAltAz({ kind: 'radec', ...VEGA, name: 'Vega' }, helsinki, T);
    expect(v).toEqual(raDecToAltAz(VEGA, helsinki, T));
  });
});

describe('misc', () => {
  it('separation', () => {
    expect(separation({ ra: 0, dec: 0 }, { ra: 90, dec: 0 })).toBeCloseTo(90, 10);
    expect(separation({ ra: 10, dec: 89 }, { ra: 190, dec: 89 })).toBeCloseTo(2, 10);
    expect(separation({ ra: 359.9, dec: 0 }, { ra: 0.1, dec: 0 })).toBeCloseTo(0.2, 10);
    expect(separation({ ra: 1, dec: 1 }, { ra: 1, dec: 1 })).toBe(0);
    // Vega-Deneb ~ 23.8 deg? Use Vega-Altair ~ 34.2 deg
    expect(separation(VEGA, { ra: 297.6958, dec: 8.8683 })).toBeCloseTo(34.2, 1);
  });

  it('localSiderealDeg matches astronomy-engine and stays continuous across cache buckets', () => {
    const lst = localSiderealDeg(helsinki, T);
    const ref = (Astronomy.SiderealTime(new Date(T)) * 15 + helsinki.lon) % 360;
    expect(Math.abs(lst - ref)).toBeLessThan(1e-6);
    const a = localSiderealDeg(helsinki, Math.floor(T / 60000) * 60000 + 59999);
    const b = localSiderealDeg(helsinki, Math.floor(T / 60000) * 60000 + 60000);
    expect(Math.abs(b - a)).toBeLessThan(1e-5);
  });

  it('twilight in Helsinki in October has astronomical darkness', () => {
    const noon = Date.UTC(2026, 9, 18, 10, 0);
    const tw = twilight(helsinki, noon);
    expect(tw.sunset).not.toBeNull();
    expect(tw.sunset! - noon).toBeGreaterThan(0);
    expect(tw.astroDusk! - tw.sunset!).toBeGreaterThan(1.2 * 3.6e6);
    expect(tw.astroDawn!).toBeGreaterThan(tw.astroDusk!);
    expect(tw.sunrise!).toBeGreaterThan(tw.astroDawn!);
    // Asked at night: same night.
    const tw2 = twilight(helsinki, Date.UTC(2026, 9, 18, 23, 0));
    expect(tw2.sunset).toBe(tw.sunset);
    expect(Math.abs(tw2.astroDawn! - tw.astroDawn!)).toBeLessThan(1000);
  });

  it('twilight in Helsinki at midsummer: no astronomical darkness', () => {
    const tw = twilight(helsinki, Date.UTC(2026, 5, 21, 10, 0));
    expect(tw.sunset).not.toBeNull();
    expect(tw.astroDusk).toBeNull();
    expect(tw.astroDawn).toBeNull();
  });

  it('polar day has no sunset', () => {
    const tromso: GeoLocation = { lat: 78.2, lon: 15.6, elevation: 0, source: 'manual' };
    const tw = twilight(tromso, Date.UTC(2026, 5, 21, 10, 0));
    expect(tw.sunset).toBeNull();
    expect(tw.astroDusk).toBeNull();
  });

  it('moonInfo', () => {
    // 2026-10-26 ~ full moon? check phase consistency against astronomy-engine.
    const m = moonInfo(helsinki, T);
    const ill = Astronomy.Illumination(Astronomy.Body.Moon, new Date(T)).phase_fraction;
    expect(m.phase).toBeCloseTo(ill, 6);
    expect(m.phaseName).toMatch(/Moon|Crescent|Quarter|Gibbous/);
    if (m.rise !== null && m.set !== null) expect(m.set).toBeGreaterThan(m.rise);
    const fullMoon = Astronomy.SearchMoonPhase(180, new Date(T), 40)!.date.getTime();
    expect(moonInfo(helsinki, fullMoon).phaseName).toBe('Full Moon');
    expect(moonInfo(helsinki, fullMoon).phase).toBeGreaterThan(0.98);
  });
});
