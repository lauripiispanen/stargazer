import { describe, expect, it } from 'vitest';
import { diffMotion, keyAction, mergeMotion, motionFromDirs, readGamepad, stickToAxisMotion, STILL } from './slewInput.ts';

describe('keyAction', () => {
  it('maps arrows/WASD, digits and stop keys', () => {
    expect(keyAction('ArrowUp')).toEqual({ kind: 'move', dir: 'up' });
    expect(keyAction('KeyA')).toEqual({ kind: 'move', dir: 'left' });
    expect(keyAction('Digit7')).toEqual({ kind: 'rate', rate: 7 });
    expect(keyAction('Numpad3')).toEqual({ kind: 'rate', rate: 3 });
    expect(keyAction('Digit0')).toBeNull();
    expect(keyAction('Space')).toEqual({ kind: 'stop' });
    expect(keyAction('Escape')).toEqual({ kind: 'stop' });
    expect(keyAction('KeyQ')).toBeNull();
  });
});

describe('motionFromDirs', () => {
  it('combines axes and cancels opposites', () => {
    expect(motionFromDirs(['up', 'right'], 5)).toEqual({ alt: { direction: 1, rate: 5 }, az: { direction: 1, rate: 5 } });
    expect(motionFromDirs(['left', 'right'], 5).az).toBeNull();
    expect(motionFromDirs(['down'], 12).alt).toEqual({ direction: -1, rate: 9 });
  });
});

describe('diffMotion', () => {
  it('emits move on start/change and stopAxis on release', () => {
    const a = motionFromDirs(['up'], 4);
    expect(diffMotion(STILL, a)).toEqual([{ type: 'move', axis: 'alt', direction: 1, rate: 4 }]);
    expect(diffMotion(a, a)).toEqual([]);
    expect(diffMotion(a, motionFromDirs(['up'], 6))).toEqual([{ type: 'move', axis: 'alt', direction: 1, rate: 6 }]);
    expect(diffMotion(a, STILL)).toEqual([{ type: 'stopAxis', axis: 'alt' }]);
  });
});

describe('gamepad', () => {
  it('maps stick deflection to rate with a deadzone', () => {
    expect(stickToAxisMotion(0.1)).toBeNull();
    expect(stickToAxisMotion(0.2)?.rate).toBe(1);
    expect(stickToAxisMotion(-1)).toEqual({ direction: -1, rate: 9 });
    const mid = stickToAxisMotion(0.6)!.rate;
    expect(mid).toBeGreaterThan(1); expect(mid).toBeLessThan(9);
  });
  it('reads standard mapping: stick up is +alt, dpad uses selected rate, B is stop', () => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false }));
    const r = readGamepad({ axes: [0, -1], buttons }, 3);
    expect(r.motion.alt).toEqual({ direction: 1, rate: 9 });
    const b2 = buttons.map((b, i) => ({ pressed: i === 15 || i === 1 }));
    const r2 = readGamepad({ axes: [0, 0], buttons: b2 }, 3);
    expect(r2.motion.az).toEqual({ direction: 1, rate: 3 });
    expect(r2.stop).toBe(true);
  });
  it('merge gives priority to the first source per axis', () => {
    const m = mergeMotion(motionFromDirs(['up'], 2), { az: { direction: -1, rate: 9 }, alt: { direction: -1, rate: 9 } });
    expect(m.alt).toEqual({ direction: 1, rate: 2 });
    expect(m.az).toEqual({ direction: -1, rate: 9 });
  });
});
