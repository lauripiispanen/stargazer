import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GeoLocation } from './api.ts';
import { suggestAlignmentStars } from './alignmentHelpers.ts';
import { namedStars, type StarNamesFile, type StarsFile } from './catalog.ts';

const dataDir = [join(process.cwd(), 'data'), join(process.cwd(), '../../data')].find((d) => {
  try { readFileSync(join(d, 'stars.json')); return true; } catch { return false; }
})!;
const stars: StarsFile = JSON.parse(readFileSync(join(dataDir, 'stars.json'), 'utf8'));
const names: StarNamesFile = JSON.parse(readFileSync(join(dataDir, 'star-names.json'), 'utf8'));
const catalog = namedStars(stars, names, 3);

const helsinki: GeoLocation = { lat: 60.17, lon: 24.94, elevation: 20, source: 'manual' };
const T = Date.UTC(2026, 9, 18, 19, 0);
const azDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe('namedStars', () => {
  it('joins names and sorts by magnitude', () => {
    expect(catalog.length).toBeGreaterThan(80);
    expect(catalog[0].name).toBe('Sirius');
    expect(catalog.find((s) => s.name === 'Vega')?.bayer).toBe('α Lyr');
    for (let i = 1; i < catalog.length; i++) expect(catalog[i].mag).toBeGreaterThanOrEqual(catalog[i - 1].mag);
  });
});

describe('suggestAlignmentStars', () => {
  it('first star: brightest stars between 20° and 75°', () => {
    const s = suggestAlignmentStars(helsinki, T, [], catalog);
    expect(s.length).toBe(8);
    for (const x of s) {
      expect(x.altAz.alt).toBeGreaterThanOrEqual(20);
      expect(x.altAz.alt).toBeLessThanOrEqual(75);
      expect(x.star.mag).toBeLessThanOrEqual(2.5);
      expect(x.minAzSepDeg).toBe(180);
    }
    for (let i = 1; i < s.length; i++) expect(s[i].star.mag).toBeGreaterThanOrEqual(s[i - 1].star.mag);
    expect(s.map((x) => x.label)).toContain('Vega');
  });

  it('next stars are well separated in azimuth from those used, and never repeat', () => {
    const first = suggestAlignmentStars(helsinki, T, [], catalog)[0];
    const used = [{ target: { kind: 'radec' as const, ra: first.star.ra, dec: first.star.dec, name: first.label } }];
    const s = suggestAlignmentStars(helsinki, T, used, catalog);
    expect(s.find((x) => x.label === first.label)).toBeUndefined();
    expect(s[0].minAzSepDeg).toBeGreaterThanOrEqual(60);
    expect(azDiff(s[0].altAz.az, first.altAz.az)).toBeGreaterThanOrEqual(60);
    // Tiers: separation >= 60 come before closer ones.
    const firstClose = s.findIndex((x) => x.minAzSepDeg < 60);
    if (firstClose >= 0) expect(s.slice(firstClose).every((x) => x.minAzSepDeg < 60)).toBe(true);
  });

  it('accepts body / altaz points and options', () => {
    const used = [{ target: { kind: 'altaz' as const, az: 180, alt: 40, name: 'x' } }];
    const s = suggestAlignmentStars(helsinki, T, used, catalog, { limit: 3, maxMag: 1.5, minAlt: 30, maxAlt: 60 });
    expect(s.length).toBeLessThanOrEqual(3);
    for (const x of s) {
      expect(x.star.mag).toBeLessThanOrEqual(1.5);
      expect(x.altAz.alt).toBeGreaterThanOrEqual(30);
      expect(x.altAz.alt).toBeLessThanOrEqual(60);
      expect(x.minAzSepDeg).toBeCloseTo(azDiff(x.altAz.az, 180), 6);
    }
  });
});
