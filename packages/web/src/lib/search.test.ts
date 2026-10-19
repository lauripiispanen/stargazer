import { describe, expect, it } from 'vitest';
import { buildSearchIndex, normalizeName, search } from './search.ts';
import type { SkyObject } from './catalog.ts';

// Synthetic objects (made-up coordinates), not catalog copies.
const o = (key: string, kind: SkyObject['kind'], name: string, id: string | undefined, aliases: string[], mag?: number): SkyObject =>
  ({ key, kind, name, id, aliases, ra: 10, dec: 10, mag, typeLabel: kind });
const objs: SkyObject[] = [
  o('dso:M31', 'dso', 'Andromeda Galaxy', 'M31', ['M31', 'NGC 224', 'Andromeda Galaxy'], 3.4),
  o('dso:M3', 'dso', 'M3', 'M3', ['M3', 'NGC 5272'], 6.2),
  o('dso:M42', 'dso', 'Orion Nebula', 'M42', ['M42', 'NGC 1976', 'Orion Nebula'], 4),
  o('dso:NGC 7000', 'dso', 'North America Nebula', 'NGC 7000', ['NGC 7000', 'C20'], 4),
  o('star:1', 'star', 'Vega', 'HIP 1', ['α Lyr', 'alpha Lyr', 'HIP 1'], 0),
  o('body:Jupiter', 'body', 'Jupiter', 'Jupiter', []),
  o('con:Ori', 'constellation', 'Orion', 'Ori', ['Ori']),
];
const idx = buildSearchIndex(objs);

describe('normalizeName', () => {
  it('canonicalises catalog ids', () => {
    expect(normalizeName('Messier 31')).toBe('m31');
    expect(normalizeName('NGC 0224')).toBe('ngc224');
    expect(normalizeName(' ngc-7000 ')).toBe('ngc7000');
    expect(normalizeName('Café')).toBe('cafe');
  });
});

describe('search', () => {
  it('finds by id, alias, name and words', () => {
    expect(search(idx, 'M31')[0].key).toBe('dso:M31');
    expect(search(idx, 'ngc 224')[0].key).toBe('dso:M31');
    expect(search(idx, 'NGC 7000')[0].key).toBe('dso:NGC 7000');
    expect(search(idx, 'vega')[0].key).toBe('star:1');
    expect(search(idx, 'Jupiter')[0].key).toBe('body:Jupiter');
    expect(search(idx, 'Orion Nebula')[0].key).toBe('dso:M42');
    expect(search(idx, 'alpha lyr')[0].key).toBe('star:1');
  });
  it('exact numeric id beats a longer prefix (M3 vs M31)', () => {
    expect(search(idx, 'm3')[0].key).toBe('dso:M3');
  });
  it('prefers the constellation for its exact name but still lists the nebula', () => {
    const r = search(idx, 'orion').map((x) => x.key);
    expect(r[0]).toBe('con:Ori');
    expect(r).toContain('dso:M42');
  });
  it('empty query returns nothing', () => { expect(search(idx, '  ')).toEqual([]); });
});
