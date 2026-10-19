// Slew input mapping: keyboard / on-screen pad / gamepad -> per-axis motion -> WS commands. Pure.
import type { Axis, ClientMessage } from '@stargazer/shared/api.ts';

export type Dir = 'up' | 'down' | 'left' | 'right';
export interface AxisMotion { direction: 1 | -1; rate: number }
export type Motion = Record<Axis, AxisMotion | null>;
export const STILL: Motion = { az: null, alt: null };

/** up/down = alt +/-; right/left = az +/- (clockwise from above). Real mount sign is server config. */
export const DIR_AXIS: Record<Dir, { axis: Axis; direction: 1 | -1 }> = {
  up: { axis: 'alt', direction: 1 }, down: { axis: 'alt', direction: -1 },
  right: { axis: 'az', direction: 1 }, left: { axis: 'az', direction: -1 },
};

export const KEY_DIR: Record<string, Dir> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
};

export type KeyAction = { kind: 'move'; dir: Dir } | { kind: 'rate'; rate: number } | { kind: 'stop' } | null;
/** Map a KeyboardEvent.code to an action. */
export function keyAction(code: string): KeyAction {
  if (KEY_DIR[code]) return { kind: 'move', dir: KEY_DIR[code] };
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  if (m) return { kind: 'rate', rate: Number(m[1]) };
  if (code === 'Space' || code === 'Escape') return { kind: 'stop' };
  return null;
}

/** Combine held directions at a rate into per-axis motion. Opposite directions on one axis cancel. */
export function motionFromDirs(held: Iterable<Dir>, rate: number): Motion {
  const sum: Record<Axis, number> = { az: 0, alt: 0 };
  for (const d of new Set(held)) sum[DIR_AXIS[d].axis] += DIR_AXIS[d].direction;
  const r = clampRate(rate);
  const ax = (v: number): AxisMotion | null => (v === 0 ? null : { direction: v > 0 ? 1 : -1, rate: r });
  return { az: ax(sum.az), alt: ax(sum.alt) };
}

export function clampRate(r: number): number { return Math.min(9, Math.max(1, Math.round(r))); }

/** Stick deflection (-1..1) -> motion; |v| below deadzone = none; mapped to rates 1..maxRate (quadratic for fine control). */
export function stickToAxisMotion(v: number, deadzone = 0.18, maxRate = 9): AxisMotion | null {
  const a = Math.abs(v);
  if (!Number.isFinite(a) || a < deadzone) return null;
  const t = Math.min(1, (a - deadzone) / (1 - deadzone));
  return { direction: v > 0 ? 1 : -1, rate: clampRate(1 + t * t * (maxRate - 1) + 1e-9) };
}

/** Merge motion sources per axis: first non-null wins in priority order (pad/keys over stick). */
export function mergeMotion(...ms: Motion[]): Motion {
  const out: Motion = { az: null, alt: null };
  for (const m of ms) for (const ax of ['az', 'alt'] as Axis[]) if (!out[ax] && m[ax]) out[ax] = m[ax];
  return out;
}

/** Commands needed to go from `prev` to `next`. */
export function diffMotion(prev: Motion, next: Motion): ClientMessage[] {
  const out: ClientMessage[] = [];
  for (const axis of ['az', 'alt'] as Axis[]) {
    const p = prev[axis], n = next[axis];
    if (!n && p) out.push({ type: 'stopAxis', axis });
    else if (n && (!p || p.direction !== n.direction || p.rate !== n.rate)) out.push({ type: 'move', axis, direction: n.direction, rate: n.rate });
  }
  return out;
}

export function isMoving(m: Motion): boolean { return !!(m.az || m.alt); }

/** Standard-mapping gamepad -> motion + button edges. */
export interface GamepadSnapshot { axes: readonly number[]; buttons: readonly { pressed: boolean }[] }
export interface GamepadReading { motion: Motion; stop: boolean; rateUp: boolean; rateDown: boolean }
export function readGamepad(gp: GamepadSnapshot, rate: number, deadzone = 0.18): GamepadReading {
  const b = (i: number) => !!gp.buttons[i]?.pressed;
  // D-pad (12 up, 13 down, 14 left, 15 right) at the selected rate
  const dirs: Dir[] = [];
  if (b(12)) dirs.push('up'); if (b(13)) dirs.push('down'); if (b(14)) dirs.push('left'); if (b(15)) dirs.push('right');
  const dpad = motionFromDirs(dirs, rate);
  // Left stick: axes[0] x (right +), axes[1] y (down +)
  const stick: Motion = { az: stickToAxisMotion(gp.axes[0] ?? 0, deadzone), alt: stickToAxisMotion(-(gp.axes[1] ?? 0), deadzone) };
  return {
    motion: mergeMotion(dpad, stick),
    stop: b(1) || b(8), // B (east) or Back/Select = STOP
    rateUp: b(5) || b(7), // RB / RT
    rateDown: b(4) || b(6), // LB / LT
  };
}
