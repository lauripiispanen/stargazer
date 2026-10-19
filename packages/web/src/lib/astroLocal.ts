// Local astronomy helpers not provided by packages/shared (used only via astroAdapter.ts):
// the J2000 -> horizon rotation matrix for the GPU renderer, cheap illumination, body rise/transit/set.
import * as A from 'astronomy-engine';
import type { GeoLocation, SolarBody } from '@stargazer/shared/api.ts';

const observerCache = new Map<string, A.Observer>();
export function observer(loc: GeoLocation): A.Observer {
  const k = `${loc.lat},${loc.lon},${loc.elevation}`;
  let o = observerCache.get(k);
  if (!o) { if (observerCache.size > 16) observerCache.clear(); o = new A.Observer(loc.lat, loc.lon, loc.elevation || 0); observerCache.set(k, o); }
  return o;
}

/**
 * Row-major 3x3 matrix taking J2000 equatorial unit vectors to the renderer's WORLD frame
 * (x = East, y = Zenith, z = South; i.e. North = -z), *without* refraction. Includes precession,
 * nutation and Earth rotation (astronomy-engine Rotation_EQJ_HOR).
 */
export function eqj2000ToWorldMatrix(loc: GeoLocation, time: number): number[] {
  const rot = A.Rotation_EQJ_HOR(A.MakeTime(new Date(time)), observer(loc)).rot;
  // astronomy-engine: out_i = sum_j rot[j][i] * v_j ; HOR = (x North, y West, z Zenith)
  const hor = (i: number) => [rot[0][i], rot[1][i], rot[2][i]]; // row i of the HOR matrix
  const N = hor(0), W = hor(1), Z = hor(2);
  return [-W[0], -W[1], -W[2], Z[0], Z[1], Z[2], -N[0], -N[1], -N[2]];
}

export function bodyRiseTransitSet(body: SolarBody, loc: GeoLocation, time: number): { rise: number | null; transit: number | null; set: number | null; transitAlt: number | null } {
  const obs = observer(loc);
  const start = new Date(time - 12 * 3600e3);
  try {
    const rise = A.SearchRiseSet(body as A.Body, obs, +1, start, 1.5);
    const set = A.SearchRiseSet(body as A.Body, obs, -1, rise ? rise.date : start, 1.5);
    const tr = A.SearchHourAngle(body as A.Body, obs, 0, rise ? rise.date : start, +1);
    return { rise: rise?.date.getTime() ?? null, set: set?.date.getTime() ?? null, transit: tr.time.date.getTime(), transitAlt: tr.hor.altitude };
  } catch {
    return { rise: null, transit: null, set: null, transitAlt: null };
  }
}

/** Illuminated fraction and apparent magnitude (cheap; no searches). */
export function illumination(body: SolarBody, time: number): { phase: number; mag: number } {
  try { const i = A.Illumination(body as A.Body, new Date(time)); return { phase: i.phase_fraction, mag: i.mag }; }
  catch { return { phase: 1, mag: 0 }; }
}
