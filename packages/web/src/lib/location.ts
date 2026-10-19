// Location helpers: geolocation cache in localStorage, validation, city search. Pure apart from storage access.
import type { GeoLocation } from '@stargazer/shared/api.ts';
import type { City } from './catalog.ts';
import { normalizeName } from './search.ts';

export const GEO_CACHE_KEY = 'stargazer.geo';
export const GEO_MAX_AGE_MS = 30 * 86400e3;

export interface CachedGeo { lat: number; lon: number; elevation: number; time: number; label?: string }

export function validLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

export function parseCachedGeo(raw: string | null, now: number, maxAge = GEO_MAX_AGE_MS): (CachedGeo & { stale: boolean }) | null {
  if (!raw) return null;
  try {
    const g = JSON.parse(raw) as CachedGeo;
    if (!validLatLon(g.lat, g.lon) || !Number.isFinite(g.time)) return null;
    return { ...g, elevation: Number.isFinite(g.elevation) ? g.elevation : 0, stale: now - g.time > maxAge };
  } catch { return null; }
}

export function readCachedGeo(now = Date.now()) {
  try { return parseCachedGeo(localStorage.getItem(GEO_CACHE_KEY), now); } catch { return null; }
}
export function writeCachedGeo(g: CachedGeo) {
  try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(g)); } catch { /* storage unavailable */ }
}

export function cachedToLocation(g: CachedGeo): GeoLocation {
  return { lat: g.lat, lon: g.lon, elevation: g.elevation, source: 'cache', label: g.label ?? 'Cached GPS position' };
}

export function searchCities(cities: City[], q: string, limit = 8): City[] {
  const n = normalizeName(q);
  if (!n) return [];
  const scored: { c: City; s: number }[] = [];
  for (const c of cities) {
    const cn = normalizeName(c.name);
    const s = cn === n ? 3 : cn.startsWith(n) ? 2 : cn.includes(n) ? 1 : 0;
    if (s) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, limit).map((x) => x.c);
}

/** Parse "60.17" or "60° 10′ 12″ N" style coordinates. Returns NaN on failure. */
export function parseCoord(s: string): number {
  const t = s.trim().toUpperCase();
  if (!t) return NaN;
  const neg = /[SW]$/.test(t) || t.startsWith('-') || t.startsWith('−');
  const nums = t.replace(/[NSEW]/g, ' ').replace(/[−-]/g, ' ').match(/[\d.]+/g);
  if (!nums) return NaN;
  const [d, m = '0', sec = '0'] = nums;
  const v = Number(d) + Number(m) / 60 + Number(sec) / 3600;
  return neg ? -v : v;
}

export function fmtLocation(l: GeoLocation | null): string {
  if (!l) return 'not set';
  const lat = `${Math.abs(l.lat).toFixed(3)}° ${l.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(l.lon).toFixed(3)}° ${l.lon >= 0 ? 'E' : 'W'}`;
  return `${l.label ? l.label + ' · ' : ''}${lat}, ${lon}`;
}
