// ============================================================================================
// THE single integration point between the web GUI and packages/shared (astro, tonight,
// alignmentHelpers, catalog). Everything astronomy-related the GUI uses goes through here, so a
// change in shared signatures/return shapes is a one-file change.
// ============================================================================================
import type { AlignmentPoint, GeoLocation, SolarBody, Target } from '@stargazer/shared/api.ts';
import * as astro from '@stargazer/shared/astro.ts';
import * as tonight from '@stargazer/shared/tonight.ts';
import { suggestAlignmentStars as sharedSuggest } from '@stargazer/shared/alignmentHelpers.ts';
import type { BrightStar, DsoEntry, StarsFile as SharedStarsFile } from '@stargazer/shared/catalog.ts';
import type { AltAz, RaDec, MoonInfo, TwilightTimes } from '@stargazer/shared/astro.ts';
import * as local from './astroLocal.ts';
import type { SkyObject, StarCatalog, StarNamesFile, DsoRecord, StarsFile } from './catalog.ts';
import { fixedRiseTransitSet } from './riseSet.ts';

export type { AltAz, RaDec, MoonInfo, TwilightTimes };
export type TonightItem = tonight.TonightItem;
export type TonightCategory = tonight.TonightCategory;
export type ObservingConditions = tonight.ObservingConditions;

// ---- core conversions (shared/astro.ts) ----
export const raDecToAltAz = astro.raDecToAltAz;
export const altAzToRaDec = astro.altAzToRaDec;
export const bodyRaDec = astro.bodyRaDec;
export const targetAltAz = astro.targetAltAz;
export const separation = astro.separation;
export const separationAltAz = astro.separationAltAz;
export const localSiderealDeg = astro.localSiderealDeg;
export const twilight = astro.twilight;
export const moonInfo = astro.moonInfo;
export const skyFrame = astro.skyFrame;
export const sunAltitude = astro.sunAltitude;

/**
 * GPU frame matrix: J2000 unit vector -> renderer WORLD frame (x East, y Zenith, z South), no refraction.
 * Not part of the shared API (astronomy-engine Rotation_EQJ_HOR; omits the ~20" annual aberration that
 * shared/astro.ts includes, which is invisible at sky-map scales).
 */
export const eqj2000ToWorldMatrix = local.eqj2000ToWorldMatrix;
export const illumination = local.illumination;

/** Names of shared functions served by local fallbacks (none now that shared is implemented). */
export function adapterFallbacks(): string[] { return []; }

export interface RiseTransitSetInfo { rise: number | null; transit: number | null; set: number | null; transitAlt: number | null; circumpolar?: boolean; neverRises?: boolean }
export function riseTransitSet(o: { ra: number; dec: number; body?: SolarBody }, loc: GeoLocation, time: number): RiseTransitSetInfo {
  if (o.body) return local.bodyRiseTransitSet(o.body, loc, time);
  return fixedRiseTransitSet(o.ra, o.dec, loc.lat, localSiderealDeg(loc, time), time);
}

/** Make a mount Target from a sky object. */
export function objectToTarget(o: SkyObject): Target {
  if (o.kind === 'body' && o.body) return { kind: 'body', body: o.body, name: o.name };
  return { kind: 'radec', ra: o.ra, dec: o.dec, name: o.name, id: o.id };
}

// ---- catalog bridging ----
/** Curated double stars (not in dso.json), positioned from the star catalog, to merge into map/search. */
export function extraDsoRecords(stars: StarsFile): DsoRecord[] {
  return tonight.resolveShowpieceDoubles(stars as unknown as SharedStarsFile).map((d) => ({
    id: d.id, name: d.name, type: 'double-star', ra: d.ra, dec: d.dec, mag: d.mag, sizeArcmin: [d.sepArcsec / 60, d.sepArcsec / 60], con: d.con, alt: d.alt,
  }));
}
export function doubleStarNote(id: string): string | undefined {
  const d = tonight.SHOWPIECE_DOUBLES.find((x) => x.id === id);
  return d ? `${d.note} · separation ${d.sepArcsec}″ · ${d.difficulty}` : undefined;
}

export function brightStars(stars: StarCatalog, names: StarNamesFile, maxMag = 3, requireName = true): BrightStar[] {
  const out: BrightStar[] = [];
  for (let i = 0; i < stars.count; i++) {
    const mag = stars.mag[i];
    if (mag > maxMag) break;
    const hip = stars.hip[i];
    const n = hip ? names[String(hip)] : undefined;
    if (requireName && !n?.name) continue;
    out.push({ ra: stars.ra[i], dec: stars.dec[i], mag, bv: stars.bv[i], hip: hip || undefined, name: n?.name, bayer: n?.bayer });
  }
  return out;
}

export interface TonightSource { dsos: DsoRecord[]; stars: StarCatalog; starNames: StarNamesFile; starsFile?: StarsFile }
const brightCache = new WeakMap<StarCatalog, BrightStar[]>();
function cachedBright(src: TonightSource) {
  let b = brightCache.get(src.stars);
  if (!b) { b = brightStars(src.stars, src.starNames, 3); brightCache.set(src.stars, b); }
  return b;
}

// ---- tonight.ts ----
export interface TonightQuery { limit?: number; minAlt?: number; categories?: TonightCategory[] }
export function whatsUpTonight(loc: GeoLocation, time: number, src: TonightSource, q: TonightQuery = {}): TonightItem[] {
  // dso.json entries only (doubles come from `stars` inside whatsUpTonight)
  const dso = src.dsos.filter((d) => d.type !== 'double-star' || !tonight.SHOWPIECE_DOUBLES.some((x) => x.id === d.id)) as DsoEntry[];
  return tonight.whatsUpTonight(loc, time, { dso, brightStars: cachedBright(src), stars: src.starsFile as unknown as SharedStarsFile | undefined }, { limit: q.limit ?? 80, minAlt: q.minAlt, categories: q.categories });
}
export function observingConditions(loc: GeoLocation, time: number): ObservingConditions {
  return tonight.observingConditions(loc, time);
}

// ---- alignmentHelpers.ts ----
export interface AlignStarSuggestion { hip?: number; name: string; ra: number; dec: number; mag: number; alt: number; az: number; reason?: string }
/** `maxAlt`: keep suggestions below the mount's upper altitude limit (the server refuses GoTos above it). */
export function suggestAlignmentStars(loc: GeoLocation, time: number, existing: AlignmentPoint[], src: TonightSource, opts: { maxAlt?: number } = {}): AlignStarSuggestion[] {
  return sharedSuggest(loc, time, existing, cachedBright(src), { limit: 6, ...(opts.maxAlt != null ? { maxAlt: opts.maxAlt } : {}) }).map((s) => ({
    hip: s.star.hip, name: s.label, ra: s.star.ra, dec: s.star.dec, mag: s.star.mag, alt: s.altAz.alt, az: s.altAz.az,
    reason: existing.length ? `${Math.round(s.minAzSepDeg)}° in azimuth from previous stars` : 'bright, comfortable altitude',
  }));
}
