// Fake Astro Fi: AUX device behaviour (motor controllers 0x10/0x11, WiFi bridge 0xB5) plus hidden "truth".
import type { GeoLocation, PointingModelParams, SimulatorTruth } from '@stargazer/shared/api.ts';
import { altAzToRaDec } from '@stargazer/shared/astro.ts';
import { encoderToSky } from '@stargazer/shared/pointing.ts';
import {
  AuxCmd,
  AuxDevice,
  type AuxPacket,
  decodeGuideRate,
  decodePosition,
  DEFAULT_RATE_SCALE,
  encodePosition,
  readBe16,
} from '@stargazer/shared/aux.ts';
import { MotorAxis, type MotorParams } from './motor.ts';

export interface SimConfig {
  host: string;
  auxPort: number;
  httpPort: number;
  /** Echo every received packet back before the response (Evolution behaviour). */
  echo: boolean;
  /** Write echo + response in one TCP write (as the real bridge tends to). */
  coalesce: boolean;
  latencyMs: number;
  jitterMs: number;
  slewRates: number[];
  maxRateDeg: number;
  slowRateDeg: number;
  accelDeg: number;
  altLimits: [number, number];
  trackingScale: number;
  gotoCancelsGuide: boolean;
  /** GET_AUTOGUIDE_RATE answered with CMD 0xF0, data 0x47 (Evolution quirk). */
  autoguideQuirk: boolean;
  location: { lat: number; lon: number; elevation?: number };
  /** Hidden mount errors relating the physical axes to the sky (same definitions as pointing.ts). */
  hidden: PointingModelParams;
  /** At start: encoders 0,0 and a random physical orientation / mount errors. */
  realistic: boolean;
  verbose: boolean;
  firmware: number[];
  model: number[];
  wifiVersion: number[];
  /** Only one TCP client; a new connection replaces the old one. */
  singleClient: boolean;
  /** Emulate the Evolution battery device 0xB6 (absent on a real Astro Fi). */
  battery: boolean;
  batteryVolts: number;
}

/** SimulatorTruth, but `sky` is null while the shared astro/pointing functions are unavailable. */
export type TruthResponse = Omit<SimulatorTruth, 'sky'> & { sky: SimulatorTruth['sky'] | null; skyError?: string };

export const DEFAULT_SLEW_RATES = [0, 0.008, 0.017, 0.033, 0.067, 0.133, 0.5, 1, 2, 3];

export const DEFAULT_SIM_CONFIG: SimConfig = {
  host: '127.0.0.1',
  auxPort: 2000,
  httpPort: 2001,
  echo: true,
  coalesce: true,
  latencyMs: 15,
  jitterMs: 5,
  slewRates: DEFAULT_SLEW_RATES,
  maxRateDeg: 3,
  slowRateDeg: 0.5,
  accelDeg: 4,
  altLimits: [-20, 110],
  trackingScale: DEFAULT_RATE_SCALE,
  gotoCancelsGuide: false,
  autoguideQuirk: true,
  location: { lat: 60.17, lon: 24.94, elevation: 0 },
  hidden: { IA: 0, IE: 0, AN: 0, AW: 0, CA: 0, NPAE: 0 },
  realistic: false,
  verbose: false,
  firmware: [7, 15, 0x1f, 0xe0], // 7.15.8160
  model: [0x07, 0x83],
  wifiVersion: [2, 40, 0, 0],
  singleClient: true,
  battery: false,
  batteryVolts: 12.1,
};

export const BATTERY_DEVICE = 0xb6;

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export class Simulator {
  readonly cfg: SimConfig;
  readonly az: MotorAxis;
  readonly alt: MotorAxis;
  /** Physics clock in ms (replaceable for deterministic tests). */
  clock: () => number = () => performance.now();
  private lastAdvance = this.clock();
  /** Optional clock offset for the sky truth. */
  timeOffsetMs = 0;

  constructor(cfg: Partial<SimConfig> = {}) {
    this.cfg = { ...DEFAULT_SIM_CONFIG, ...cfg };
    const params = (): MotorParams => this.cfg;
    this.az = new MotorAxis('az', params);
    this.alt = new MotorAxis('alt', params);
    this.alt.approach = 1;
    if (this.cfg.realistic) this.randomizeOrientation();
  }

  /** Integrate physics up to now (called by the 20 Hz ticker and before every query). */
  advance(now = this.clock()): void {
    let dt = (now - this.lastAdvance) / 1000;
    if (dt <= 0) return;
    this.lastAdvance = now;
    // Sub-step long gaps so the goto profile stays stable.
    while (dt > 0) {
      const step = Math.min(dt, 0.05);
      this.az.tick(step);
      this.alt.tick(step);
      dt -= step;
    }
  }

  axis(dev: number): MotorAxis | null {
    return dev === AuxDevice.AZM ? this.az : dev === AuxDevice.ALT ? this.alt : null;
  }

  /** Process one request; returns the response packet, or null if the device/command is unknown. */
  handle(req: AuxPacket): AuxPacket | null {
    this.advance();
    const reply = (data: number[] = [], cmd = req.cmd): AuxPacket => ({ src: req.dst, dst: req.src, cmd, data: Uint8Array.from(data) });

    if (req.dst === AuxDevice.WIFI) return req.cmd === AuxCmd.GET_VER ? reply(this.cfg.wifiVersion) : null;
    if (req.dst === BATTERY_DEVICE && this.cfg.battery) {
      if (req.cmd === AuxCmd.GET_VER) return reply([1, 2, 0, 3]);
      if (req.cmd === 0x10 && req.data.length === 0) {
        // [s0 charging state][s1 level][uint32 BE microvolts] (Evolution capture format)
        const uv = Math.round(this.cfg.batteryVolts * 1e6);
        const level = this.cfg.batteryVolts < 10.5 ? 0 : this.cfg.batteryVolts < 11.5 ? 1 : 2;
        return reply([0, level, (uv >>> 24) & 0xff, (uv >>> 16) & 0xff, (uv >>> 8) & 0xff, uv & 0xff]);
      }
      return null;
    }
    const ax = this.axis(req.dst);
    if (!ax) return null;
    const d = req.data;
    const isAz = ax.kind === 'az';

    switch (req.cmd) {
      case AuxCmd.GET_VER:
        return reply(this.cfg.firmware);
      case AuxCmd.GET_MODEL:
        return reply(this.cfg.model);
      case AuxCmd.GET_POSITION:
        return reply(encodePosition(ax.encoder));
      case AuxCmd.SET_POSITION:
        if (d.length < 2) return null;
        ax.setEncoder(decodePosition(d, !isAz));
        return reply();
      case AuxCmd.GOTO_FAST:
      case AuxCmd.GOTO_SLOW:
        if (d.length < 2) return null;
        ax.goto(decodePosition(d, !isAz), req.cmd === AuxCmd.GOTO_FAST);
        return reply();
      case AuxCmd.SLEW_DONE:
        return reply([ax.slewing ? 0x00 : 0xff]);
      case AuxCmd.MOVE_POS:
      case AuxCmd.MOVE_NEG:
        if (d.length < 1) return null;
        ax.move(req.cmd === AuxCmd.MOVE_POS ? 1 : -1, d[0]!);
        return reply();
      case AuxCmd.SET_POS_GUIDERATE:
      case AuxCmd.SET_NEG_GUIDERATE: {
        if (d.length < 2) return null;
        const arcsec = decodeGuideRate(d, this.cfg.trackingScale);
        ax.guideRate = ((req.cmd === AuxCmd.SET_POS_GUIDERATE ? 1 : -1) * arcsec) / 3600;
        return reply();
      }
      case AuxCmd.SET_POS_BACKLASH:
        ax.backlashPos = d[0] ?? 0;
        return reply();
      case AuxCmd.SET_NEG_BACKLASH:
        ax.backlashNeg = d[0] ?? 0;
        return reply();
      case AuxCmd.GET_POS_BACKLASH:
        return reply([ax.backlashPos]);
      case AuxCmd.GET_NEG_BACKLASH:
        return reply([ax.backlashNeg]);
      case AuxCmd.GET_APPROACH:
        return reply([ax.approach]);
      case AuxCmd.SET_APPROACH:
        ax.approach = d[0] ?? 0;
        return reply();
      case AuxCmd.SET_MAXRATE:
        if (d.length >= 2) ax.maxRateReg = readBe16(d);
        return reply();
      case AuxCmd.GET_MAXRATE:
        return reply([(ax.maxRateReg >> 8) & 0xff, ax.maxRateReg & 0xff, 0x11, 0x94]);
      case AuxCmd.ENABLE_MAXRATE:
        ax.maxRateEnabled = (d[0] ?? 0) !== 0;
        return reply();
      case AuxCmd.MAXRATE_ENABLED:
        return reply([ax.maxRateEnabled ? 0x01 : 0x00]);
      case AuxCmd.LEVEL_START:
        return isAz ? null : reply();
      case AuxCmd.LEVEL_DONE:
        return isAz ? null : reply([0xff]);
      case AuxCmd.SEEK_INDEX:
        return reply();
      case AuxCmd.SEEK_DONE:
        return reply([0xff]);
      case AuxCmd.AUX_GUIDE:
        return reply();
      case AuxCmd.AUX_GUIDE_ACTIVE:
        return reply([0x00]);
      case AuxCmd.SET_AUTOGUIDE_RATE:
        ax.autoguideRate = d[0] ?? 0;
        return reply();
      case AuxCmd.GET_AUTOGUIDE_RATE:
        return this.cfg.autoguideQuirk ? reply([AuxCmd.GET_AUTOGUIDE_RATE], AuxCmd.QUIRK_F0) : reply([ax.autoguideRate]);
      // Cordwrap is AZM only.
      case AuxCmd.ENABLE_CORDWRAP:
        if (!isAz) return null;
        ax.cordwrapEnabled = true;
        return reply();
      case AuxCmd.DISABLE_CORDWRAP:
        if (!isAz) return null;
        ax.cordwrapEnabled = false;
        return reply();
      case AuxCmd.SET_CORDWRAP_POS:
        if (!isAz || d.length < 2) return null;
        ax.cordwrapPosDeg = decodePosition(d, false);
        return reply();
      case AuxCmd.POLL_CORDWRAP:
        return isAz ? reply([ax.cordwrapEnabled ? 0xff : 0x00]) : null;
      case AuxCmd.GET_CORDWRAP_POS:
        return isAz ? reply(encodePosition(ax.cordwrapPosDeg)) : null;
      default:
        return null; // unknown command: echo only
    }
  }

  /** Random physical orientation at power-on; encoders read 0,0. */
  randomizeOrientation(): void {
    this.cfg.hidden = {
      IA: rand(0, 360),
      IE: rand(-10, 30),
      AN: rand(-0.7, 0.7),
      AW: rand(-0.7, 0.7),
      CA: rand(-0.3, 0.3),
      NPAE: rand(-0.1, 0.1),
    };
    for (const ax of [this.az, this.alt]) {
      ax.reset();
      ax.pos = 0;
      ax.offset = 0;
    }
  }

  /** Power cycle: motion stops, registers reset, encoders read 0,0; physical orientation is kept. */
  powerCycle(): void {
    this.advance();
    for (const ax of [this.az, this.alt]) {
      ax.reset();
      ax.offset = -ax.pos;
    }
  }

  get geoLocation(): GeoLocation {
    const l = this.cfg.location;
    return { lat: l.lat, lon: l.lon, elevation: l.elevation ?? 0, source: 'manual', label: 'simulator' };
  }

  truth(now = Date.now() + this.timeOffsetMs): TruthResponse {
    this.advance();
    const encoder = { az: this.az.encoder, alt: this.alt.encoder };
    const physical = { az: ((this.az.pos % 360) + 360) % 360, alt: this.alt.pos };
    let sky: TruthResponse['sky'] = null;
    let skyError: string | undefined;
    try {
      const altAz = encoderToSky(physical, this.cfg.hidden);
      const radec = altAzToRaDec(altAz, this.geoLocation, now);
      sky = { ra: radec.ra, dec: radec.dec, az: altAz.az, alt: altAz.alt };
    } catch (e) {
      skyError = (e as Error).message; // astro/pointing still stubs
    }
    return {
      encoder,
      sky,
      ...(skyError ? { skyError } : {}),
      hidden: { ...this.cfg.hidden },
      location: { lat: this.cfg.location.lat, lon: this.cfg.location.lon },
    };
  }

  /** Apply a partial config (POST /config). */
  updateConfig(patch: Partial<SimConfig>): void {
    this.advance();
    const { hidden, location, ...rest } = patch;
    Object.assign(this.cfg, rest);
    if (hidden) this.cfg.hidden = { ...this.cfg.hidden, ...hidden };
    if (location) this.cfg.location = { ...this.cfg.location, ...location };
  }

  /** Raw state for tests/diagnostics. */
  status() {
    const s = (ax: MotorAxis) => ({
      encoder: ax.encoder,
      velocity: ax.velocity,
      guideRateArcsec: ax.guideRate * 3600,
      mode: ax.mode.kind,
      slewing: ax.slewing,
    });
    return { az: s(this.az), alt: s(this.alt) };
  }
}
