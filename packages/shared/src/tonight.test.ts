import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Astronomy from 'astronomy-engine';
import type { GeoLocation } from './api.ts';
import { targetAltAz } from './astro.ts';
import { namedStars, type DsoEntry, type StarNamesFile, type StarsFile } from './catalog.ts';
import { observingConditions, resolveShowpieceDoubles, SHOWPIECE_DOUBLES, whatsUpTonight } from './tonight.ts';

// Real offline catalogs (tests run from the repo root or the package dir).
const dataDir = [join(process.cwd(), 'data'), join(process.cwd(), '../../data')].find((d) => {
  try { readFileSync(join(d, 'dso.json')); return true; } catch { return false; }
})!;
const dso: DsoEntry[] = JSON.parse(readFileSync(join(dataDir, 'dso.json'), 'utf8'));
const stars: StarsFile = JSON.parse(readFileSync(join(dataDir, 'stars.json'), 'utf8'));
const names: StarNamesFile = JSON.parse(readFileSync(join(dataDir, 'star-names.json'), 'utf8'));
const brightStars = namedStars(stars, names, 3);
const catalog = { dso, brightStars, stars };

const helsinki: GeoLocation = { lat: 60.17, lon: 24.94, elevation: 20, source: 'manual' };
const sydney: GeoLocation = { lat: -33.87, lon: 151.21, elevation: 50, source: 'manual' };
const NOON = Date.UTC(2026, 9, 18, 10, 0); // Helsinki local 13:00

describe('resolveShowpieceDoubles', () => {
  it('resolves every curated double from the star catalog, with unique HIP numbers', () => {
    const r = resolveShowpieceDoubles(stars);
    expect(r.map((d) => d.id)).toEqual(SHOWPIECE_DOUBLES.map((d) => d.id));
    expect(new Set(SHOWPIECE_DOUBLES.map((d) => d.hip)).size).toBe(SHOWPIECE_DOUBLES.length);
    const albireo = r.find((d) => d.id === 'Albireo')!;
    expect(albireo).toMatchObject({ type: 'double-star', hip: 95947 });
    expect(albireo.ra).toBeCloseTo(292.68, 1);
    expect(albireo.dec).toBeCloseTo(27.96, 1);
    expect(albireo.mag).toBeCloseTo(3.05, 1);
  });

  it('skips doubles missing from the catalog and can resolve from named stars', () => {
    expect(resolveShowpieceDoubles({ fields: stars.fields, rows: [] })).toEqual([]);
    const fromBright = resolveShowpieceDoubles(brightStars);
    expect(fromBright.map((d) => d.id)).toContain('Almach');
    expect(fromBright.length).toBeLessThan(SHOWPIECE_DOUBLES.length);
  });
});

describe('observingConditions', () => {
  it('October in Helsinki: astronomical darkness, window inside the night', () => {
    const c = observingConditions(helsinki, NOON);
    expect(c.darkness).toBe('astronomical');
    expect(c.windowStart).toBe(c.darkStart);
    expect(c.windowEnd).toBe(c.darkEnd);
    expect(c.windowStart).toBeGreaterThan(c.sunset!);
    expect(c.windowEnd).toBeLessThan(c.sunrise!);
    expect(c.moon.upFraction).toBeGreaterThanOrEqual(0);
    expect(c.moon.upFraction).toBeLessThanOrEqual(1);
    expect(c.summary).toMatch(/Dark .* · Moon \d+%/);
  });

  it('starts the window at `time` when asked during the night', () => {
    const late = Date.UTC(2026, 9, 18, 22, 0);
    const c = observingConditions(helsinki, late);
    expect(c.windowStart).toBe(late);
  });

  it('just before sunrise it plans for the next night', () => {
    const c0 = observingConditions(helsinki, NOON);
    const c = observingConditions(helsinki, c0.darkEnd! + 20 * 60_000);
    expect(c.windowStart).toBeGreaterThan(c0.sunrise!);
  });

  it('midsummer in Helsinki has no astronomical darkness', () => {
    const c = observingConditions(helsinki, Date.UTC(2026, 5, 21, 10, 0));
    expect(['nautical', 'civil']).toContain(c.darkness);
    expect(c.darkStart).toBeNull();
    expect(c.windowEnd).toBeGreaterThan(c.windowStart);
    expect(c.summary).toMatch(/twilight/);
  });

  it('polar day still yields a usable window', () => {
    const c = observingConditions({ lat: 78.2, lon: 15.6, elevation: 0, source: 'manual' }, Date.UTC(2026, 5, 21, 10, 0));
    expect(c.darkness).toBe('none');
    expect(c.windowEnd).toBeGreaterThan(c.windowStart);
  });
});

describe('whatsUpTonight', () => {
  const list = whatsUpTonight(helsinki, NOON, catalog);
  const cond = observingConditions(helsinki, NOON);

  it('returns a sorted list of visible targets with sane fields', () => {
    expect(list.length).toBe(40);
    for (let i = 1; i < list.length; i++) expect(list[i].score).toBeLessThanOrEqual(list[i - 1].score);
    for (const it of list) {
      expect(it.maxAlt).toBeGreaterThanOrEqual(15);
      expect(it.score).toBeGreaterThan(0);
      expect(it.score).toBeLessThanOrEqual(100);
      expect(it.description.length).toBeGreaterThan(5);
      expect(['easy', 'moderate', 'challenging']).toContain(it.difficulty);
      expect(it.id).not.toBe('Sun');
      if (it.category !== 'planet' && it.category !== 'moon') {
        expect(it.bestTime).toBeGreaterThanOrEqual(cond.windowStart - 1);
        expect(it.bestTime).toBeLessThanOrEqual(cond.windowEnd + 1);
      }
      // maxAlt agrees with a direct computation at bestTime.
      expect(Math.abs(targetAltAz(it.target, helsinki, it.bestTime).alt - it.maxAlt)).toBeLessThan(0.3);
      if (it.rise !== null && it.set !== null && it.transit !== null) {
        expect(it.rise).toBeLessThan(it.transit);
        expect(it.transit).toBeLessThan(it.set);
      }
    }
    expect(new Set(list.map((i) => i.id)).size).toBe(list.length);
  });

  it('ranks autumn showpieces from Helsinki highly', () => {
    const top = list.slice(0, 20).map((i) => i.id);
    expect(top).toContain('M31');
    expect(top).toContain('C14');
    expect(top).toContain('Albireo');
    expect(top).toContain('M45');
    const m31 = list.find((i) => i.id === 'M31')!;
    expect(m31.circumpolar).toBe(true); // dec +41 at lat 60
    expect(m31.rise).toBeNull();
    expect(m31.name).toBe('M31 Andromeda Galaxy');
    expect(m31.target).toMatchObject({ kind: 'radec', id: 'M31' });
  });

  it('includes planets that are up during the night', () => {
    const planets = whatsUpTonight(helsinki, NOON, catalog, { categories: ['planet', 'moon'] });
    const obs = new Astronomy.Observer(helsinki.lat, helsinki.lon, 0);
    for (const p of planets) {
      expect(p.target.kind).toBe('body');
      const hor = Astronomy.Horizon(new Date(p.bestTime), obs, ...(() => {
        const e = Astronomy.Equator(p.id as Astronomy.Body, new Date(p.bestTime), obs, true, true);
        return [e.ra, e.dec] as const;
      })(), 'normal');
      expect(Math.abs(hor.altitude - p.maxAlt)).toBeLessThan(0.05);
    }
    // Saturn is an evening object in October 2026 and should be listed.
    expect(planets.map((p) => p.id)).toContain('Saturn');
  });

  it('southern sky from Sydney: 47 Tuc high, M31 not near the top', () => {
    const s = whatsUpTonight(sydney, Date.UTC(2026, 9, 18, 2, 0), catalog, { limit: 60 });
    const ids = s.map((i) => i.id);
    expect(ids.slice(0, 25)).toContain('NGC 104');
    expect(ids.indexOf('M31') === -1 || ids.indexOf('M31') > 10).toBe(true);
  });

  it('moonlight demotes faint galaxies but not planets or doubles', () => {
    const newMoon = Astronomy.SearchMoonPhase(0, new Date(NOON), 30)!.date.getTime();
    const fullMoon = Astronomy.SearchMoonPhase(180, new Date(NOON), 30)!.date.getTime();
    const score = (t: number, id: string) => whatsUpTonight(helsinki, t, catalog, { limit: 1000 }).find((i) => i.id === id)?.score ?? 0;
    expect(score(fullMoon, 'M33')).toBeLessThan(score(newMoon, 'M33') * 0.8);
    expect(Math.abs(score(fullMoon, 'Almach') - score(newMoon, 'Almach'))).toBeLessThan(15);
    const fullCond = observingConditions(helsinki, fullMoon);
    expect(fullCond.moon.interference).toBeGreaterThan(0.4);
    expect(fullCond.summary).toMatch(/Moon (9\d|100)%/);
  });

  it('respects options', () => {
    const doubles = whatsUpTonight(helsinki, NOON, catalog, { categories: ['double-star'], limit: 100 });
    expect(doubles.every((d) => d.category === 'double-star')).toBe(true);
    expect(doubles.length).toBeGreaterThan(8);
    const highOnly = whatsUpTonight(helsinki, NOON, catalog, { minAlt: 50, limit: 500 });
    expect(highOnly.every((d) => d.maxAlt >= 50)).toBe(true);
    const noDoubles = whatsUpTonight(helsinki, NOON, catalog, { includeDoubles: false, limit: 500 });
    expect(noDoubles.some((d) => SHOWPIECE_DOUBLES.some((s) => s.id === d.id))).toBe(false);
  });

  it('lists showpiece doubles fainter than the bright-star list when given the full star catalog', () => {
    const ids = (c: object) => whatsUpTonight(helsinki, NOON, { dso, ...c }, { categories: ['double-star'], limit: 100 }).map((d) => d.id);
    expect(ids({ brightStars })).not.toContain('Double Double');
    expect(ids({ stars })).toContain('Double Double');
    expect(ids({})).not.toContain('Almach');
  });

  it('works without bright stars and with an empty catalog', () => {
    expect(whatsUpTonight(helsinki, NOON, { dso: [] }).length).toBeGreaterThan(3);
  });

  it('is fast enough for the browser (~600 objects)', () => {
    const t0 = performance.now();
    whatsUpTonight(helsinki, NOON + 3.6e6, catalog);
    expect(performance.now() - t0).toBeLessThan(400);
  });
});
