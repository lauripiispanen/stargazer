// GUI-side safety helpers (SAFETY.md). The server enforces everything; the GUI explains and pre-empts,
// using the limits the server reports in MountState.limits (defaults below until the first state). Pure.
import { STOP_FAILED_MESSAGE, type AlignmentState, type MountHealth, type MountLimits, type MountState } from '@stargazer/shared/api.ts';

/** Server config defaults (packages/server/src/config.ts), used until the server reports its own. */
export const DEFAULT_LIMITS: MountLimits = {
  altDeg: [-5, 70],
  sunDeg: 20,
  sunUpAltDeg: -6,
  azSoftDeg: 200,
  azHardDeg: 240,
  solarFilterMode: false,
  settleMs: 2500,
};
export const HEARTBEAT_MS = 200;

export function mountLimits(s: Pick<MountState, 'limits'> | null | undefined): MountLimits {
  return s?.limits ?? DEFAULT_LIMITS;
}

export function mountHealth(s: Pick<MountState, 'health'> | null | undefined): MountHealth | null {
  const h = s?.health;
  return h && typeof h === 'object' ? { ...h, warnings: Array.isArray(h.warnings) ? h.warnings : [] } : null;
}

export function sunIsUp(sunAlt: number | null | undefined, limits: MountLimits = DEFAULT_LIMITS): boolean {
  return sunAlt != null && sunAlt > limits.sunUpAltDeg;
}

/** Automatic (server-initiated) slews are blocked while the Sun is up and alignment is none/rough. */
export function autoSlewBlocked(sunAlt: number | null | undefined, quality: AlignmentState['quality'] | undefined, limits: MountLimits = DEFAULT_LIMITS): boolean {
  return sunIsUp(sunAlt, limits) && quality !== 'aligned';
}

export interface GotoCheck {
  connected: boolean;
  quality?: AlignmentState['quality'];
  /** Does the server know the observer location? (false blocks; undefined = don't check) */
  locationKnown?: boolean;
  fault?: string;
  observer?: boolean;
  sunAlt: number | null;
  sunSepDeg: number | null;
  isSun?: boolean;
  /** Target altitude now (deg), for the mechanical limit check. */
  targetAlt?: number | null;
  limits?: MountLimits;
}

/**
 * Reason a GoTo button should be disabled, or null if allowed. Mirrors Mount.goto() on the server, in the
 * same order. Targets between the lower limit and the horizon are allowed (the server asks to confirm).
 */
export function gotoBlockReason(c: GotoCheck): string | null {
  const lim = c.limits ?? DEFAULT_LIMITS;
  if (!c.connected) return 'Telescope not connected';
  if (c.observer) return 'A hand controller is attached: Stargazer is read-only';
  if (c.fault) return `Fault: ${c.fault}. Check the telescope, then press STOP to acknowledge.`;
  if (!c.quality || c.quality === 'none') return 'Do “Home” first (Align tab): the mount does not know where level and north are yet';
  if (c.locationKnown === false) return 'Set your location first (Location tab)';
  if (autoSlewBlocked(c.sunAlt, c.quality, lim)) return 'Sun is up and the mount is not star-aligned: automatic slews are blocked. Use the slew pad.';
  if (!lim.solarFilterMode) {
    if (c.isSun) return 'GoTo to the Sun is refused (needs solar-filter mode on the server)';
    if (c.sunSepDeg != null && c.sunSepDeg < lim.sunDeg) return `Within ${lim.sunDeg}° of the Sun (${c.sunSepDeg.toFixed(0)}°): GoTo disabled to protect your eyes and the optics`;
  }
  if (c.targetAlt != null) {
    const [lo, hi] = lim.altDeg;
    if (c.targetAlt > hi) return `Too high: ${c.targetAlt.toFixed(0)}° is above the ${hi}° altitude limit (the tube could hit the mount)`;
    if (c.targetAlt < lo) return `Below the horizon (${c.targetAlt.toFixed(0)}°, limit ${lo}°)`;
  }
  return null;
}

/** Does a server error/log message indicate that stopping the mount failed? (health.stopFailed is preferred) */
export function isStopFailure(message: string): boolean {
  return message === STOP_FAILED_MESSAGE || /stop\s*(has\s*)?failed|failed\s*to\s*stop|unplug\s*(the\s*)?(telescope\s*)?power|cut\s*power|still\s*moving\s*after\s*stop/i.test(message);
}

export interface WrapGauge { fraction: number; level: 'ok' | 'warn' | 'soft' | 'hard' }
/** Cable-wrap gauge from the unwrapped azimuth (deg, 0 = neutral). fraction is -1..1 of the soft limit. */
export function wrapGauge(unwrappedAz: number, limits: MountLimits = DEFAULT_LIMITS): WrapGauge {
  const a = Math.abs(unwrappedAz);
  const { azSoftDeg: soft, azHardDeg: hard } = limits;
  const level = a >= hard ? 'hard' : a >= soft ? 'soft' : a >= soft * 0.75 ? 'warn' : 'ok';
  return { fraction: Math.max(-1.2, Math.min(1.2, unwrappedAz / soft)), level };
}
