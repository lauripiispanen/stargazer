import { describe, expect, it } from 'vitest';
import { decimalYear, magneticDeclination, magneticField } from './wmm.ts';
import { WMM2025 } from './wmm2025.ts';

describe('WMM2025 coefficients', () => {
  it('has all 90 (n, m) terms up to degree 12 and the published dipole term', () => {
    expect(WMM2025).toHaveLength(90);
    expect(WMM2025[0]).toEqual([1, 0, -29351.8, 0, 12, 0]);
    expect(WMM2025.at(-1)![0]).toBe(12);
  });
});

describe('WMM evaluator', () => {
  it('decimal year', () => {
    expect(decimalYear(Date.UTC(2025, 0, 1))).toBe(2025);
    expect(decimalYear(Date.UTC(2026, 6, 2, 12))).toBeCloseTo(2026.5, 2);
  });

  // Reference values from the independent `geomagnetism` (naturalatlas, WMM2025 data) implementation, at
  // NOAA's WMM test-table locations and at a few cities. Agreement is to 0.001°.
  const cases: [string, number, number, string, number, number, number, number][] = [
    // name, lat, lon, date, altKm, D, I, F
    ['80N 0E 2025.0', 80, 0, '2025-01-01', 0, 1.281, 83.211, 55178.5],
    ['0N 120E 2025.0', 0, 120, '2025-01-01', 0, -0.158, -14.931, 41064.3],
    ['80S 240E 2025.0', -80, 240, '2025-01-01', 0, 68.775, -72.005, 54698.2],
    ['80N 0E 100 km 2027.5', 80, 0, '2027-07-02', 100, 2.16, 83.285, 53034.2],
    ['Helsinki 2026', 60.17, 24.94, '2026-10-19', 0, 10.479, 73.698, 52608.2],
    ['Boston 2026', 42.36, -71.06, '2026-06-01', 0, -13.954, 66.204, 51171.2],
    ['Sydney 2027', -33.9, 151.2, '2027-07-01', 0, 12.852, -64.426, 56981.8],
    ['Tokyo 2028', 35.7, 139.7, '2028-01-01', 0, -7.988, 49.592, 46934.5],
  ];
  for (const [name, lat, lon, date, h, D, I, F] of cases) {
    it(name, () => {
      const m = magneticField(lat, lon, new Date(`${date}T00:00:00Z`), h);
      expect(m.declinationDeg).toBeCloseTo(D, 2);
      expect(m.inclinationDeg).toBeCloseTo(I, 2);
      expect(Math.abs(m.f - F)).toBeLessThan(1);
      expect(m.inValidity).toBe(true);
    });
  }

  it('Helsinki is ~+10°E and Boston ~−14°W in 2026 (sanity)', () => {
    const t = Date.UTC(2026, 9, 19);
    expect(magneticDeclination(60.17, 24.94, t)).toBeGreaterThan(9.5);
    expect(magneticDeclination(60.17, 24.94, t)).toBeLessThan(11.5);
    expect(magneticDeclination(42.36, -71.06, t)).toBeGreaterThan(-15);
    expect(magneticDeclination(42.36, -71.06, t)).toBeLessThan(-13);
  });

  it('flags dates outside the model validity', () => {
    expect(magneticField(60, 25, Date.UTC(2031, 5, 1)).inValidity).toBe(false);
  });

  it('stays finite at the poles', () => {
    expect(Number.isFinite(magneticDeclination(90, 0, Date.UTC(2026, 0, 1)))).toBe(true);
    expect(Number.isFinite(magneticDeclination(-90, 0, Date.UTC(2026, 0, 1)))).toBe(true);
  });
});
