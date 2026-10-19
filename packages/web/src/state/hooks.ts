import { useEffect, useState } from 'react';
import type { Target } from '@stargazer/shared/api.ts';
import { useLocation, useStore } from './store.ts';
import { bodyRaDec, raDecToAltAz, separation } from '../lib/astroAdapter.ts';
import { gotoBlockReason, mountHealth, mountLimits } from '../lib/safety.ts';
import type { SkyObject } from '../lib/catalog.ts';

/** Re-render every `ms`. Returns Date.now(). */
export function useNow(ms = 1000): number {
  const [t, setT] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setT(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return t;
}

/** Displayed sky time (now + offset), refreshed every `ms`. */
export function useDisplayTime(ms = 1000): number {
  const now = useNow(ms);
  const off = useStore((s) => s.timeOffsetMs);
  return now + off;
}

/** Real-time Sun position (safety uses real time, never the display time offset). */
export function useSun(): { alt: number; ra: number; dec: number } {
  const loc = useLocation();
  const now = useNow(15000);
  try {
    const p = bodyRaDec('Sun', loc, now);
    return { alt: raDecToAltAz(p, loc, now).alt, ra: p.ra, dec: p.dec };
  } catch { return { alt: -90, ra: 0, dec: 0 }; }
}

type GotoSubject = SkyObject | Target;

/**
 * Returns a function giving the reason a GoTo to an object/target is disabled right now (null if allowed),
 * mirroring the server's checks (connection, fault, Home, location, Sun, altitude limits).
 */
export function useGotoBlocker(): (o: GotoSubject | null) => string | null {
  const loc = useLocation();
  const sun = useSun();
  const mount = useStore((s) => s.mount);
  const link = useStore((s) => s.link);
  const health = mountHealth(mount);
  const limits = mountLimits(mount);
  const connected = link === 'open' && mount?.connection === 'connected';
  return (o) => {
    if (!o) return null;
    const body = 'body' in o ? o.body : undefined;
    let sep: number | null = null;
    let alt: number | null = null;
    try {
      const now = Date.now();
      const p = body ? bodyRaDec(body, loc, now) : 'ra' in o ? { ra: o.ra, dec: o.dec } : null;
      if (p) { sep = separation(p, sun); alt = raDecToAltAz(p, loc, now).alt; }
      else if ('kind' in o && o.kind === 'altaz') alt = o.alt;
    } catch { /* unknown */ }
    return gotoBlockReason({
      connected, quality: mount?.alignment.quality, locationKnown: !!mount?.location, fault: health?.fault, observer: health?.observer,
      sunAlt: sun.alt, sunSepDeg: sep, isSun: body === 'Sun', targetAlt: alt, limits,
    });
  };
}

/** Why a GoTo to this object/target should be disabled right now (null if allowed). */
export function useGotoBlock(o: GotoSubject | null): string | null {
  return useGotoBlocker()(o);
}
