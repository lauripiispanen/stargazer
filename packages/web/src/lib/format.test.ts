import { describe, expect, it } from 'vitest';
import { compassPoint, fmtDms, fmtRa, fmtSize } from './format.ts';

describe('format', () => {
  it('formats RA and Dec', () => {
    expect(fmtRa(0)).toBe('00h 00m 00s');
    expect(fmtRa(180)).toBe('12h 00m 00s');
    expect(fmtRa(359.99999)).toBe('00h 00m 00s');
    expect(fmtDms(-0.5)).toBe('−0° 30′ 00″');
    expect(fmtDms(45.25)).toBe('+45° 15′ 00″');
  });
  it('compass points and sizes', () => {
    expect(compassPoint(0)).toBe('N'); expect(compassPoint(359)).toBe('N'); expect(compassPoint(90)).toBe('E'); expect(compassPoint(225)).toBe('SW');
    expect(fmtSize([120, 60])).toBe('2.0° × 1.0°');
    expect(fmtSize([0.5, 0.5])).toBe('30″');
  });
});
