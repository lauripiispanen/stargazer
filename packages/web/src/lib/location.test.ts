import { describe, expect, it } from 'vitest';
import { parseCachedGeo, parseCoord, searchCities, validLatLon } from './location.ts';

describe('location helpers', () => {
  it('parses cached geolocation with staleness', () => {
    const raw = JSON.stringify({ lat: 10, lon: 20, elevation: 5, time: 1000 });
    expect(parseCachedGeo(raw, 2000)).toMatchObject({ lat: 10, lon: 20, stale: false });
    expect(parseCachedGeo(raw, 1000 + 31 * 86400e3)?.stale).toBe(true);
    expect(parseCachedGeo('{bad', 0)).toBeNull();
    expect(parseCachedGeo(JSON.stringify({ lat: 100, lon: 0, time: 1 }), 2)).toBeNull();
  });
  it('parses decimal and DMS coordinates', () => {
    expect(parseCoord('60.5')).toBeCloseTo(60.5);
    expect(parseCoord('-12.25')).toBeCloseTo(-12.25);
    expect(parseCoord('60°30′0″ N')).toBeCloseTo(60.5);
    expect(parseCoord('24 30 W')).toBeCloseTo(-24.5);
    expect(parseCoord('abc')).toBeNaN();
  });
  it('validates and searches cities', () => {
    expect(validLatLon(91, 0)).toBe(false);
    const cities = [{ name: 'Testville', country: 'XX', lat: 1, lon: 2 }, { name: 'Bigtest City', country: 'YY', lat: 3, lon: 4 }];
    expect(searchCities(cities, 'test').map((c) => c.name)).toEqual(['Testville', 'Bigtest City']);
  });
});
