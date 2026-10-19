// Injectable facade over the shared astronomy and pointing-model functions, so mount logic can be
// tested with simple stand-ins (and keeps working the moment the real implementations land).
import type { GeoLocation, PointingModelParams, Target } from '@stargazer/shared/api.ts';
import * as astro from '@stargazer/shared/astro.ts';
import type { AltAz, RaDec } from '@stargazer/shared/astro.ts';
import * as pointing from '@stargazer/shared/pointing.ts';
import type { FitResult, Observation } from '@stargazer/shared/pointing.ts';

export interface AstroApi {
  targetAltAz(t: Target, loc: GeoLocation, time: number): AltAz;
  altAzToRaDec(p: AltAz, loc: GeoLocation, time: number): RaDec;
  separation(a: RaDec, b: RaDec): number;
  skyToEncoder(sky: AltAz, p: PointingModelParams): { az: number; alt: number };
  encoderToSky(enc: { az: number; alt: number }, p: PointingModelParams): AltAz;
  fitModel(obs: Observation[], initial?: PointingModelParams): FitResult;
  /** IA/IE that map `sky` exactly onto `encoder`, keeping the other params of `base`. */
  offsetsFromPoint(sky: AltAz, encoder: { az: number; alt: number }, base?: PointingModelParams): PointingModelParams;
}

export const defaultAstro: AstroApi = {
  targetAltAz: (t, loc, time) => astro.targetAltAz(t, loc, time),
  altAzToRaDec: (p, loc, time) => astro.altAzToRaDec(p, loc, time),
  separation: (a, b) => astro.separation(a, b),
  skyToEncoder: (sky, p) => pointing.skyToEncoder(sky, p),
  encoderToSky: (enc, p) => pointing.encoderToSky(enc, p),
  fitModel: (obs, initial) => pointing.fitModel(obs, initial),
  offsetsFromPoint: (sky, enc, base) => pointing.offsetsFromPoint(sky, enc, base),
};

/** Separation of two alt-az directions (deg). */
export const sepAltAz = (astro: AstroApi, a: AltAz, b: AltAz) => astro.separation({ ra: a.az, dec: a.alt }, { ra: b.az, dec: b.alt });

export const mod360 = (d: number) => ((d % 360) + 360) % 360;
export const wrap180 = (d: number) => mod360(d + 180) - 180;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
