import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDsos, buildNamedStars, normDsoType, parseStars, type DsoRecord, type StarsFile } from './catalog.ts';
import { buildSearchIndex, search } from './search.ts';
import { extraDsoRecords, whatsUpTonight, suggestAlignmentStars } from './astroAdapter.ts';

// Obviously synthetic values (not catalog copies)
const synthetic: StarsFile = { fields: ['ra', 'dec', 'mag', 'bv', 'hip'], rows: [[10, 20, 1, 0.5, 111], [30, -40, 2, 1.2, 222], [50, 60, 3, 0, 0]] };

describe('catalog parsing', () => {
  it('parses columnar stars and joins names', () => {
    const s = parseStars(synthetic);
    expect(s.count).toBe(3);
    expect(s.byHip.get(222)).toBe(1);
    const named = buildNamedStars(s, { '111': { name: 'Testar', bayer: 'α Tst' }, '999': { name: 'Missing' } });
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ name: 'Testar', hip: 111, ra: 10, kind: 'star' });
    expect(named[0].aliases).toContain('alpha Tst');
  });
  it('normalises DSO types and builds objects', () => {
    expect(normDsoType('Globular Cluster')).toBe('globular-cluster');
    expect(normDsoType('snr')).toBe('supernova-remnant');
    expect(normDsoType('weird')).toBe('other');
    const d = buildDsos([{ id: 'X1', name: 'Fake Blob', type: 'nebula', ra: 1, dec: 2, sizeArcmin: [3] } as DsoRecord]);
    expect(d[0]).toMatchObject({ key: 'dso:X1', name: 'Fake Blob', typeLabel: 'Nebula', sizeArcmin: [3, 3] });
  });
});

// Integration with the real data/ when present (skipped otherwise: data/ is not committed).
const DATA = resolve(__dirname, '../../../../data');
const haveData = existsSync(resolve(DATA, 'stars.json')) && existsSync(resolve(DATA, 'dso.json'));
describe.skipIf(!haveData)('real data/ integration', () => {
  const load = <T,>(f: string): T => JSON.parse(readFileSync(resolve(DATA, f), 'utf8'));
  const starsFile = haveData ? load<StarsFile>('stars.json') : synthetic;
  const stars = parseStars(starsFile);
  const names = haveData ? load<Record<string, { name?: string; bayer?: string }>>('star-names.json') : {};
  const dsoRecs = haveData ? [...load<DsoRecord[]>('dso.json'), ...extraDsoRecords(starsFile)] : [];
  const objs = [...buildDsos(dsoRecs), ...buildNamedStars(stars, names)];
  const idx = buildSearchIndex(objs);
  it('has ~40k stars sorted by magnitude', () => {
    expect(stars.count).toBeGreaterThan(20000);
    for (let i = 1; i < 500; i++) expect(stars.mag[i]).toBeGreaterThanOrEqual(stars.mag[i - 1]);
  });
  it('search finds the classics', () => {
    expect(search(idx, 'M31')[0].id).toBe('M31');
    expect(search(idx, 'NGC 7000')[0].aliases.concat(search(idx, 'NGC 7000')[0].id ?? '')).toContain('NGC 7000');
    expect(search(idx, 'Vega')[0].name).toBe('Vega');
    expect(search(idx, 'Orion Nebula')[0].id).toBe('M42');
    expect(search(idx, 'Albireo').length).toBeGreaterThan(0);
  });
  it('tonight + alignment suggestions run on real data', () => {
    const loc = { lat: 60.17, lon: 24.94, elevation: 0, source: 'manual' as const };
    const t = Date.UTC(2026, 9, 18, 20, 0, 0);
    const items = whatsUpTonight(loc, t, { dsos: dsoRecs, stars, starNames: names, starsFile });
    expect(items.length).toBeGreaterThan(10);
    expect(items.some((i) => i.category === 'double-star')).toBe(true);
    const sug = suggestAlignmentStars(loc, t, [], { dsos: dsoRecs, stars, starNames: names });
    expect(sug.length).toBeGreaterThan(0);
    for (const s of sug) { expect(s.alt).toBeGreaterThanOrEqual(20); expect(s.mag).toBeLessThanOrEqual(2.5); }
  });
});
