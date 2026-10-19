// "Can I look at it now?" for list/search rows: altitude, direction and a short status. Pure.
import type { GeoLocation, MountLimits, Target } from '@stargazer/shared/api.ts';
import { targetAltAz, targetRaDec } from '@stargazer/shared/astro.ts';
import { riseTransitSet } from './astroAdapter.ts';
import { DEFAULT_LIMITS } from './safety.ts';

export type VisibilityLevel = 'good' | 'low' | 'high' | 'down';

export interface Visibility {
  alt: number;
  az: number;
  level: VisibilityLevel;
  /** Short label, e.g. "up", "low", "too high", "rises 21:40", "below horizon". */
  label: string;
}

/** Below this altitude (deg) a target is "low": murky and close to obstacles. */
export const LOW_ALT_DEG = 15;

export function classifyAlt(alt: number, limits: MountLimits = DEFAULT_LIMITS): VisibilityLevel {
  if (alt < 0) return 'down';
  if (alt > limits.altDeg[1]) return 'high';
  if (alt < LOW_ALT_DEG) return 'low';
  return 'good';
}

export function targetVisibility(t: Target, loc: GeoLocation, now: number, limits: MountLimits = DEFAULT_LIMITS, fmtTime?: (ms: number) => string): Visibility | null {
  try {
    const aa = targetAltAz(t, loc, now);
    const level = classifyAlt(aa.alt, limits);
    let label = level === 'good' ? 'up' : level === 'low' ? 'low' : level === 'high' ? 'too high' : 'below horizon';
    if (level === 'down' && t.kind !== 'altaz' && fmtTime) {
      const rd = targetRaDec(t, loc, now);
      const rts = riseTransitSet({ ...rd, body: t.kind === 'body' ? t.body : undefined }, loc, now);
      if (rts.neverRises) label = 'never rises';
      else if (rts.rise != null && rts.rise > now && rts.rise - now < 24 * 3600e3) label = `rises ${fmtTime(rts.rise)}`;
    }
    return { alt: aa.alt, az: aa.az, level, label };
  } catch {
    return null;
  }
}
