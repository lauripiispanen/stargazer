import { describe, expect, it } from 'vitest';
import { classifyAlt, targetVisibility } from './visibility.ts';
import { DEFAULT_LIMITS } from './safety.ts';

describe('visibility', () => {
  it('classifies altitude against the mount limits', () => {
    expect(classifyAlt(-3)).toBe('down');
    expect(classifyAlt(8)).toBe('low');
    expect(classifyAlt(40)).toBe('good');
    expect(classifyAlt(80)).toBe('high');
    expect(classifyAlt(80, { ...DEFAULT_LIMITS, altDeg: [-5, 90] })).toBe('good');
  });

  it('describes a target now', () => {
    const loc = { lat: 60, lon: 25, elevation: 0, source: 'manual' as const };
    const v = targetVisibility({ kind: 'altaz', az: 180, alt: 30, name: 'x' }, loc, Date.now());
    expect(v).toMatchObject({ alt: 30, az: 180, level: 'good', label: 'up' });
    // Canopus never rises at 60°N
    const c = targetVisibility({ kind: 'radec', ra: 95.99, dec: -52.7, name: 'Canopus' }, loc, Date.now(), DEFAULT_LIMITS, () => 'hh:mm');
    expect(c?.level).toBe('down');
    expect(c?.label).toBe('never rises');
  });
});
