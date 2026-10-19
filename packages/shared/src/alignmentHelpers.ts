// Helpers for the guided alignment flow (choosing good alignment stars).
import type { AlignmentPoint, GeoLocation } from './api.ts';
import { skyFrame, separation, targetAltAz, type AltAz } from './astro.ts';
import { starLabel, type BrightStar } from './catalog.ts';

export interface AlignmentSuggestion {
  star: BrightStar;
  label: string;
  altAz: AltAz;
  /** Smallest azimuth difference (deg) to an already used alignment point; 180 if none. */
  minAzSepDeg: number;
}

export interface SuggestOptions {
  limit?: number; // default 8
  maxMag?: number; // default 2.5
  minAlt?: number; // default 20
  maxAlt?: number; // default 75
}

const azDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * Good next alignment stars: bright, between 20° and 75° altitude, well separated in
 * azimuth from the points already used. Ordered by separation tier
 * (>= 60°, >= 30°, rest), then brightest first.
 */
export function suggestAlignmentStars(
  loc: GeoLocation,
  time: number,
  existingPoints: Pick<AlignmentPoint, 'target'>[],
  catalog: BrightStar[],
  options: SuggestOptions = {},
): AlignmentSuggestion[] {
  const { limit = 8, maxMag = 2.5, minAlt = 20, maxAlt = 75 } = options;
  const frame = skyFrame(loc, time);
  const used = existingPoints.map((p) => targetAltAz(p.target, loc, time));
  const usedRaDec = existingPoints.flatMap((p) => (p.target.kind === 'radec' ? [{ ra: p.target.ra, dec: p.target.dec }] : []));

  const out: (AlignmentSuggestion & { tier: number })[] = [];
  for (const star of catalog) {
    if (star.mag > maxMag) continue;
    if (usedRaDec.some((u) => separation(u, star) < 1)) continue; // already used
    const altAz = frame.toAltAz(star);
    if (altAz.alt < minAlt || altAz.alt > maxAlt) continue;
    if (used.some((u) => separation({ ra: u.az, dec: u.alt }, { ra: altAz.az, dec: altAz.alt }) < 1)) continue;
    const minAzSepDeg = used.length ? Math.min(...used.map((u) => azDiff(u.az, altAz.az))) : 180;
    const tier = minAzSepDeg >= 60 ? 0 : minAzSepDeg >= 30 ? 1 : 2;
    out.push({ star, label: starLabel(star), altAz, minAzSepDeg, tier });
  }
  out.sort((a, b) => a.tier - b.tier || a.star.mag - b.star.mag);
  return out.slice(0, limit).map(({ tier: _t, ...s }) => s);
}
