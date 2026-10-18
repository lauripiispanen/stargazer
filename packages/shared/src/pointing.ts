// Alt-az pointing model (PROTOCOL.md §7.2). Pure math, no I/O.
// "sky" = apparent topocentric alt-az (deg); "encoder" = raw mount encoder degrees (az 0..360 wrap, alt signed).
import type { PointingModelParams } from './api.ts';
import type { AltAz } from './astro.ts';

export const ZERO_PARAMS: PointingModelParams = { IA: 0, IE: 0, AN: 0, AW: 0, CA: 0, NPAE: 0 };

export interface Observation { sky: AltAz; encoder: { az: number; alt: number } }
export interface FitResult {
  params: PointingModelParams;
  solved: (keyof PointingModelParams)[];
  residualsArcmin: number[]; // per observation, same order
  rmsArcmin: number;
}

/** sky -> encoder */
export function skyToEncoder(_sky: AltAz, _p: PointingModelParams): { az: number; alt: number } { throw new Error('TODO'); }
/** encoder -> sky (numerical inverse) */
export function encoderToSky(_enc: { az: number; alt: number }, _p: PointingModelParams): AltAz { throw new Error('TODO'); }
/** Fit params from observations. 1 obs: IA,IE. 2: +AN,AW. 3: +CA. >=4: +NPAE. `initial` seeds the solver (e.g. from alignHome). */
export function fitModel(_obs: Observation[], _initial?: PointingModelParams): FitResult { throw new Error('TODO'); }
