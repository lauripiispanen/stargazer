// React hook around the phone sensors: start/stop, a rolling buffer of tube readings, a throttled live view,
// stability / interference indicators and a timed capture.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fieldStrengthWarning, maxHeadingJump, readingFromOrientation, recentReadings, stabilityScore, summarizeReadings,
  type RawOrientation, type SensorCapture, type TimedReading,
} from '@stargazer/shared/sensors.ts';
import { magneticField } from '@stargazer/shared/wmm.ts';
import { fakeSensorConfig, realSensorsSupported, requestSensorPermission, startFakeSensors, startRealSensors } from '../lib/deviceSensors.ts';

export type SensorStatus = 'idle' | 'starting' | 'running' | 'denied' | 'unsupported' | 'no-data' | 'error';

export interface LiveSensors {
  reading: TimedReading | null;
  /** Last raw angles (for the tripod level check). */
  raw: RawOrientation | null;
  /** 0..1 over the last second. */
  stability: number;
  /** Largest heading jump (deg) over the last 2 s while the altitude held still. */
  jumpDeg: number;
  fieldWarning: string | null;
}

const BUFFER_MS = 10_000;

/** Is a "Sensors" step possible on this page? Fake mode counts (it is gated on the simulator by the caller). */
export function sensorsAvailable(): boolean {
  return realSensorsSupported() || fakeSensorConfig() !== null;
}

export function useTubeSensors(loc: { lat: number; lon: number; elevation?: number }) {
  const fake = fakeSensorConfig();
  const [status, setStatus] = useState<SensorStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveSensors>({ reading: null, raw: null, stability: 0, jumpDeg: 0, fieldWarning: null });
  const buf = useRef<TimedReading[]>([]);
  const lastRaw = useRef<RawOrientation | null>(null);
  const field = useRef<number | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const locRef = useRef(loc);
  locRef.current = loc;

  const mf = magneticField(loc.lat, loc.lon, Date.now(), (loc.elevation ?? 0) / 1000);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
  }, []);

  /** Must be called from a tap (iOS permission prompt). */
  const start = useCallback(async () => {
    if (stopRef.current) return;
    setError(null);
    setStatus('starting');
    const onOrientation = (raw: RawOrientation, t: number) => {
      const r = readingFromOrientation(raw);
      if (!r) return;
      lastRaw.current = raw;
      buf.current.push({ ...r, t });
      const cut = t - BUFFER_MS;
      while (buf.current.length && buf.current[0]!.t < cut) buf.current.shift();
    };
    const cbs = { onOrientation, onField: (uT: number) => { field.current = uT; }, onError: (m: string) => { setError(m); setStatus('error'); } };
    if (fake) {
      stopRef.current = startFakeSensors(fake, () => magneticField(locRef.current.lat, locRef.current.lon, Date.now()).declinationDeg, cbs);
    } else {
      const p = await requestSensorPermission();
      if (p !== 'granted') { setStatus(p); return; }
      stopRef.current = startRealSensors(cbs);
    }
    setStatus('running');
  }, [fake]);

  // throttled live view (5 Hz) + "no data" detection
  useEffect(() => {
    if (status !== 'running' && status !== 'no-data') return;
    const t0 = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const b = buf.current;
      if (!b.length) {
        if (now - t0 > 3000) setStatus('no-data');
        return;
      }
      if (status === 'no-data') setStatus('running');
      const last = b[b.length - 1]!;
      setLive({
        reading: now - last.t < 2000 ? last : null,
        raw: lastRaw.current,
        stability: stabilityScore(recentReadings(b, now, 1000)),
        jumpDeg: maxHeadingJump(recentReadings(b, now, 2000)),
        fieldWarning: fieldStrengthWarning(field.current, mf.f),
      });
    }, 200);
    return () => clearInterval(timer);
  }, [status, mf.f]);

  useEffect(() => stop, [stop]);

  /** Average `ms` of readings from now on (hold still). */
  const capture = useCallback(async (ms = 3000): Promise<SensorCapture> => {
    const from = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    const win = buf.current.filter((r) => r.t >= from);
    return summarizeReadings(win);
  }, []);

  return { status, error, live, start, stop, capture, fake, declinationDeg: mf.declinationDeg, field: mf, inValidity: mf.inValidity };
}
