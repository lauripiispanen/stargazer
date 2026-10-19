import { describe, expect, it } from 'vitest';
import { STOP_FAILED_MESSAGE } from '@stargazer/shared/api.ts';
import { autoSlewBlocked, DEFAULT_LIMITS, gotoBlockReason, isStopFailure, mountLimits, wrapGauge } from './safety.ts';

describe('safety', () => {
  it('blocks automatic slews with the Sun up and no star alignment', () => {
    expect(autoSlewBlocked(10, 'rough')).toBe(true);
    expect(autoSlewBlocked(-5, 'none')).toBe(true);
    expect(autoSlewBlocked(-7, 'none')).toBe(false);
    expect(autoSlewBlocked(10, 'aligned')).toBe(false);
    expect(autoSlewBlocked(-7, 'rough', { ...DEFAULT_LIMITS, sunUpAltDeg: -12 })).toBe(true);
  });
  it('explains why GoTo is disabled, in the server order', () => {
    const base = { sunAlt: -30, quality: 'aligned' as const, connected: true, locationKnown: true, sunSepDeg: 90 };
    expect(gotoBlockReason({ ...base, sunSepDeg: 50 })).toBeNull();
    expect(gotoBlockReason({ ...base, sunSepDeg: 12 })).toMatch(/Sun/);
    expect(gotoBlockReason({ ...base, isSun: true })).toMatch(/Sun/);
    expect(gotoBlockReason({ ...base, connected: false })).toMatch(/not connected/);
    expect(gotoBlockReason({ ...base, sunAlt: 20, quality: 'rough' })).toMatch(/blocked/);
    expect(gotoBlockReason({ ...base, quality: 'none' })).toMatch(/Home/);
    expect(gotoBlockReason({ ...base, locationKnown: false })).toMatch(/location/);
    expect(gotoBlockReason({ ...base, fault: 'Possible obstruction' })).toMatch(/STOP/);
    expect(gotoBlockReason({ ...base, observer: true })).toMatch(/hand controller/);
  });
  it('mirrors the mechanical altitude limits (refused even with force)', () => {
    const base = { sunAlt: -30, quality: 'aligned' as const, connected: true, sunSepDeg: 90 };
    expect(gotoBlockReason({ ...base, targetAlt: 72 })).toMatch(/above the 70° altitude limit/);
    expect(gotoBlockReason({ ...base, targetAlt: 72, limits: { ...DEFAULT_LIMITS, altDeg: [-5, 80] } })).toBeNull();
    expect(gotoBlockReason({ ...base, targetAlt: -2 })).toBeNull(); // server asks to confirm
    expect(gotoBlockReason({ ...base, targetAlt: -8 })).toMatch(/horizon/);
  });
  it('solar-filter mode turns Sun refusals into server confirmations', () => {
    const base = { sunAlt: 30, quality: 'aligned' as const, connected: true, limits: { ...DEFAULT_LIMITS, solarFilterMode: true } };
    expect(gotoBlockReason({ ...base, sunSepDeg: 0, isSun: true })).toBeNull();
  });
  it('uses server limits when present', () => {
    expect(mountLimits(null)).toBe(DEFAULT_LIMITS);
    const limits = { ...DEFAULT_LIMITS, altDeg: [-3, 65] as [number, number] };
    expect(mountLimits({ limits })).toBe(limits);
  });
  it('recognises stop failures', () => {
    expect(isStopFailure(STOP_FAILED_MESSAGE)).toBe(true);
    expect(isStopFailure('Mount failed to stop within 2 s')).toBe(true);
    expect(isStopFailure('GoTo refused: below horizon')).toBe(false);
  });
  it('cable-wrap gauge levels', () => {
    expect(wrapGauge(0)).toEqual({ fraction: 0, level: 'ok' });
    expect(wrapGauge(160).level).toBe('warn');
    expect(wrapGauge(-210).level).toBe('soft');
    expect(wrapGauge(250).level).toBe('hard');
    expect(wrapGauge(250, { ...DEFAULT_LIMITS, azHardDeg: 300 }).level).toBe('soft');
  });
});
