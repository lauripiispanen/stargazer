import { describe, expect, it } from 'vitest';
import { Projector, altAzToWorld, mulMat3, raDecToVec, refractWorld, unrefractWorld, worldToAltAz, type Vec3 } from './projection.ts';
import { eqj2000ToWorldMatrix, raDecToAltAz, separation } from '../lib/astroAdapter.ts';
import type { GeoLocation } from '@stargazer/shared/api.ts';

const loc: GeoLocation = { lat: 52, lon: 13, elevation: 0, source: 'manual' };
const T = Date.UTC(2026, 9, 18, 21, 0, 0);

describe('world frame', () => {
  it('alt-az <-> world round trip and conventions', () => {
    const n = altAzToWorld(0, 0), e = altAzToWorld(90, 0), z = altAzToWorld(123, 90);
    expect(n[2]).toBeCloseTo(-1); expect(e[0]).toBeCloseTo(1); expect(z[1]).toBeCloseTo(1);
    const aa = worldToAltAz(altAzToWorld(250, 33));
    expect(aa.az).toBeCloseTo(250); expect(aa.alt).toBeCloseTo(33);
  });
  it('refraction lifts low objects and inverts', () => {
    const v = altAzToWorld(10, 0.5);
    const r = refractWorld([...v] as Vec3);
    expect(worldToAltAz(r).alt - 0.5).toBeGreaterThan(0.3);
    const back = worldToAltAz(unrefractWorld(r));
    expect(back.alt).toBeCloseTo(0.5, 3);
  });
  it('GPU frame matrix + refraction matches shared raDecToAltAz (within aberration, < 1′)', () => {
    const M = eqj2000ToWorldMatrix(loc, T);
    for (const [ra, dec] of [[0, 0], [83.8, -5.4], [279.2, 38.8], [37.9, 89.3], [200, -20], [310, 45]]) {
      const shared = raDecToAltAz({ ra, dec }, loc, T);
      if (shared.alt < 2) continue; // refraction formulas diverge right at the horizon
      const mine = worldToAltAz(refractWorld(mulMat3(M, raDecToVec(ra, dec))));
      const sep = separation({ ra: mine.az, dec: mine.alt }, { ra: shared.az, dec: shared.alt });
      expect(sep * 60).toBeLessThan(1);
    }
  });
});

describe('Projector', () => {
  it('projects the view centre to the screen centre and unprojects back', () => {
    const p = new Projector();
    p.update(1000, 800, 135, 40, 60);
    const s: [number, number] = [0, 0];
    expect(p.project(altAzToWorld(135, 40), s)).toBe(true);
    expect(s[0]).toBeCloseTo(500); expect(s[1]).toBeCloseTo(400);
    // higher altitude is up on screen, larger azimuth is to the right
    p.project(altAzToWorld(135, 45), s); expect(s[1]).toBeLessThan(400);
    p.project(altAzToWorld(140, 40), s); expect(s[0]).toBeGreaterThan(500);
    const w = p.unproject(123, 456); p.project(w, s);
    expect(s[0]).toBeCloseTo(123); expect(s[1]).toBeCloseTo(456);
    expect(p.project(altAzToWorld(315, -40), s)).toBe(false); // behind
  });
  it('pixels per degree follows the FOV', () => {
    const p = new Projector(); p.update(1000, 800, 0, 0, 10);
    expect(p.pxPerDeg()).toBeCloseTo(400 / Math.tan((5 * Math.PI) / 180) * Math.PI / 180, 3);
  });
});
