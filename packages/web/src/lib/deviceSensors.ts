// Browser glue for phone sensors: permission, deviceorientation(absolute) events, the optional Generic Sensor
// Magnetometer (field strength), and a dev-only fake source driven by the simulator's /truth.
// All maths lives in @stargazer/shared/sensors.ts.
import { deviceMatrixForTube, eulerFromMatrix, type RawOrientation } from '@stargazer/shared/sensors.ts';

/** Dev/testing: `?fakeSensors` (optionally `=<truth URL>`), `fakeHeadingErr`, `fakeAltErr`, `fakeNoise`, `fakeRoll`. */
export interface FakeSensorConfig {
  truthUrl: string;
  /** Constant compass bias (deg) and altitude bias (deg): the systematic error a real phone would have. */
  headingErrDeg: number;
  altErrDeg: number;
  /** Per-sample Gaussian noise (deg) on heading; altitude gets a tenth of it. */
  noiseDeg: number;
  rollDeg: number;
}

const params = (): URLSearchParams => {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
};
// read once at load: other code rewrites the URL (layout params)
const BOOT_PARAMS = typeof window !== 'undefined' ? params() : new URLSearchParams();

export function fakeSensorConfig(q: URLSearchParams = BOOT_PARAMS): FakeSensorConfig | null {
  if (!q.has('fakeSensors')) return null;
  const num = (k: string, d: number) => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) ? v : d;
  };
  const url = q.get('fakeSensors');
  const host = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1';
  return {
    truthUrl: url && /^https?:\/\//.test(url) ? url : `http://${host}:2001/truth`,
    headingErrDeg: num('fakeHeadingErr', 3),
    altErrDeg: num('fakeAltErr', 0.3),
    noiseDeg: num('fakeNoise', 0.4),
    rollDeg: num('fakeRoll', 8),
  };
}

type OrientationCtor = { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> };

/** Real sensors are possible: secure context (HTTPS or localhost) and the DeviceOrientation API. */
export function realSensorsSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true && 'DeviceOrientationEvent' in window;
}

/** iOS 13+: permission must be requested from a user tap. */
export function needsPermission(): boolean {
  const C = (typeof window !== 'undefined' ? (window as unknown as { DeviceOrientationEvent?: OrientationCtor }).DeviceOrientationEvent : undefined);
  return typeof C?.requestPermission === 'function';
}

/** Call from a click/tap handler. */
export async function requestSensorPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!realSensorsSupported()) return 'unsupported';
  const C = (window as unknown as { DeviceOrientationEvent: OrientationCtor }).DeviceOrientationEvent;
  if (typeof C.requestPermission !== 'function') return 'granted';
  try {
    const r = await C.requestPermission();
    // motion permission too (some iOS versions gate compass accuracy on it); ignore failures
    const M = (window as unknown as { DeviceMotionEvent?: OrientationCtor }).DeviceMotionEvent;
    if (typeof M?.requestPermission === 'function') await M.requestPermission().catch(() => 'denied');
    return r === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

export interface SensorCallbacks {
  onOrientation(raw: RawOrientation, t: number): void;
  /** Magnetic field magnitude (µT) when the browser exposes a Magnetometer. */
  onField?(microTesla: number): void;
  onError?(message: string): void;
}

interface OrientationEventLike {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute?: boolean;
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

/** Listen to the phone's orientation. Returns a stop function. */
export function startRealSensors(cb: SensorCallbacks): () => void {
  let sawAbsolute = false;
  const toRaw = (e: OrientationEventLike, absolute: boolean): RawOrientation => ({
    alpha: e.alpha, beta: e.beta, gamma: e.gamma, absolute,
    webkitCompassHeading: e.webkitCompassHeading ?? null, webkitCompassAccuracy: e.webkitCompassAccuracy ?? null,
  });
  // Android Chrome: absolute alpha (magnetic north) on its own event
  const onAbs = (ev: Event) => {
    sawAbsolute = true;
    cb.onOrientation(toRaw(ev as unknown as OrientationEventLike, true), performance.now());
  };
  // iOS: webkitCompassHeading on the plain event; Firefox: plain event with absolute = true
  const onRel = (ev: Event) => {
    const e = ev as unknown as OrientationEventLike;
    if (sawAbsolute && e.webkitCompassHeading == null) return; // the absolute stream is better
    cb.onOrientation(toRaw(e, e.absolute === true), performance.now());
  };
  window.addEventListener('deviceorientationabsolute', onAbs);
  window.addEventListener('deviceorientation', onRel);

  // Generic Sensor API magnetometer (Chrome Android behind a flag; elsewhere absent): field strength only
  let mag: { start(): void; stop(): void; x?: number; y?: number; z?: number; addEventListener(t: string, f: () => void): void } | null = null;
  const MagCtor = (window as unknown as { Magnetometer?: new (o: { frequency: number }) => typeof mag }).Magnetometer;
  if (MagCtor && cb.onField) {
    try {
      mag = new MagCtor({ frequency: 5 });
      mag!.addEventListener('reading', () => {
        const { x, y, z } = mag!;
        if (x != null && y != null && z != null) cb.onField!(Math.hypot(x, y, z));
      });
      mag!.addEventListener('error', () => { /* permission or unsupported: ignore */ });
      mag!.start();
    } catch {
      mag = null;
    }
  }
  return () => {
    window.removeEventListener('deviceorientationabsolute', onAbs);
    window.removeEventListener('deviceorientation', onRel);
    try { mag?.stop(); } catch { /* ignore */ }
  };
}

const gauss = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-12)) * Math.cos(2 * Math.PI * Math.random());

/**
 * Fake phone on the simulator's tube: reads where the tube truly points (GET /truth), turns it into the
 * magnetic heading a phone would see (true az − declination), adds a constant bias plus noise, and emits the
 * deviceorientationabsolute event an Android phone would fire. Dev/testing only.
 */
export function startFakeSensors(cfg: FakeSensorConfig, declinationDeg: () => number, cb: SensorCallbacks): () => void {
  let stopped = false;
  let busy = false;
  let failures = 0;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const r = await fetch(cfg.truthUrl, { cache: 'no-store' });
      const t = (await r.json()) as { sky: { az: number; alt: number } | null };
      if (!t.sky) throw new Error('simulator truth has no sky position');
      failures = 0;
      const mag = t.sky.az - declinationDeg() + cfg.headingErrDeg + gauss() * cfg.noiseDeg;
      const alt = t.sky.alt + cfg.altErrDeg + gauss() * cfg.noiseDeg * 0.1;
      const e = eulerFromMatrix(deviceMatrixForTube(mag, alt, cfg.rollDeg));
      if (!stopped) cb.onOrientation({ alpha: e.alpha, beta: e.beta, gamma: e.gamma, absolute: true }, performance.now());
    } catch (e) {
      if (++failures === 5) cb.onError?.(`fake sensors: cannot read ${cfg.truthUrl} (${(e as Error).message})`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 100);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
