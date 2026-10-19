import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Axis } from '@stargazer/shared/api.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningSimulator, startSimulator } from '../../simulator/src/server.ts';
import type { SimConfig } from '../../simulator/src/sim.ts';
import { type AstroApi, wrap180 } from './astroApi.ts';
import { loadConfig, type ServerConfig } from './config.ts';
import { type LogEntry, Mount, STOP_FAILED } from './mount.ts';
import { StateStore } from './persist.ts';
import { fakeAstro, sleep, TEST_LOCATION, waitFor } from './testing.ts';

let sim: RunningSimulator | undefined;
let mounts: Mount[] = [];

afterEach(async () => {
  for (const m of mounts) await m.dispose();
  mounts = [];
  await sim?.close();
  sim = undefined;
});

interface SetupOpts {
  store?: StateStore;
  cfg?: Partial<ServerConfig>;
  sim?: Partial<SimConfig>;
  astro?: AstroApi;
}

async function setup(opts: SetupOpts = {}) {
  sim = await startSimulator({ auxPort: 0, http: false, latencyMs: 2, jitterMs: 1, slowRateDeg: 1, log: () => {}, ...opts.sim });
  const config = loadConfig(
    {},
    {
      telescopeHost: '127.0.0.1',
      telescopePort: sim.auxPort,
      stateFile: null,
      packetLogFile: null,
      gotoApproachOffsetDeg: 0.5,
      gotoSlowRateDegPerSec: 1,
      gotoAccelDegPerSec2: 4,
      pollIntervalMs: 100,
      trackingPeriodMs: 300,
      requestTimeoutMs: 300,
      discoveryTimeoutMs: 20,
      settleMs: 0,
      ...opts.cfg,
    },
  );
  const astro = opts.astro ?? fakeAstro();
  const mount = new Mount({ config, astro, store: opts.store ?? null, consoleLog: false });
  mounts.push(mount);
  await mount.connect();
  return { mount, astro, sim: sim.sim };
}

const simEnc = () => ({ az: sim!.sim.az.encoder, alt: sim!.sim.alt.encoder });

/** Press-and-hold with 150 ms heartbeats, then release. Errors (e.g. a latched fault) end the hold. */
async function hold(mount: Mount, axis: Axis, dir: 1 | -1, rate: number, ms: number, release = true) {
  const end = Date.now() + ms;
  try {
    while (Date.now() < end) {
      await mount.move(axis, dir, rate);
      await sleep(150);
    }
  } catch {
    /* refused */
  }
  if (release) await mount.stopAxis(axis);
}

describe('Mount basics', () => {
  it('connects, reads firmware, runs discovery and polls positions', async () => {
    const { mount } = await setup({ sim: { echo: false } });
    const s = mount.getState();
    expect(s.connection).toBe('connected');
    expect(s.firmware).toMatchObject({ az: '7.15.8160', alt: '7.15.8160', wifi: '2.40.0' });
    expect(s.encoder).toEqual({ az: 0, alt: 0 });
    expect(s.simulator).toBe(true);
    expect(s.health?.warnings).toEqual([]);
    expect(s.limits).toMatchObject({ altDeg: [-5, 70], sunDeg: 20, azSoftDeg: 200, azHardDeg: 240 });
    expect(sim!.sim.az.cordwrapEnabled).toBe(false);
    await waitFor(() => mount.getState().health?.battery === null, 2000);
    sim!.sim.az.setEncoder(12.5);
    await waitFor(() => Math.abs((mount.getState().encoder?.az ?? 0) - 12.5) < 1e-3, 1000);
    expect(mount.getState().health?.unwrappedAz).toBeCloseTo(12.5, 3);
  });

  it('reads battery telemetry when 0xB6 exists, and warns about old firmware', async () => {
    const { mount } = await setup({ sim: { battery: true, batteryVolts: 11.2, firmware: [7, 13, 0x17, 0xde] } });
    await waitFor(() => !!mount.getState().health?.battery, 2000);
    expect(mount.getState().health!.battery).toEqual({ volts: 11.2, level: 'MEDIUM', charging: false });
    expect(mount.getState().health!.warnings.join()).toMatch(/older than 7\.15\.8160/);
  });

  it('manual move and release', async () => {
    const { mount } = await setup();
    const moving = hold(mount, 'az', 1, 8, 600);
    await sleep(100);
    expect(mount.getState().slew).toBe('manual');
    await moving;
    expect(mount.getState().slew).toBe('idle');
    await waitFor(() => !sim!.sim.az.slewing, 2000);
    expect(simEnc().az).toBeGreaterThan(0.2);
    await hold(mount, 'alt', -1, 7, 300);
    await waitFor(() => !sim!.sim.alt.slewing, 2000);
    expect(simEnc().alt).toBeLessThan(-0.05);
  });

  it('dead-man stops a move without heartbeats', async () => {
    const { mount } = await setup();
    await mount.move('az', 1, 6);
    await sleep(300);
    expect(sim!.sim.az.slewing).toBe(true);
    await waitFor(() => !mount.getState().slew.startsWith('manual'), 1500);
    await waitFor(() => !sim!.sim.az.slewing, 1500);
  });

  it('caps manual rate and limits alt motion while the altitude reference is unknown', async () => {
    const { mount } = await setup({ cfg: { unknownAltEnvelopeDeg: 1 } });
    await hold(mount, 'alt', 1, 9, 2500);
    await waitFor(() => !sim!.sim.alt.slewing, 2000);
    expect(simEnc().alt).toBeLessThan(1.05); // stopped predictively at the ±1° test envelope
    expect(simEnc().alt).toBeGreaterThan(0.5);
    await expect(mount.move('alt', 1, 6)).rejects.toThrow(/limit/);
  });
});

describe('GoTo and tracking', () => {
  it('refuses GoTo without alt reference / location, confirms below the horizon, refuses mechanical limits', async () => {
    const { mount } = await setup();
    await expect(mount.goto({ kind: 'radec', ra: 5, dec: 5, name: 'X' })).rejects.toThrow(/Home/);
    mount.alignHome();
    expect(mount.getState().alignment.quality).toBe('rough');
    await expect(mount.goto({ kind: 'radec', ra: 5, dec: 5, name: 'X' })).rejects.toThrow(/location/i);
    mount.setLocation(TEST_LOCATION);
    expect(await mount.goto({ kind: 'radec', ra: 5, dec: -3, name: 'Low' })).toMatchObject({ status: 'confirm' });
    await expect(mount.goto({ kind: 'radec', ra: 5, dec: -10, name: 'Lower' })).rejects.toThrow(/mechanical/);
    await expect(mount.goto({ kind: 'radec', ra: 5, dec: 80, name: 'Zenith' })).rejects.toThrow(/mechanical/);
  });

  it('GoTo reaches the target and starts tracking with sensible rates', async () => {
    const { mount, astro } = await setup();
    mount.setLocation(TEST_LOCATION);
    mount.alignHome();
    const target = { kind: 'radec' as const, ra: 4, dec: 3, name: 'Test star' };
    const r = await mount.goto(target);
    expect(r).toMatchObject({ status: 'done', route: 'simultaneous' });
    const sky = astro.targetAltAz(target, TEST_LOCATION, Date.now());
    expect(Math.abs(wrap180(simEnc().az - sky.az))).toBeLessThan(0.02);
    expect(Math.abs(simEnc().alt - sky.alt)).toBeLessThan(0.02);
    expect(mount.getState()).toMatchObject({ tracking: true, slew: 'idle', target });

    await sleep(1500);
    // Toy sky drifts +15″/s in azimuth, nothing in altitude.
    expect(sim!.sim.az.guideRate * 3600).toBeGreaterThan(10);
    expect(sim!.sim.az.guideRate * 3600).toBeLessThan(25);
    expect(Math.abs(sim!.sim.alt.guideRate * 3600)).toBeLessThan(5);
    const sky2 = astro.targetAltAz(target, TEST_LOCATION, Date.now());
    expect(Math.abs(wrap180(simEnc().az - sky2.az)) * 3600).toBeLessThan(20);
    const p = mount.getState().pointing!;
    expect(p.ra).toBeCloseTo(4, 1);
    expect(p.dec).toBeCloseTo(3, 1);
    expect(mount.getState().health!.warnings).toEqual([]);

    await mount.setTracking(false);
    expect(sim!.sim.az.guideRate).toBe(0);
  }, 20_000);

  it('never sends a guide rate while a GOTO runs', async () => {
    const { mount } = await setup();
    mount.setLocation(TEST_LOCATION);
    mount.alignHome();
    let violation = false;
    const check = setInterval(() => {
      for (const ax of [sim!.sim.az, sim!.sim.alt]) if (ax.mode.kind === 'goto' && ax.guideRate !== 0) violation = true;
    }, 5);
    await mount.setTracking(true);
    await waitFor(() => sim!.sim.az.guideRate !== 0, 2000);
    await mount.goto({ kind: 'radec', ra: 3, dec: 2, name: 'T' });
    clearInterval(check);
    expect(violation).toBe(false);
  }, 15_000);

  it('stop halts a GoTo in progress (sent twice and verified)', async () => {
    const { mount } = await setup();
    mount.setLocation(TEST_LOCATION);
    mount.alignHome();
    const result = mount.goto({ kind: 'radec', ra: 60, dec: 30, name: 'Far' });
    await waitFor(() => sim!.sim.az.slewing, 2000);
    await sleep(500);
    await mount.stop();
    expect(await result).toEqual({ status: 'cancelled' });
    expect(sim!.sim.az.slewing || sim!.sim.alt.slewing).toBe(false);
    const a = simEnc();
    await sleep(400);
    expect(Math.abs(simEnc().az - a.az)).toBeLessThan(1e-3);
    expect(a.az).toBeLessThan(30);
    expect(mount.getState()).toMatchObject({ slew: 'idle', tracking: false });
  });

  it('manual move while tracking suspends that axis and resumes tracking afterwards', async () => {
    const { mount } = await setup({ cfg: { trackingPeriodMs: 200 } });
    mount.setLocation(TEST_LOCATION);
    mount.alignHome();
    await mount.setTracking(true);
    await waitFor(() => sim!.sim.az.guideRate > 0, 2000);
    const h = hold(mount, 'az', 1, 6, 300);
    await sleep(100);
    expect(sim!.sim.az.guideRate).toBe(0);
    await h;
    expect(mount.getState().tracking).toBe(true);
    await waitFor(() => sim!.sim.az.guideRate * 3600 > 10, 4000);
  });

  it('GoTo to an alt-az target uses the rough model and does not track', async () => {
    const { mount } = await setup();
    mount.setLocation(TEST_LOCATION);
    mount.alignHome();
    const r = await mount.goto({ kind: 'altaz', az: 2, alt: 1.5, name: 'Tree' });
    expect(r.status).toBe('done');
    expect(Math.abs(simEnc().az - 2)).toBeLessThan(0.01);
    expect(Math.abs(simEnc().alt - 1.5)).toBeLessThan(0.01);
    expect(mount.getState().tracking).toBe(false);
  }, 15_000);
});

describe('Sun safety', () => {
  it('blocks automatic motion with a rough model while the Sun is up', async () => {
    const { mount } = await setup({ astro: fakeAstro(Date.now(), { az: 200, alt: 5 }) });
    mount.setLocation(TEST_LOCATION);
    mount.alignHome();
    await expect(mount.goto({ kind: 'radec', ra: 5, dec: 5, name: 'X' })).rejects.toThrow(/Sun is up/);
    await expect(mount.setTracking(true)).rejects.toThrow(/Sun is up/);
  });

  it('refuses targets near the Sun and routes GoTo paths around it', async () => {
    const { mount } = await setup({
      astro: fakeAstro(Date.now(), { az: 6, alt: 4 }),
      cfg: { sunSafetyDeg: 5, sunPathKeepoutDeg: 3 },
    });
    const logs: LogEntry[] = [];
    mount.on('log', (e: LogEntry) => logs.push(e));
    mount.setLocation(TEST_LOCATION);
    await mount.alignAddPoint({ kind: 'altaz', az: 0, alt: 0, name: 'Ref' });
    expect(mount.getState().alignment.quality).toBe('aligned');
    await expect(mount.goto({ kind: 'altaz', az: 7, alt: 6, name: 'Hot' })).rejects.toThrow(/Sun/);
    await expect(mount.goto({ kind: 'body', body: 'Sun', name: 'Sun' })).rejects.toThrow(/refused/);
    const r = await mount.goto({ kind: 'altaz', az: 12, alt: 8, name: 'Beyond' });
    expect(r).toMatchObject({ status: 'done', route: 'alt-first' });
  }, 20_000);
});

describe('Motion protection', () => {
  it('detects a stall, latches a fault, and stop acknowledges it', async () => {
    const { mount } = await setup();
    const rates = [...sim!.sim.cfg.slewRates];
    rates[6] = 0.02; // obstruction: commanded 0.5°/s, achieving 0.02°/s
    sim!.sim.updateConfig({ slewRates: rates });
    await hold(mount, 'az', 1, 6, 4000, false);
    expect(mount.getState().health!.warnings[0]).toMatch(/FAULT: Possible obstruction/);
    expect(mount.getState().health!.fault).toMatch(/Possible obstruction/);
    await waitFor(() => !sim!.sim.az.slewing, 2000);
    await expect(mount.move('az', 1, 5)).rejects.toThrow(/Fault/);
    await mount.stop();
    expect(mount.getState().health!.warnings).toEqual([]);
    expect(mount.getState().health!.fault).toBeUndefined();
  }, 10_000);

  it('detects a runaway when an idle axis moves', async () => {
    const { mount } = await setup();
    await sleep(2200); // past the post-command grace period
    sim!.sim.az.mode = { kind: 'move', velocity: 1 };
    await waitFor(() => (mount.getState().health?.warnings[0] ?? '').includes('Runaway'), 3000);
    await waitFor(() => !sim!.sim.az.slewing, 3000);
  }, 10_000);

  it('escalates a stop that does not take and tells the user to cut power', async () => {
    const { mount } = await setup();
    const errors: string[] = [];
    mount.on('alert', (m: string) => errors.push(m));
    sim!.sim.az.move = () => {};
    sim!.sim.az.goto = () => {};
    sim!.sim.az.mode = { kind: 'move', velocity: 0.5 };
    await expect(mount.stop()).rejects.toThrow(STOP_FAILED);
    expect(errors).toContain(STOP_FAILED);
    expect(mount.getState().health?.stopFailed).toBe(true);
  }, 15_000);

  it('stops everything at the hard cable-wrap limit', async () => {
    // Persisted session ended one full turn from cable-neutral (encoder reads 0 again).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stargazer-'));
    const store = new StateStore(path.join(dir, 'state.json'));
    store.save({ location: null, alignment: null, encoder: { az: 0, alt: 0 }, encoderTime: Date.now(), unwrappedAz: 360 });
    const { mount } = await setup({ store });
    expect(mount.getState().health!.unwrappedAz).toBeCloseTo(360, 3);
    await waitFor(() => (mount.getState().health?.warnings[0] ?? '').includes('Cable wrap hard limit'), 2000);
    await expect(mount.move('az', 1, 5)).rejects.toThrow(/Fault/);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('Alignment and persistence', () => {
  it('alignment: add points, sync, remove', async () => {
    const { mount } = await setup();
    mount.setLocation(TEST_LOCATION);
    sim!.sim.az.setEncoder(350);
    sim!.sim.alt.setEncoder(-2);
    await sleep(250);
    await mount.alignAddPoint({ kind: 'altaz', az: 10, alt: 20, name: 'P1' });
    let a = mount.getState().alignment;
    expect(a.quality).toBe('aligned');
    expect(a.params!.IA).toBeCloseTo(20, 2);
    expect(a.params!.IE).toBeCloseTo(22, 2);
    await mount.sync({ kind: 'altaz', az: 11, alt: 20, name: 'S' });
    expect(mount.getState().alignment.params!.IA).toBeCloseTo(21, 2);
    mount.alignRemovePoint(a.points[0]!.id);
    a = mount.getState().alignment;
    expect(a.quality).toBe('none');
  });

  it('detects a power cycle on reconnect and invalidates the alignment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stargazer-'));
    const store = new StateStore(path.join(dir, 'state.json'));
    const { mount } = await setup({ store });
    mount.setLocation(TEST_LOCATION);
    sim!.sim.az.setEncoder(30);
    await sleep(250);
    mount.alignHome();
    await mount.disconnect();
    expect(store.load()!.alignment!.quality).toBe('rough');
    expect(store.load()!.encoder!.az).toBeCloseTo(30, 3);
    expect(store.load()!.unwrappedAz).toBeCloseTo(30, 3);

    // Plain reconnect keeps the alignment and the unwrapped azimuth.
    const m2 = new Mount({ config: mount.config, astro: fakeAstro(), store, consoleLog: false });
    mounts.push(m2);
    await m2.connect();
    expect(m2.getState().alignment.quality).toBe('rough');
    expect(m2.getState().location).toEqual(TEST_LOCATION);
    expect(m2.getState().health!.unwrappedAz).toBeCloseTo(30, 3);
    await m2.disconnect();

    sim!.sim.powerCycle();
    const m3 = new Mount({ config: mount.config, astro: fakeAstro(), store, consoleLog: false });
    mounts.push(m3);
    await m3.connect();
    expect(m3.getState().alignment.quality).toBe('none');
    expect(m3.getState().health!.warnings.join()).toMatch(/cable/);
    fs.rmSync(dir, { recursive: true });
  });

  it('flags a brown-out (encoders reset mid-session)', async () => {
    const { mount } = await setup();
    mount.setLocation(TEST_LOCATION);
    sim!.sim.az.setEncoder(20);
    await sleep(250);
    mount.alignHome();
    sim!.sim.powerCycle();
    await waitFor(() => (mount.getState().health?.warnings[0] ?? '').includes('Power dipped'), 2000);
    expect(mount.getState().alignment.quality).toBe('none');
  });

  it('reports connection loss and reconnects', async () => {
    const { mount } = await setup({ cfg: { reconnectDelayMs: 200 } });
    sim!.dropClients();
    await waitFor(() => mount.getState().connection === 'error', 2000);
    expect(mount.getState().health!.warnings.join()).toMatch(/Connection lost/);
    await waitFor(() => mount.getState().connection === 'connected', 3000);
  });
});

describe('Home from phone sensors', () => {
  it('maps the current encoders to the measured az/alt, records the source and keeps safety the same', async () => {
    const { mount, astro } = await setup();
    mount.setLocation(TEST_LOCATION);
    mount.alignHome(123.4, 20, { source: 'sensors', uncertainty: { azSigmaDeg: 5.2, altSigmaDeg: 0.6 }, magHeadingDeg: 113, declinationDeg: 10.4 });
    const s = mount.getState();
    expect(s.alignment.quality).toBe('rough');
    expect(s.alignment.home).toMatchObject({ source: 'sensors', azDeg: 123.4, altDeg: 20, azSigmaDeg: 5.2, altSigmaDeg: 0.6, magHeadingDeg: 113, declinationDeg: 10.4 });
    // the encoders (0, 0 at power-on) now mean az 123.4°, alt 20°
    const sky = astro.encoderToSky(simEnc(), s.alignment.params!);
    expect(Math.abs(wrap180(sky.az - 123.4))).toBeLessThan(0.01);
    expect(sky.alt).toBeCloseTo(20, 2);
    // mechanical limits follow the measured altitude: level is 20° below the power-on position, so a target
    // at sky alt 3° (encoder −17°) is allowed while 75° (encoder +55°, above the 70° limit) is refused
    expect(await mount.goto({ kind: 'altaz', az: 123.4, alt: 75, name: 'High' }).catch((e: Error) => e.message)).toMatch(/mechanical/);
    expect(s.alignment.home?.time).toBeGreaterThan(0);
    expect(mount.getState().health?.warnings.join() ?? '').not.toMatch(/FAULT/);
  });

  it('refuses a sensor Home when the tube is too steep for the compass', async () => {
    const { mount } = await setup();
    expect(() => mount.alignHome(10, 80, { source: 'sensors' })).toThrow(/sensors refused/);
    expect(mount.getState().alignment.quality).toBe('none');
  });

  it('manual Home stays the default and is labelled', async () => {
    const { mount } = await setup();
    mount.alignHome();
    expect(mount.getState().alignment.home).toMatchObject({ source: 'manual', azDeg: 0, altDeg: 0 });
    mount.alignClear();
    expect(mount.getState().alignment.home).toBeNull();
  });

  it('persists the Home source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-home-'));
    const store = new StateStore(path.join(dir, 'state.json'));
    const { mount } = await setup({ store });
    mount.alignHome(200, 5, { source: 'sensors', uncertainty: { azSigmaDeg: 6, altSigmaDeg: 0.5 } });
    await mount.dispose();
    const saved = store.load();
    expect(saved?.alignment?.homeInfo).toMatchObject({ source: 'sensors', azDeg: 200, altDeg: 5 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
