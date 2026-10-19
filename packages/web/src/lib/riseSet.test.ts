import { describe, expect, it } from 'vitest';
import { fixedRiseTransitSet, SIDEREAL_DEG_PER_MS } from './riseSet.ts';

describe('fixedRiseTransitSet', () => {
  it('transit is when LST equals RA, symmetric rise/set', () => {
    const r = fixedRiseTransitSet(100, 0, 45, 90, 0); // 10 deg before transit
    expect(r.transit).toBeCloseTo(10 / SIDEREAL_DEG_PER_MS, -1);
    expect(r.transitAlt).toBeCloseTo(45);
    expect(r.transit - r.rise!).toBeCloseTo(r.set! - r.transit);
    // equator object at lat 45: ~6h above horizon each side (slightly more due to refraction)
    expect((r.set! - r.rise!) / 3600e3).toBeGreaterThan(11.9);
    expect((r.set! - r.rise!) / 3600e3).toBeLessThan(12.3);
  });
  it('circumpolar and never-rising', () => {
    expect(fixedRiseTransitSet(0, 80, 60, 0, 0).circumpolar).toBe(true);
    expect(fixedRiseTransitSet(0, -70, 60, 0, 0).neverRises).toBe(true);
  });
});
