// Astronomy helpers (isomorphic). Implemented with astronomy-engine.
// All angles in degrees; RA in degrees. Times in ms since epoch.
import type { GeoLocation, SolarBody, Target } from './api.ts';

export interface AltAz { az: number; alt: number } // az: N=0, E=90 (0..360). alt: apparent, refraction included.
export interface RaDec { ra: number; dec: number } // J2000

/** J2000 RA/Dec -> topocentric apparent alt-az with refraction. */
export function raDecToAltAz(_p: RaDec, _loc: GeoLocation, _time: number): AltAz { throw new Error('TODO'); }
/** Inverse of raDecToAltAz (refraction removed). */
export function altAzToRaDec(_p: AltAz, _loc: GeoLocation, _time: number): RaDec { throw new Error('TODO'); }
/** J2000 (astrometric) RA/Dec of a solar-system body as seen from loc (topocentric). */
export function bodyRaDec(_body: SolarBody, _loc: GeoLocation, _time: number): RaDec & { mag: number; distanceAu: number } { throw new Error('TODO'); }
/** Resolve any Target to apparent alt-az at time. */
export function targetAltAz(_t: Target, _loc: GeoLocation, _time: number): AltAz { throw new Error('TODO'); }
/** Angular separation in degrees between two RA/Dec (or az/alt treated as lon/lat). */
export function separation(_a: RaDec, _b: RaDec): number { throw new Error('TODO'); }
/** Local sidereal time in degrees. */
export function localSiderealDeg(_loc: GeoLocation, _time: number): number { throw new Error('TODO'); }
export interface TwilightTimes { sunset: number | null; sunrise: number | null; astroDusk: number | null; astroDawn: number | null }
export function twilight(_loc: GeoLocation, _time: number): TwilightTimes { throw new Error('TODO'); }
export interface MoonInfo { phase: number /*0..1 illuminated*/; phaseName: string; rise: number | null; set: number | null; altAz: AltAz }
export function moonInfo(_loc: GeoLocation, _time: number): MoonInfo { throw new Error('TODO'); }
