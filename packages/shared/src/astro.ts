// Astronomy helpers (isomorphic). Implemented with astronomy-engine.
// All angles in degrees; RA in degrees. Times in ms since epoch.
import * as Astronomy from 'astronomy-engine';
import type { GeoLocation, SolarBody, Target } from './api.ts';

export interface AltAz { az: number; alt: number } // az: N=0, E=90 (0..360). alt: apparent, refraction included.
export interface RaDec { ra: number; dec: number } // J2000

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
/** Speed of light in AU/day (astronomy-engine's velocities are AU/day). */
const C_AUDAY = 173.1446326846693;
/** Sidereal rotation rate in degrees per millisecond of UT. */
const SIDEREAL_DEG_PER_MS = 360.98564736629 / 86400000;
/** Refraction model passed to astronomy-engine. */
const REFRACTION = 'normal';

export const norm360 = (d: number): number => ((d % 360) + 360) % 360;
/** Wrap to (-180, 180]. */
export const norm180 = (d: number): number => {
  const x = norm360(d);
  return x > 180 ? x - 360 : x;
};

type Vec3 = [number, number, number];
type Mat3 = number[][];

const sphToVec = (lonDeg: number, latDeg: number): Vec3 => {
  const cl = Math.cos(latDeg * DEG);
  return [cl * Math.cos(lonDeg * DEG), cl * Math.sin(lonDeg * DEG), Math.sin(latDeg * DEG)];
};
const vecToSph = (v: Vec3): { lon: number; lat: number } => {
  const r = Math.hypot(v[0], v[1], v[2]);
  return { lon: norm360(Math.atan2(v[1], v[0]) * RAD), lat: Math.asin(Math.max(-1, Math.min(1, v[2] / r))) * RAD };
};
const mulMV = (m: Mat3, v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
const mulMtV = (m: Mat3, v: Vec3): Vec3 => [
  m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
  m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
  m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
];

// ---------------------------------------------------------------------------
// Time-dependent frame data, cached per minute. Precession/nutation and the
// Earth's velocity change negligibly within a minute (< 0.001"), and sidereal
// time is advanced exactly from the bucket start, so this is accurate while
// making per-object conversions cost only a few multiplications.
// ---------------------------------------------------------------------------
interface FrameData {
  t0: number;
  /** J2000 (EQJ) -> true equator and equinox of date (EQD); astronomy-engine stores it column-major. */
  eqjToEqd: Mat3;
  /** Earth's barycentric velocity / c, in EQJ. */
  beta: Vec3;
  /** Greenwich apparent sidereal time at t0, degrees. */
  gast0: number;
}
const BUCKET_MS = 60_000;
const frameCache = new Map<number, FrameData>();

function frameData(time: number): FrameData {
  const key = Math.floor(time / BUCKET_MS);
  let f = frameCache.get(key);
  if (f) return f;
  const t0 = key * BUCKET_MS;
  const at = Astronomy.MakeTime(new Date(t0));
  const rot = Astronomy.Rotation_EQJ_EQD(at).rot;
  // astronomy-engine: rotated[i] = sum_j rot[j][i] * v[j]; transpose into row-major.
  const eqjToEqd: Mat3 = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rot[j][i]));
  const s = Astronomy.BaryState(Astronomy.Body.Earth, at);
  f = {
    t0,
    eqjToEqd,
    beta: [s.vx / C_AUDAY, s.vy / C_AUDAY, s.vz / C_AUDAY],
    gast0: Astronomy.SiderealTime(at) * 15,
  };
  if (frameCache.size > 256) frameCache.clear();
  frameCache.set(key, f);
  return f;
}

/** Apply annual aberration (first order is accurate to ~0.001") to a unit vector. */
function aberrate(u: Vec3, b: Vec3): Vec3 {
  const v: Vec3 = [u[0] + b[0], u[1] + b[1], u[2] + b[2]];
  const r = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / r, v[1] / r, v[2] / r];
}
/** Inverse of aberrate: solve u from u' (fixed-point, 2 iterations is plenty). */
function unaberrate(up: Vec3, b: Vec3): Vec3 {
  let u = up;
  for (let i = 0; i < 3; i++) {
    const a = aberrate(u, b);
    u = [u[0] + up[0] - a[0], u[1] + up[1] - a[1], u[2] + up[2] - a[2]];
    const r = Math.hypot(u[0], u[1], u[2]);
    u = [u[0] / r, u[1] / r, u[2] / r];
  }
  return u;
}

/** Refraction correction (deg, >= 0) for a geometric altitude. */
export function refractionDeg(geometricAlt: number): number {
  return Astronomy.Refraction(REFRACTION, Math.max(-90, Math.min(90, geometricAlt)));
}

/**
 * A precomputed observer+time frame for fast batch conversions (e.g. ranking
 * thousands of objects or rendering). All conversions are J2000 <-> refracted alt-az.
 */
export interface SkyFrame {
  time: number;
  lat: number;
  lon: number;
  /** Local apparent sidereal time, degrees. */
  lst: number;
  toAltAz(p: RaDec): AltAz;
  /** Same as toAltAz but without refraction (geometric altitude). */
  toAltAzGeometric(p: RaDec): AltAz;
  toRaDec(p: AltAz): RaDec;
  /** J2000 RA/Dec -> apparent RA/Dec of date (precession, nutation, aberration). */
  toApparentOfDate(p: RaDec): RaDec;
}

export function skyFrame(loc: GeoLocation, time: number): SkyFrame {
  const f = frameData(time);
  const lst = norm360(f.gast0 + (time - f.t0) * SIDEREAL_DEG_PER_MS + loc.lon);
  const phi = loc.lat * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);

  const apparentVec = (p: RaDec): Vec3 => mulMV(f.eqjToEqd, aberrate(sphToVec(p.ra, p.dec), f.beta));

  const geometric = (p: RaDec): AltAz => {
    const v = apparentVec(p);
    const { lon: raD, lat: dec } = vecToSph(v);
    const h = (lst - raD) * DEG;
    const d = dec * DEG;
    const sinAlt = sinPhi * Math.sin(d) + cosPhi * Math.cos(d) * Math.cos(h);
    const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * RAD;
    const az = norm360(Math.atan2(-Math.cos(d) * Math.sin(h), Math.sin(d) * cosPhi - Math.cos(d) * sinPhi * Math.cos(h)) * RAD);
    return { az, alt };
  };

  return {
    time,
    lat: loc.lat,
    lon: loc.lon,
    lst,
    toAltAzGeometric: geometric,
    toAltAz(p) {
      const g = geometric(p);
      return { az: g.az, alt: g.alt + refractionDeg(g.alt) };
    },
    toApparentOfDate(p) {
      const { lon, lat } = vecToSph(apparentVec(p));
      return { ra: lon, dec: lat };
    },
    toRaDec(p) {
      const alt = (p.alt + Astronomy.InverseRefraction(REFRACTION, Math.max(-90, Math.min(90, p.alt)))) * DEG;
      const az = p.az * DEG;
      // Horizon -> hour angle / declination of date.
      const sinDec = sinPhi * Math.sin(alt) + cosPhi * Math.cos(alt) * Math.cos(az);
      const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
      const h = Math.atan2(-Math.cos(alt) * Math.sin(az), Math.sin(alt) * cosPhi - Math.cos(alt) * sinPhi * Math.cos(az));
      const raDate = lst - h * RAD;
      const vDate = sphToVec(raDate, dec * RAD);
      const u = unaberrate(mulMtV(f.eqjToEqd, vDate), f.beta);
      const { lon, lat } = vecToSph(u);
      return { ra: lon, dec: lat };
    },
  };
}

/** J2000 RA/Dec -> topocentric apparent alt-az with refraction. */
export function raDecToAltAz(p: RaDec, loc: GeoLocation, time: number): AltAz {
  return skyFrame(loc, time).toAltAz(p);
}
/** Inverse of raDecToAltAz (refraction removed). */
export function altAzToRaDec(p: AltAz, loc: GeoLocation, time: number): RaDec {
  return skyFrame(loc, time).toRaDec(p);
}

export const observerOf = (loc: GeoLocation): Astronomy.Observer => new Astronomy.Observer(loc.lat, loc.lon, loc.elevation ?? 0);
export const bodyOf = (b: SolarBody): Astronomy.Body => b as unknown as Astronomy.Body;

/** Astrometric topocentric J2000 position: light-time corrected, no aberration (raDecToAltAz adds it). */
function bodyAstrometric(body: SolarBody, loc: GeoLocation, time: number): { ra: number; dec: number; dist: number } {
  const eq = Astronomy.Equator(bodyOf(body), new Date(time), observerOf(loc), false, false);
  return { ra: norm360(eq.ra * 15), dec: eq.dec, dist: eq.dist };
}

/** J2000 (astrometric) RA/Dec of a solar-system body as seen from loc (topocentric). */
export function bodyRaDec(body: SolarBody, loc: GeoLocation, time: number): RaDec & { mag: number; distanceAu: number } {
  const date = new Date(time);
  const eq = bodyAstrometric(body, loc, time);
  let mag: number;
  try {
    mag = Astronomy.Illumination(bodyOf(body), date).mag;
  } catch {
    mag = NaN;
  }
  return { ra: eq.ra, dec: eq.dec, mag, distanceAu: eq.dist };
}

/** Resolve any Target to apparent alt-az at time. */
export function targetAltAz(t: Target, loc: GeoLocation, time: number): AltAz {
  switch (t.kind) {
    case 'radec':
      return raDecToAltAz(t, loc, time);
    case 'body':
      return raDecToAltAz(bodyAstrometric(t.body, loc, time), loc, time);
    case 'altaz':
      return { az: norm360(t.az), alt: t.alt };
  }
}

/** J2000 RA/Dec of any Target at time (for 'altaz' targets: the sky position currently in that direction). */
export function targetRaDec(t: Target, loc: GeoLocation, time: number): RaDec {
  switch (t.kind) {
    case 'radec':
      return { ra: t.ra, dec: t.dec };
    case 'body': {
      const b = bodyAstrometric(t.body, loc, time);
      return { ra: b.ra, dec: b.dec };
    }
    case 'altaz':
      return altAzToRaDec(t, loc, time);
  }
}

/** Angular separation in degrees between two RA/Dec (or az/alt treated as lon/lat). */
export function separation(a: RaDec, b: RaDec): number {
  // Vincenty formula: well-conditioned at all separations.
  const d1 = a.dec * DEG;
  const d2 = b.dec * DEG;
  const dra = (b.ra - a.ra) * DEG;
  const num = Math.hypot(Math.cos(d2) * Math.sin(dra), Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(dra));
  const den = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(dra);
  return Math.atan2(num, den) * RAD;
}
/** Separation of two alt-az directions in degrees. */
export const separationAltAz = (a: AltAz, b: AltAz): number => separation({ ra: a.az, dec: a.alt }, { ra: b.az, dec: b.alt });

/** Local (apparent) sidereal time in degrees. */
export function localSiderealDeg(loc: GeoLocation, time: number): number {
  const f = frameData(time);
  return norm360(f.gast0 + (time - f.t0) * SIDEREAL_DEG_PER_MS + loc.lon);
}

const DAY_MS = 86400000;
const toMs = (t: Astronomy.AstroTime | null): number | null => (t ? t.date.getTime() : null);

/** Geometric+refracted altitude of the Sun (deg). */
export function sunAltitude(loc: GeoLocation, time: number): number {
  return targetAltAz({ kind: 'body', body: 'Sun', name: 'Sun' }, loc, time).alt;
}

export interface TwilightTimes { sunset: number | null; sunrise: number | null; astroDusk: number | null; astroDawn: number | null }

/**
 * Twilight times for "tonight": if `time` is during the day, the coming night;
 * if it is already night, the current night (so sunset/astroDusk may be in the past).
 * Null when the event does not occur (midnight sun, polar night, no astronomical darkness).
 */
export function twilight(loc: GeoLocation, time: number): TwilightTimes {
  const n = nightEvents(loc, time, -18);
  return { sunset: n.sunset, sunrise: n.sunrise, astroDusk: n.dusk, astroDawn: n.dawn };
}

/**
 * Generic night events for a given solar depression (e.g. -18 astro, -12 nautical, -6 civil).
 * Same "tonight" semantics as twilight().
 */
export function nightEvents(loc: GeoLocation, time: number, sunAlt: number): { sunset: number | null; sunrise: number | null; dusk: number | null; dawn: number | null } {
  const obs = observerOf(loc);
  const date = new Date(time);
  // Anchor: during the day, now. At night, just before the most recent sunset (if within a day).
  let anchor = time;
  if (sunAltitude(loc, time) < -0.833) {
    const prevSet = Astronomy.SearchRiseSet(Astronomy.Body.Sun, obs, -1, date, -1);
    if (prevSet) anchor = prevSet.date.getTime() - 60_000;
  }
  const a = new Date(anchor);
  const sunset = toMs(Astronomy.SearchRiseSet(Astronomy.Body.Sun, obs, -1, a, 1));
  const sunriseT = Astronomy.SearchRiseSet(Astronomy.Body.Sun, obs, +1, new Date(sunset ?? anchor), sunset ? 1 : 1.5);
  const sunrise = toMs(sunriseT);
  const end = sunrise ?? anchor + 1.5 * DAY_MS;
  let dusk = toMs(Astronomy.SearchAltitude(Astronomy.Body.Sun, obs, -1, a, 1.5, sunAlt));
  if (dusk !== null && dusk > end) dusk = null;
  let dawn: number | null = null;
  if (dusk !== null) {
    dawn = toMs(Astronomy.SearchAltitude(Astronomy.Body.Sun, obs, +1, new Date(dusk), 1, sunAlt));
    if (dawn !== null && dawn > end + 60_000) dawn = null;
  } else if (sunAltitude(loc, anchor) < sunAlt) {
    // Polar night deeper than sunAlt at the anchor: darkness already running.
    dawn = toMs(Astronomy.SearchAltitude(Astronomy.Body.Sun, obs, +1, a, 1, sunAlt));
  }
  return { sunset, sunrise, dusk, dawn };
}

export interface MoonInfo { phase: number /*0..1 illuminated*/; phaseName: string; rise: number | null; set: number | null; altAz: AltAz }

const PHASE_NAMES = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];

/** Moon phase and its current (if up) or next up-period: rise <= set. */
export function moonInfo(loc: GeoLocation, time: number): MoonInfo {
  const date = new Date(time);
  const obs = observerOf(loc);
  const phase = Astronomy.Illumination(Astronomy.Body.Moon, date).phase_fraction;
  const angle = Astronomy.MoonPhase(date); // 0 new, 90 first quarter, 180 full, 270 last quarter
  const phaseName = PHASE_NAMES[Math.floor(norm360(angle + 22.5) / 45) % 8];
  const altAz = targetAltAz({ kind: 'body', body: 'Moon', name: 'Moon' }, loc, time);
  let rise: number | null;
  let set: number | null;
  if (altAz.alt > -0.5) {
    rise = toMs(Astronomy.SearchRiseSet(Astronomy.Body.Moon, obs, +1, date, -1.2));
    set = toMs(Astronomy.SearchRiseSet(Astronomy.Body.Moon, obs, -1, date, 1.2));
  } else {
    rise = toMs(Astronomy.SearchRiseSet(Astronomy.Body.Moon, obs, +1, date, 1.2));
    set = toMs(Astronomy.SearchRiseSet(Astronomy.Body.Moon, obs, -1, new Date(rise ?? time), 1.2));
  }
  return { phase, phaseName, rise, set, altAz };
}
