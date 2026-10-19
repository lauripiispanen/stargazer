// Rise/transit/set for fixed (J2000) objects from LST. Pure, precession ignored (minutes-level accuracy).
const D2R = Math.PI / 180;
export const SIDEREAL_DEG_PER_MS = 360.98564736629 / 86400000;

export interface RiseTransitSet {
  rise: number | null; transit: number; set: number | null; transitAlt: number;
  circumpolar: boolean; neverRises: boolean;
}

/**
 * @param lstDeg local sidereal time (deg) at `time`
 * @param h0 altitude of rise/set (deg), default -0.5667 (refraction at horizon)
 * Returns the transit nearest to `time` (within +-12 sidereal hours) and the rise/set around it.
 */
export function fixedRiseTransitSet(raDeg: number, decDeg: number, latDeg: number, lstDeg: number, time: number, h0 = -0.5667): RiseTransitSet {
  let ha = (((lstDeg - raDeg) % 360) + 540) % 360 - 180; // -180..180, hour angle now
  const transit = time - ha / SIDEREAL_DEG_PER_MS;
  const transitAlt = 90 - Math.abs(latDeg - decDeg);
  const phi = latDeg * D2R, dec = decDeg * D2R;
  const cosH0 = (Math.sin(h0 * D2R) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosH0 < -1) return { rise: null, transit, set: null, transitAlt, circumpolar: true, neverRises: false };
  if (cosH0 > 1) return { rise: null, transit, set: null, transitAlt, circumpolar: false, neverRises: true };
  const H0 = Math.acos(cosH0) / D2R;
  const dt = H0 / SIDEREAL_DEG_PER_MS;
  ha = 0;
  return { rise: transit - dt, transit, set: transit + dt, transitAlt, circumpolar: false, neverRises: false };
}
