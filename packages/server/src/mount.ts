// Mount controller: connection lifecycle, polling, manual moves, GoTo, alt-az tracking and the safety
// rules of SAFETY.md (limits, cable wrap, Sun, dead-man, stall/runaway/brown-out, stop verification).
//
// Encoder angles here are "logical" degrees (az increasing N→E, alt increasing up); config.azDirection /
// altDirection map them to raw AUX values. Azimuth is additionally tracked UNWRAPPED from cable-neutral.
import { EventEmitter } from 'node:events';
import { type Axis, type GeoLocation, type HomeSource, type MountHealth, type MountLimits, type MountState, type ObservingListEntry, type SlewState, STOP_FAILED_MESSAGE, type Target } from '@stargazer/shared/api.ts';
import type { AltAz } from '@stargazer/shared/astro.ts';
import { applyListMessage, type ListMessage, sanitizeList } from '@stargazer/shared/observingList.ts';
import { AuxCmd, AuxDevice, decodePosition, deviceName, encodeGuideRate, encodePosition, formatVersion } from '@stargazer/shared/aux.ts';
import { BAT_GET_STATUS, BATTERY_DEVICE, DISCOVERY_DEVICES } from './allowList.ts';
import { Alignment } from './alignment.ts';
import { expectedFirstStarErrorDeg, MAX_SENSOR_ALT_DEG } from '@stargazer/shared/sensors.ts';
import { type AstroApi, clamp, defaultAstro, mod360, sepAltAz, wrap180 } from './astroApi.ts';
import { AuxClient, AuxDisconnectedError, type AuxLink, type RequestOptions } from './auxClient.ts';
import type { ServerConfig } from './config.ts';
import { PacketLog } from './packetLog.ts';
import { candidatePlans, type Kinematics, moveDuration, type Pose, simulate, splitLegs, type Step } from './pathPlanner.ts';
import type { StateStore } from './persist.ts';

/** Extra alignHome fields (api.ts `alignHome`). */
export interface AlignHomeOptions {
  source?: HomeSource;
  uncertainty?: { azSigmaDeg: number; altSigmaDeg: number };
  magHeadingDeg?: number;
  declinationDeg?: number;
}

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogEntry {
  level: LogLevel;
  message: string;
  time: number;
}

export interface MountDeps {
  config: ServerConfig;
  clock?: Clock;
  astro?: AstroApi;
  store?: StateStore | null;
  connectAux?: (host: string, port: number) => Promise<AuxLink>;
  /** Mirror log entries to the console (default true). */
  consoleLog?: boolean;
}

export type GotoResult = { status: 'done'; route?: string } | { status: 'cancelled' } | { status: 'confirm'; message: string };

type Enc = { az: number; alt: number };
type Sample = { t: number; az: number /* unwrapped */; alt: number };

interface AxisCtl {
  moving: boolean;
  dir: 1 | -1;
  rate: number;
  moveStart: number;
  lastHeartbeat: number;
  /** Manual move hit its max duration; ignore heartbeats until released. */
  expired: boolean;
  /** Last guide-rate value sent, signed (for dedup); null forces a send. */
  lastRateKey: number | null;
  /** Commanded guide rate, logical deg/s. */
  rateDegPerSec: number;
  /** Last time the commanded motion changed (grace period for stall/runaway checks). */
  lastChange: number;
  stallSince: number | null;
  /** A watchdog stop is in flight. */
  halting: boolean;
  /** Client that started/last refreshed this manual move (the latest mover owns the axis); null = unknown/internal. */
  owner: string | null;
}

interface Leg {
  targets: Partial<Record<Axis, number>>; // az unwrapped
  fast: boolean;
  startedAt: number;
  done: Set<Axis>;
  peak: number;
  distance: number;
}

/** What the tracking loop follows. `offset` keeps a manual nudge relative to a moving body. */
interface TrackRef {
  target: Target;
  offset?: { az: number; alt: number };
}

const AXES: Axis[] = ['az', 'alt'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const HC_DEVICES = new Set<number>([AuxDevice.HC, AuxDevice.HC_PLUS, AuxDevice.STARSENSE_HC]);
export const STOP_FAILED = STOP_FAILED_MESSAGE;

const newAxis = (): AxisCtl => ({
  moving: false,
  dir: 1,
  rate: 0,
  moveStart: 0,
  lastHeartbeat: 0,
  expired: false,
  lastRateKey: null,
  rateDegPerSec: 0,
  lastChange: 0,
  stallSince: null,
  halting: false,
  owner: null,
});

function versionLess(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

export class Mount extends EventEmitter {
  readonly config: ServerConfig;
  readonly alignment: Alignment;
  private readonly clock: Clock;
  private readonly astro: AstroApi;
  private readonly store: StateStore | null;
  private readonly connectAux: (host: string, port: number) => Promise<AuxLink>;
  private readonly consoleLog: boolean;

  private link: AuxLink | null = null;
  private connection: MountState['connection'] = 'disconnected';
  private error: string | undefined;
  private host: string;
  private port: number;
  private firmware: MountState['firmware'];
  private lastPos: (Enc & { time: number }) | null = null;
  private unwrappedAz: number | null = null;
  private history: Sample[] = [];
  private slew: SlewState = 'idle';
  private target: Target | null = null;
  private tracking = false;
  private trackRef: TrackRef | null = null;
  private reanchorAt: number | null = null;
  private location: GeoLocation | null = null;
  private axes: Record<Axis, AxisCtl> = { az: newAxis(), alt: newAxis() };

  // Safety state
  private fault: string | null = null;
  /** The last stop could not be verified (cleared by the next verified stop). */
  private stopFailed = false;
  private observer = false;
  private stopping = false;
  private lastMotionEnd = 0;
  private leg: Leg | null = null;
  private battery: MountHealth['battery'];
  private slewSpeedRatio: number | undefined;
  private warnings = new Map<string, string>(); // key -> message

  private wantConnected = false;
  private gotoSeq = 0;
  private gotoActive = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private trackTimer: NodeJS.Timeout | null = null;
  private safetyTimer: NodeJS.Timeout | null = null;
  private batteryTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollFailures = 0;
  private trackBusy = false;
  private lastSnapshotSave = 0;
  private snapshot: { encoder: Enc; time: number; unwrappedAz: number | null } | null = null;
  private warnedForeign = new Set<number>();
  private observingList: ObservingListEntry[] = [];
  private listSeq = 0;

  constructor(deps: MountDeps) {
    super();
    this.config = deps.config;
    this.clock = deps.clock ?? systemClock;
    this.astro = deps.astro ?? defaultAstro;
    this.store = deps.store ?? null;
    this.consoleLog = deps.consoleLog ?? true;
    this.alignment = new Alignment(this.astro);
    this.host = this.config.telescopeHost;
    this.port = this.config.telescopePort;
    const packetLog = this.config.packetLogFile ? new PacketLog(this.config.packetLogFile) : null;
    this.connectAux =
      deps.connectAux ??
      ((host, port) =>
        AuxClient.connect({
          host,
          port,
          source: this.config.sourceDevice,
          timeoutMs: this.config.requestTimeoutMs,
          retries: this.config.requestRetries,
          connectTimeoutMs: this.config.connectTimeoutMs,
          onTraffic: packetLog ? (dir, f) => packetLog.write(dir, f) : undefined,
        }));
    this.loadPersisted();
  }

  // ---------- state ----------

  getState(): MountState {
    return {
      connection: this.connection,
      host: this.host,
      port: this.port,
      ...(this.error ? { error: this.error } : {}),
      ...(this.firmware ? { firmware: this.firmware } : {}),
      encoder: this.lastPos ? { az: this.lastPos.az, alt: this.lastPos.alt } : null,
      pointing: this.computePointing(),
      slew: this.slew,
      target: this.target,
      tracking: this.tracking,
      alignment: this.alignment.state,
      location: this.location,
      serverTime: this.clock.now(),
      simulator: LOOPBACK.has(this.host),
      health: this.health(),
      limits: this.limits(),
    };
  }

  private limits(): MountLimits {
    const c = this.config;
    return {
      altDeg: [c.altLimitsDeg[0], c.altLimitsDeg[1]],
      sunDeg: c.sunSafetyDeg,
      sunUpAltDeg: c.sunAltBlockDeg,
      azSoftDeg: c.azWrapSoftDeg,
      azHardDeg: c.azWrapHardDeg,
      solarFilterMode: c.solarFilterMode,
      settleMs: c.settleMs,
    };
  }

  private health(): MountHealth {
    const stats = this.link?.stats;
    const warnings = [
      ...(this.fault ? [`FAULT: ${this.fault} (press Stop to acknowledge)`] : []),
      ...this.warnings.values(),
      ...this.alignment.fitWarnings.map((w) => `Alignment: ${w}`),
    ];
    return {
      ...(this.battery !== undefined ? { battery: this.battery } : {}),
      latencyMs: Math.round((stats?.medianRttMs ?? 0) * 10) / 10,
      timeouts: stats?.timeouts ?? 0,
      ...(this.slewSpeedRatio !== undefined ? { slewSpeedRatio: this.slewSpeedRatio } : {}),
      warnings,
      ...(this.unwrappedAz !== null ? { unwrappedAz: this.unwrappedAz } : {}),
      ...(this.fault ? { fault: this.fault } : {}),
      ...(this.stopFailed ? { stopFailed: true } : {}),
      ...(this.observer ? { observer: true } : {}),
    };
  }

  get isConnected(): boolean {
    return this.connection === 'connected' && !!this.link;
  }

  private changed(): void {
    this.emit('change');
  }

  private log(level: LogLevel, message: string): void {
    const entry: LogEntry = { level, message, time: this.clock.now() };
    if (this.consoleLog && level !== 'debug') console[level === 'info' ? 'log' : level](`[mount] ${message}`);
    this.emit('log', entry);
  }

  /** Safety alert: logged and pushed to every client as an error. */
  private alert(message: string): void {
    this.log('error', message);
    this.emit('alert', message);
  }

  private setWarning(key: string, msg: string | null): void {
    if (msg === null) this.warnings.delete(key);
    else this.warnings.set(key, msg);
  }

  private computePointing(): MountState['pointing'] {
    const params = this.alignment.model;
    if (!this.lastPos || !params || !this.location) return null;
    try {
      const t = this.clock.now();
      const sky = this.astro.encoderToSky(this.currentEncoder(t), params);
      const rd = this.astro.altAzToRaDec(sky, this.location, t);
      return { ra: rd.ra, dec: rd.dec, az: sky.az, alt: sky.alt };
    } catch {
      return null;
    }
  }

  /** Latest polled encoder extrapolated by the commanded guide rates. */
  private currentEncoder(t = this.clock.now()): Enc {
    const p = this.lastPos!;
    const dt = Math.max(0, Math.min(2, (t - p.time) / 1000));
    return { az: mod360(p.az + this.axes.az.rateDegPerSec * dt), alt: p.alt + this.axes.alt.rateDegPerSec * dt };
  }

  // ---------- observing list ----------

  getObservingList(): ObservingListEntry[] {
    return this.observingList;
  }

  /** Apply an observing-list command, persist, and emit 'list'. Throws a user-facing Error when refused. */
  listCommand(m: ListMessage): void {
    this.observingList = applyListMessage(this.observingList, m, {
      now: this.clock.now(),
      newId: () => `${this.clock.now().toString(36)}-${(++this.listSeq).toString(36)}`,
    });
    this.persist();
    this.emit('list', this.observingList);
  }

  // ---------- persistence ----------

  private loadPersisted(): void {
    const s = this.store?.load();
    if (!s) return;
    this.location = s.location;
    this.alignment.restore(s.alignment);
    this.observingList = sanitizeList(s.observingList);
    if (s.encoder && s.encoderTime) this.snapshot = { encoder: s.encoder, time: s.encoderTime, unwrappedAz: s.unwrappedAz ?? null };
  }

  private persist(): void {
    if (!this.store) return;
    const now = this.clock.now();
    this.lastSnapshotSave = now;
    if (this.lastPos) this.snapshot = { encoder: { az: this.lastPos.az, alt: this.lastPos.alt }, time: this.lastPos.time, unwrappedAz: this.unwrappedAz };
    try {
      this.store.save(
        {
          location: this.location,
          alignment: this.alignment.snapshot(),
          encoder: this.snapshot?.encoder ?? null,
          encoderTime: this.snapshot?.time ?? null,
          unwrappedAz: this.snapshot?.unwrappedAz ?? null,
          observingList: this.observingList,
        },
        now,
      );
    } catch (e) {
      this.log('warn', `Could not save state: ${(e as Error).message}`);
    }
  }

  // ---------- connection ----------

  async connect(host?: string, port?: number): Promise<void> {
    const h = host ?? this.host;
    const p = port ?? this.port;
    if (this.link && (h !== this.host || p !== this.port)) await this.disconnect();
    else if (this.link || this.connection === 'connecting') return;
    this.host = h;
    this.port = p;
    this.wantConnected = true;
    await this.openLink();
  }

  async disconnect(): Promise<void> {
    this.wantConnected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const link = this.link;
    if (link) {
      // Never leave tracking or a slew running.
      this.gotoSeq++;
      try {
        await this.haltAxes(1);
      } catch {
        /* best effort */
      }
      link.close(); // emits 'disconnect' -> onLinkDown
      if (this.link === link) this.onLinkDown(link, 'disconnected by user');
    }
    this.connection = 'disconnected';
    this.error = undefined;
    this.changed();
  }

  /** Release timers (tests / shutdown). */
  async dispose(): Promise<void> {
    await this.disconnect();
    this.removeAllListeners();
  }

  private async openLink(): Promise<void> {
    this.connection = 'connecting';
    this.error = undefined;
    this.changed();
    this.log('info', `Connecting to ${this.host}:${this.port}`);
    let link: AuxLink | null = null;
    try {
      link = await this.connectAux(this.host, this.port);
      const l = link;
      l.on('disconnect', (reason) => this.onLinkDown(l, reason));
      l.on('packet', (f) => this.onForeignPacket(f.src, f.dst));
      this.link = link;
      await this.initSequence();
      this.connection = 'connected';
      this.pollFailures = 0;
      this.setWarning('link', null);
      this.log('info', `Connected (AZM ${this.firmware?.az}, ALT ${this.firmware?.alt})`);
      this.changed();
      this.schedulePoll();
      this.trackTimer = setInterval(() => void this.trackTick(), this.config.trackingPeriodMs);
      this.safetyTimer = setInterval(() => this.safetyTick(), 100);
      void this.discover(link);
    } catch (e) {
      const msg = (e as Error).message;
      if (link) {
        this.link = null;
        link.close();
      }
      this.connection = 'error';
      this.error = msg;
      this.log('error', `Connect failed: ${msg}`);
      this.changed();
      throw e;
    }
  }

  /** PROTOCOL.md §4.3 / SAFETY.md §2.4: versions, then stop both axes, then positions, then power-cycle check. */
  private async initSequence(): Promise<void> {
    const { azDevice: az, altDevice: alt, wifiDevice } = this.config;
    const vAz = await this.req(az, AuxCmd.GET_VER);
    const vAlt = await this.req(alt, AuxCmd.GET_VER);
    await this.haltAxes(1);
    this.firmware = { az: formatVersion(vAz), alt: formatVersion(vAlt) };
    const old = [this.firmware.az!, this.firmware.alt!].filter((v) => versionLess(v, this.config.minMcVersion));
    this.setWarning(
      'firmware',
      old.length ? `Motor controller firmware ${old[0]} is older than ${this.config.minMcVersion}; update with Celestron CFM (older Astro Fi firmware can slew forever).` : null,
    );
    if (old.length) this.log('warn', this.warnings.get('firmware')!);
    try {
      this.firmware.wifi = formatVersion(await this.req(wifiDevice, AuxCmd.GET_VER, [], { timeoutMs: this.config.discoveryTimeoutMs, retries: 0, probe: true }));
    } catch {
      /* optional */
    }
    try {
      const model = await this.req(az, AuxCmd.GET_MODEL, [], { timeoutMs: 400, retries: 0, probe: true });
      this.log('info', `Motor controller model 0x${Array.from(model, (b) => b.toString(16).padStart(2, '0')).join('')}`);
    } catch {
      /* optional */
    }
    this.history = [];
    this.unwrappedAz = null;
    await this.readPositions();
    this.initUnwrapped();
    this.checkPowerCycle();
    if (this.config.enableCordwrap) {
      try {
        const rawAz = this.toRaw('az', this.lastPos!.az);
        await this.req(az, AuxCmd.SET_CORDWRAP_POS, encodePosition(mod360(rawAz + 180)));
        await this.req(az, AuxCmd.ENABLE_CORDWRAP);
      } catch (e) {
        this.log('warn', `Cordwrap setup failed: ${(e as Error).message}`);
      }
    }
    this.persist();
  }

  /** Restore the unwrapped azimuth from the snapshot, or assume the power-on position is cable-neutral. */
  private initUnwrapped(): void {
    const az = this.lastPos!.az;
    const snap = this.snapshot;
    this.unwrappedAz = snap?.unwrappedAz != null ? snap.unwrappedAz + wrap180(az - snap.encoder.az) : wrap180(az);
  }

  /** Encoders at 0,0 while we last saw them elsewhere: the scope was power-cycled, so the alignment is stale. */
  private checkPowerCycle(): void {
    const pos = this.lastPos!;
    const snap = this.snapshot;
    if (!snap) return;
    const tol = this.config.powerCycleZeroTolDeg;
    const nearZero = Math.abs(wrap180(pos.az)) < tol && Math.abs(pos.alt) < tol;
    const min = this.config.powerCycleMinMoveDeg;
    const wasElsewhere = Math.abs(wrap180(snap.encoder.az)) > min || Math.abs(snap.encoder.alt) > min;
    if (nearZero && wasElsewhere) {
      this.log('warn', 'Encoders read 0,0 but were elsewhere last time: the telescope was power-cycled. Alignment cleared; please re-align.');
      this.alignment.clear();
      this.tracking = false;
      this.trackRef = null;
      this.unwrappedAz = 0;
      this.setWarning('cable', 'Telescope was power-cycled: make sure the power cable is unwrapped (cable-neutral) before slewing.');
    } else if (this.alignment.state.quality !== 'none') {
      this.log('info', `Reusing saved alignment (${this.alignment.state.quality})`);
    }
  }

  /** GET-only discovery scan (SAFETY.md §5.4), then battery telemetry if 0xB6 exists. */
  private async discover(link: AuxLink): Promise<void> {
    const found: string[] = [];
    for (const dev of DISCOVERY_DEVICES) {
      if (dev === this.config.wifiDevice) continue;
      if (this.link !== link) return;
      try {
        const v = await this.req(dev, AuxCmd.GET_VER, [], { timeoutMs: this.config.discoveryTimeoutMs, retries: 0, probe: true });
        found.push(`${deviceName(dev)} ${formatVersion(v)}`);
        if (HC_DEVICES.has(dev)) this.enterObserver(dev);
        if (dev === BATTERY_DEVICE) await this.pollBattery();
      } catch {
        /* silent = absent */
      }
    }
    if (this.link !== link) return;
    if (this.battery === undefined) this.battery = null;
    else this.batteryTimer = setInterval(() => void this.pollBattery(), this.config.batteryPollMs);
    this.log('info', `Discovery: ${found.length ? found.join(', ') : 'no optional devices'}; battery ${this.battery ? 'available' : 'unavailable'}`);
    this.changed();
  }

  private async pollBattery(): Promise<void> {
    try {
      const d = await this.req(BATTERY_DEVICE, BAT_GET_STATUS, [], { timeoutMs: 500, retries: 0 });
      if (d.length < 6) return;
      const micro = ((d[2]! << 24) >>> 0) + (d[3]! << 16) + (d[4]! << 8) + d[5]!;
      this.battery = { volts: Math.round(micro / 1e4) / 100, level: ['LOW', 'MEDIUM', 'HIGH'][d[1]!] ?? `?${d[1]}`, charging: d[0] === 1 };
      if (this.battery.level === 'LOW') this.setWarning('battery', `Battery LOW (${this.battery.volts} V)`);
      else this.setWarning('battery', null);
      this.changed();
    } catch {
      /* transient */
    }
  }

  private onForeignPacket(src: number, dst: number): void {
    const us = this.config.sourceDevice;
    if (src === us || dst === us || this.warnedForeign.has(src)) return;
    this.warnedForeign.add(src);
    if (HC_DEVICES.has(src)) this.enterObserver(src);
    else this.log('warn', `Traffic from ${deviceName(src)} on the AUX bus`);
  }

  /** A hand controller drives the mount: read-only from now on (SAFETY.md §4.4). */
  private enterObserver(dev: number): void {
    if (this.observer) return;
    this.observer = true;
    const msg = `A hand controller (${deviceName(dev)}) is attached and controls the mount. Stargazer is read-only; unplug it (power off first) to use Stargazer.`;
    this.setWarning('observer', msg);
    this.log('warn', msg);
    this.tracking = false;
    void this.haltAxes(1).catch(() => {});
    this.changed();
  }

  private onLinkDown(link: AuxLink, reason: string): void {
    if (this.link !== link) return;
    const userInitiated = !this.wantConnected;
    const wasMoving = this.tracking || this.gotoActive || AXES.some((a) => this.axes[a].moving);
    this.link = null;
    for (const t of [this.pollTimer, this.safetyTimer, this.batteryTimer]) if (t) clearTimeout(t);
    if (this.trackTimer) clearInterval(this.trackTimer);
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    if (this.batteryTimer) clearInterval(this.batteryTimer);
    this.pollTimer = this.trackTimer = this.safetyTimer = this.batteryTimer = null;
    this.gotoSeq++;
    this.gotoActive = false;
    this.leg = null;
    this.tracking = false;
    this.slew = 'idle';
    this.observer = false;
    this.setWarning('observer', null);
    for (const a of AXES) this.axes[a] = newAxis();
    if (this.lastPos) this.persist();
    if (userInitiated) {
      this.connection = 'disconnected';
    } else if (this.connection !== 'connecting') {
      this.connection = 'error';
      this.error = `Connection lost: ${reason}`;
      const at = new Date(this.clock.now()).toLocaleTimeString();
      this.setWarning(
        'link',
        `Connection lost at ${at}${wasMoving ? ' while the telescope was moving' : ''}. It may keep moving (manual slews until stopped, tracking for hours). Unplug the power if it does not stop.`,
      );
      if (wasMoving) this.alert(this.warnings.get('link')!);
      else this.log('warn', `${this.error}; retrying in ${this.config.reconnectDelayMs / 1000} s`);
      this.scheduleReconnect();
    }
    this.changed();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.wantConnected) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantConnected || this.link) return;
      this.openLink().catch(() => this.scheduleReconnect());
    }, this.config.reconnectDelayMs);
  }

  // ---------- low-level helpers ----------

  private req(dev: number, cmd: number, data: ArrayLike<number> = [], opts?: RequestOptions): Promise<Uint8Array> {
    if (!this.link) return Promise.reject(new Error('Not connected to the telescope'));
    return this.link.request(dev, cmd, data, opts);
  }

  private requireConnected(): void {
    if (!this.isConnected) throw new Error('Not connected to the telescope');
  }

  /** Gate for anything that starts motion. */
  private requireMotionAllowed(): void {
    this.requireConnected();
    if (this.fault) throw new Error(`Fault: ${this.fault}. Check the telescope, then press Stop to acknowledge.`);
    if (this.observer) throw new Error('A hand controller is attached: Stargazer is read-only.');
    if (this.stopping) throw new Error('Stopping in progress');
  }

  private dev(axis: Axis): number {
    return axis === 'az' ? this.config.azDevice : this.config.altDevice;
  }

  private dirSign(axis: Axis): 1 | -1 {
    return axis === 'az' ? this.config.azDirection : this.config.altDirection;
  }

  /** Logical <-> raw degrees (the mapping is its own inverse). */
  private toRaw(axis: Axis, deg: number): number {
    const v = this.dirSign(axis) * deg;
    return axis === 'az' ? mod360(v) : v;
  }

  private async readPositions(): Promise<void> {
    const rawAz = decodePosition(await this.req(this.config.azDevice, AuxCmd.GET_POSITION), false);
    const rawAlt = decodePosition(await this.req(this.config.altDevice, AuxCmd.GET_POSITION), true);
    const prev = this.lastPos;
    const t = this.clock.now();
    this.lastPos = { az: this.toRaw('az', rawAz), alt: this.toRaw('alt', rawAlt), time: t };
    if (prev && this.unwrappedAz !== null) this.unwrappedAz += wrap180(this.lastPos.az - prev.az);
    if (this.unwrappedAz !== null) {
      this.history.push({ t, az: this.unwrappedAz, alt: this.lastPos.alt });
      while (this.history.length && this.history[0]!.t < t - 5000) this.history.shift();
    }
  }

  /** Observed axis speed (deg/s, signed) over roughly the last `windowMs`; null if not enough data. */
  private speed(axis: Axis, windowMs: number): number | null {
    const h = this.history;
    if (h.length < 2) return null;
    const last = h[h.length - 1]!;
    let ref: Sample | null = null;
    for (let i = h.length - 2; i >= 0; i--) {
      ref = h[i]!;
      if (last.t - ref.t >= windowMs) break;
    }
    if (!ref || last.t - ref.t < Math.min(windowMs, 150)) return null;
    return (last[axis] - ref[axis]) / ((last.t - ref.t) / 1000);
  }

  /** Send a guide rate (logical deg/s). Deduplicated (< 0.5″/s change) unless `force`. */
  private async setGuideRate(axis: Axis, degPerSec: number, force = false, opts?: RequestOptions): Promise<void> {
    const raw = degPerSec * 3600 * this.dirSign(axis);
    const { cmd, data, value } = encodeGuideRate(raw, this.config.trackingScale);
    const key = cmd === AuxCmd.SET_POS_GUIDERATE ? value : -value;
    const ctl = this.axes[axis];
    if (!force && ctl.lastRateKey !== null) {
      const same = Math.abs(key - ctl.lastRateKey) < 0.5 * this.config.trackingScale;
      if (same && (key !== 0) === (ctl.lastRateKey !== 0)) return;
    }
    await this.req(this.dev(axis), cmd, data, opts);
    ctl.lastRateKey = key;
    ctl.rateDegPerSec = (key / this.config.trackingScale / 3600) * this.dirSign(axis);
  }

  private async sendMove(axis: Axis, direction: 1 | -1, rate: number, opts?: RequestOptions): Promise<void> {
    const cmd = direction * this.dirSign(axis) > 0 ? AuxCmd.MOVE_POS : AuxCmd.MOVE_NEG;
    await this.req(this.dev(axis), cmd, [rate], opts);
  }

  /** MOVE_POS 0 + guide rate 0 per axis (INDI Abort order), `times` times ~150 ms apart. */
  private async haltAxes(times: number, axes: Axis[] = AXES): Promise<void> {
    const opts = { priority: true };
    for (let i = 0; i < times; i++) {
      if (i) await sleep(150);
      for (const a of axes) {
        await this.sendMove(a, 1, 0, opts);
        await this.setGuideRate(a, 0, true, opts);
      }
    }
  }

  // ---------- limits ----------

  /** Encoder altitude of the mechanical level (h_mech = E_e − level); null while unknown. */
  private levelEncoderAlt(): number | null {
    const params = this.alignment.model;
    if (!params) return null;
    let az = 0;
    try {
      if (this.lastPos) az = this.astro.encoderToSky(this.lastPos, params).az;
    } catch {
      /* keep 0 */
    }
    return this.astro.skyToEncoder({ az, alt: 0 }, params).alt;
  }

  /** Allowed encoder-altitude range: mechanical limits, or ±envelope around power-on while unknown. */
  private altEncLimits(): [number, number] {
    const level = this.levelEncoderAlt();
    if (level === null) return [-this.config.unknownAltEnvelopeDeg, this.config.unknownAltEnvelopeDeg];
    const [lo, hi] = this.config.altLimitsDeg;
    return [lo + level, hi + level];
  }

  private azRange(): [number, number] {
    return [-this.config.azWrapSoftDeg, this.config.azWrapSoftDeg];
  }

  // ---------- Sun ----------

  /** Sun alt-az now, or null when unknown (no location / astro failure). */
  private sunAltAz(t = this.clock.now()): AltAz | null {
    if (!this.location) return null;
    try {
      return this.astro.targetAltAz({ kind: 'body', body: 'Sun', name: 'Sun' }, this.location, t);
    } catch {
      return null;
    }
  }

  /** Unknown counts as up (fail safe). */
  private sunIsUp(): boolean {
    const sun = this.sunAltAz();
    return !sun || sun.alt > this.config.sunAltBlockDeg;
  }

  /** SAFETY.md §3.2: no automatic motion with a rough/absent model while the Sun is up. */
  private requireAutoMotionSunSafe(): void {
    if (this.alignment.state.quality !== 'aligned' && this.sunIsUp()) {
      throw new Error(
        this.location
          ? `The Sun is up (above ${this.config.sunAltBlockDeg}°) and the alignment is only ${this.alignment.state.quality}: automatic motion is blocked. Use manual moves with the tube and finder capped, or align on stars after dusk.`
          : 'Set your location first: it is needed for Sun safety.',
      );
    }
  }

  private sunKeepoutDeg(): number {
    return this.config.sunPathKeepoutDeg + 3 * ((this.alignment.state.rmsArcmin ?? 0) / 60);
  }

  // ---------- polling & monitoring ----------

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => void this.pollOnce(), this.config.pollIntervalMs);
  }

  private async pollOnce(): Promise<void> {
    const link = this.link;
    if (!link) return;
    try {
      const prev = this.lastPos;
      await this.readPositions();
      this.pollFailures = 0;
      this.checkBrownOut(prev);
      this.monitor();
      if (this.clock.now() - this.lastSnapshotSave > 10_000) this.persist();
      this.changed();
    } catch (e) {
      if (e instanceof AuxDisconnectedError || this.link !== link) return;
      if (++this.pollFailures >= this.config.maxPollFailures) {
        this.alert(`Telescope stopped responding (${(e as Error).message}). If it is moving, unplug the power.`);
        link.close();
        return;
      }
    }
    if (this.link === link) this.schedulePoll();
  }

  /** Both encoders suddenly at ~0,0: the MC reset (power dip). */
  private checkBrownOut(prev: (Enc & { time: number }) | null): void {
    const cur = this.lastPos!;
    if (!prev) return;
    const tol = this.config.powerCycleZeroTolDeg;
    const min = this.config.powerCycleMinMoveDeg;
    const nowZero = Math.abs(wrap180(cur.az)) < tol && Math.abs(cur.alt) < tol;
    const wasElsewhere = Math.abs(wrap180(prev.az)) > min || Math.abs(prev.alt) > min;
    if (!nowZero || !wasElsewhere) return;
    this.alignment.clear();
    this.unwrappedAz = 0;
    this.history = [];
    this.setWarning('cable', 'Telescope reset: make sure the power cable is unwrapped (cable-neutral) before slewing.');
    void this.emergency('Power dipped and the telescope reset; alignment lost. Replace the batteries or check the plug.');
  }

  /** Stall / no-progress / runaway / limit checks from polled positions (SAFETY.md §2.2). */
  private monitor(): void {
    if (!this.link || this.stopping || this.fault) return;
    const cfg = this.config;
    const now = this.clock.now();
    const pos = this.lastPos!;
    const u = this.unwrappedAz;

    if (u !== null && Math.abs(u) > cfg.azWrapHardDeg) {
      void this.emergency(`Cable wrap hard limit: azimuth is ${u.toFixed(0)}° from cable-neutral (max ±${cfg.azWrapHardDeg}°). Unwind slowly by hand-held manual moves.`);
      return;
    }

    for (const axis of AXES) {
      const ax = this.axes[axis];
      const v = this.speed(axis, 600);
      if (v === null) continue;
      const since = now - ax.lastChange;
      let kind: 'manual' | 'goto' | 'idle' = 'idle';
      let exp = Math.abs(ax.rateDegPerSec);
      let vmax = exp;
      const leg = this.leg;
      if (ax.moving) {
        kind = 'manual';
        exp = vmax = cfg.slewRatesDegPerSec[ax.rate] ?? 0;
      } else if (leg && leg.targets[axis] !== undefined && !leg.done.has(axis)) {
        kind = 'goto';
        vmax = leg.fast ? cfg.gotoMaxRateDegPerSec : cfg.gotoSlowRateDegPerSec;
        const cur = axis === 'az' ? u! : pos.alt;
        exp = Math.min(vmax, Math.sqrt(2 * cfg.gotoAccelDegPerSec2 * Math.abs(leg.targets[axis]! - cur)));
        if (leg.fast) leg.peak = Math.max(leg.peak, Math.abs(v));
      }

      // Runaway: faster than commanded, or still moving well after a stop.
      if (since > 2000) {
        const limit = kind === 'idle' ? (this.tracking ? Math.max(0.3, 1.5 * exp) : 0.05 + exp) : vmax * cfg.runawayFactor + 0.05;
        if (Math.abs(v) > limit) {
          void this.emergency(`Runaway on ${axis}: moving at ${Math.abs(v).toFixed(2)}°/s (expected ≤ ${limit.toFixed(2)}°/s)`);
          return;
        }
      }

      // Stall: commanded to move but barely moving.
      const candidate = since > 1000 && ((kind === 'manual' && ax.rate >= 4) || (kind === 'goto' && exp >= 0.3));
      if (candidate && Math.abs(this.speed(axis, 1000) ?? v) < cfg.stallSpeedFraction * exp) {
        ax.stallSince ??= now;
        if (now - ax.stallSince > cfg.stallWindowMs) {
          void this.emergency(`Possible obstruction: ${axis} axis stalled (expected ${exp.toFixed(2)}°/s). Check the telescope before moving it again.`);
          return;
        }
      } else ax.stallSince = null;

      // Predictive limit stop for manual moves (position + one poll + braking distance).
      if (kind === 'manual') {
        const brake = (v * v) / (2 * cfg.gotoAccelDegPerSec2);
        const ahead = v * (cfg.pollIntervalMs / 1000) + Math.sign(v) * brake;
        const [lo, hi] = axis === 'alt' ? this.altEncLimits() : this.azRange();
        const p = axis === 'alt' ? pos.alt : u;
        if (p !== null && ((v > 0 && p + ahead > hi) || (v < 0 && p + ahead < lo))) {
          this.log('warn', axis === 'alt' ? 'Altitude limit reached: manual move stopped' : 'Cable-wrap limit reached: manual move stopped; move the other way to unwind');
          void this.stopAxis(axis).catch(() => {});
        }
      }
    }

    // GoTo not progressing (fast phase).
    const leg = this.leg;
    if (leg?.fast && now - leg.startedAt > 3000) {
      const old = this.history.find((s) => s.t >= now - 3200);
      if (old) {
        const rem = (s: { az: number; alt: number }) =>
          Math.max(leg.targets.az !== undefined ? Math.abs(leg.targets.az - s.az) : 0, leg.targets.alt !== undefined ? Math.abs(leg.targets.alt - s.alt) : 0);
        const remNow = rem({ az: u!, alt: pos.alt });
        if (remNow > 0.5 && rem(old) - remNow < 0.2) {
          void this.emergency('GoTo is not progressing: possible obstruction. Check the telescope.');
          return;
        }
      }
    }

    this.checkManualSun();
  }

  /** Aligned + Sun up: stop a manual slew whose predicted pointing enters the Sun keep-out. */
  private checkManualSun(): void {
    const params = this.alignment.model;
    if (this.config.solarFilterMode || this.alignment.state.quality !== 'aligned' || !params) return;
    if (!AXES.some((a) => this.axes[a].moving)) return;
    const sun = this.sunAltAz();
    if (!sun || sun.alt <= this.config.sunAltBlockDeg) return;
    const vAz = this.speed('az', 600) ?? 0;
    const vAlt = this.speed('alt', 600) ?? 0;
    const p = this.lastPos!;
    const ahead = this.astro.encoderToSky({ az: mod360(p.az + vAz * 0.5), alt: p.alt + vAlt * 0.5 }, params);
    if (sepAltAz(this.astro, ahead, sun) < this.config.sunPathKeepoutDeg) {
      this.alert('Manual slew stopped: approaching the Sun. Never point the telescope (or its finder) at the Sun without a full-aperture solar filter.');
      for (const a of AXES) if (this.axes[a].moving) void this.stopAxis(a).catch(() => {});
    }
  }

  /** Dead-man and max-duration watchdog for manual moves (runs every 100 ms). */
  private safetyTick(): void {
    if (!this.link) return;
    const now = this.clock.now();
    for (const axis of AXES) {
      const ax = this.axes[axis];
      if (!ax.moving || ax.halting) continue;
      const halt = (msg: string, expire: boolean) => {
        ax.halting = true;
        this.log('warn', msg);
        void this.stopAxis(axis)
          .then(() => (ax.expired = expire))
          .catch(() => {})
          .finally(() => (ax.halting = false));
      };
      if (now - ax.lastHeartbeat > this.config.deadmanMs) {
        halt(`No move heartbeat for ${axis} within ${this.config.deadmanMs} ms: stopping (dead-man)`, false);
        continue;
      }
      const max = ax.rate >= 7 ? this.config.moveMaxMsFast : this.config.moveMaxMsSlow;
      if (now - ax.moveStart > max) halt(`Manual ${axis} move exceeded ${max / 1000} s: stopped. Release and press again to continue.`, true);
    }
  }

  /** Stop everything and latch a fault that `stop` acknowledges. */
  private async emergency(reason: string): Promise<void> {
    if (this.fault) return;
    this.fault = reason;
    this.alert(reason);
    this.changed();
    try {
      await this.haltAndVerify();
    } catch {
      /* haltAndVerify already alerted */
    }
  }

  // ---------- manual motion ----------

  /**
   * Press-and-hold move; repeat the same call every ~200 ms as a heartbeat (dead-man). `owner` identifies the
   * client: the latest mover owns the axis, and only the owner's release/disconnect stops it.
   */
  async move(axis: Axis, direction: 1 | -1, rate: number, owner?: string): Promise<void> {
    if (!(rate >= 1)) return this.stopAxis(axis, owner);
    this.requireMotionAllowed();
    const ax = this.axes[axis];
    if (ax.expired && (owner === undefined || ax.owner === null || ax.owner === owner)) throw new Error('Manual move timed out: release and press again');
    if (ax.expired) ax.expired = false; // another client starts afresh
    let r = Math.min(9, Math.round(rate));
    if (this.alignment.state.quality === 'none' && r > this.config.unknownMaxRate) r = this.config.unknownMaxRate;
    const now = this.clock.now();
    ax.lastHeartbeat = now;
    if (ax.moving && ax.owner !== (owner ?? null)) {
      if (ax.owner !== null) this.log('info', `Manual ${axis} move taken over by another client`);
      ax.owner = owner ?? null;
    }
    if (ax.moving && ax.dir === direction && ax.rate === r) return; // heartbeat only

    // Refuse to start into a limit.
    const [lo, hi] = axis === 'alt' ? this.altEncLimits() : this.azRange();
    const p = axis === 'alt' ? this.lastPos?.alt : this.unwrappedAz;
    if (p != null && ((direction > 0 && p >= hi - 0.1) || (direction < 0 && p <= lo + 0.1))) {
      throw new Error(axis === 'alt' ? 'At the altitude limit' : 'At the cable-wrap limit: move the other way to unwind');
    }

    if (this.gotoActive) await this.abortGoto();
    if (ax.moving && ax.dir !== direction) await this.reverseStop(axis);
    if (!ax.moving) {
      await this.setGuideRate(axis, 0, true);
      ax.moveStart = now;
    }
    ax.moving = true;
    ax.owner = owner ?? null;
    ax.dir = direction;
    ax.rate = r;
    ax.lastChange = this.clock.now();
    ax.lastHeartbeat = ax.lastChange;
    this.slew = 'manual';
    this.changed();
    await this.sendMove(axis, direction, r);
  }

  /** Decelerate before reversing (SAFETY.md §2.3). */
  private async reverseStop(axis: Axis): Promise<void> {
    const wasFast = this.axes[axis].rate > 6;
    await this.sendMove(axis, 1, 0, { priority: true });
    const end = Date.now() + (wasFast ? 2500 : this.config.reversalWaitMs);
    await sleep(Math.min(this.config.reversalWaitMs, end - Date.now()));
    while (wasFast && Date.now() < end && Math.abs(this.speed(axis, 300) ?? 0) > 0.05) await sleep(100);
  }

  /**
   * Release a manual move. With `owner`, only stops the axis if that client owns it (another client took it over
   * since); without, always stops (internal watchdogs).
   */
  async stopAxis(axis: Axis, owner?: string): Promise<void> {
    const ax = this.axes[axis];
    if (owner !== undefined && ax.owner !== null && ax.owner !== owner && (ax.moving || ax.expired)) return;
    ax.expired = false;
    if (!this.link) return;
    const wasMoving = ax.moving;
    await this.sendMove(axis, 1, 0, { priority: true });
    await this.sendMove(axis, 1, 0, { priority: true });
    ax.moving = false;
    ax.lastChange = this.clock.now();
    if (wasMoving) this.lastMotionEnd = ax.lastChange;
    if (this.slew === 'manual' && !AXES.some((a) => this.axes[a].moving)) this.slew = 'idle';
    if (wasMoving && this.tracking) {
      // Resume tracking at the new position once the axis has coasted to a stop.
      this.reanchorAt = this.clock.now() + 1500;
      ax.lastRateKey = null;
    }
    this.changed();
  }

  /** Stop manual motion: all of it, or (with `owner`) only the axes that client owns, e.g. when it disconnects. */
  async stopManual(owner?: string): Promise<void> {
    for (const a of AXES) {
      const ax = this.axes[a];
      if (owner !== undefined && ax.owner !== owner) continue;
      if (ax.moving) await this.stopAxis(a);
      else if (owner !== undefined && ax.expired) ax.expired = false;
    }
  }

  /** Which client owns each axis' manual move (null if idle or internal). For tests and diagnostics. */
  manualOwners(): Record<Axis, string | null> {
    return { az: this.axes.az.moving ? this.axes.az.owner : null, alt: this.axes.alt.moving ? this.axes.alt.owner : null };
  }

  /** Abort everything (goto, manual, tracking), verify, escalate. Also acknowledges a latched fault. */
  async stop(): Promise<void> {
    if (!this.link) {
      this.log('warn', 'Not connected: both axes will be stopped first thing on reconnect');
      this.tracking = false;
      this.changed();
      return;
    }
    await this.haltAndVerify();
    if (this.fault) this.log('info', `Fault acknowledged: ${this.fault}`);
    this.fault = null;
    this.log('info', 'Stopped');
    this.changed();
  }

  /** SAFETY.md §2.5: stop sent twice, verified within stopVerifyMs, escalated, finally "unplug power". */
  private async haltAndVerify(): Promise<void> {
    this.gotoSeq++;
    this.gotoActive = false;
    this.leg = null;
    this.tracking = false;
    this.trackRef = null;
    this.reanchorAt = null;
    for (const a of AXES) {
      this.axes[a].moving = false;
      this.axes[a].lastChange = this.clock.now();
    }
    this.slew = 'idle';
    this.stopping = true;
    this.changed();
    try {
      await this.haltAxes(2);
      if (await this.verifyStopped(this.config.stopVerifyMs)) return void (this.stopFailed = false);
      this.log('warn', 'Telescope still moving after stop: re-sending');
      await this.haltAxes(1);
      if (await this.verifyStopped(1000)) return void (this.stopFailed = false);
      this.log('warn', 'Still moving: re-targeting a slow GoTo to the current position');
      try {
        await this.readPositions();
        for (const axis of AXES) await this.req(this.dev(axis), AuxCmd.GOTO_SLOW, encodePosition(this.toRaw(axis, this.lastPos![axis])), { priority: true });
      } catch {
        /* fall through to the alert */
      }
      if (await this.verifyStopped(1500)) return void (this.stopFailed = false);
      this.stopFailed = true;
      this.alert(STOP_FAILED);
      throw new Error(STOP_FAILED);
    } finally {
      this.stopping = false;
      this.lastMotionEnd = this.clock.now();
      this.changed();
    }
  }

  /** Poll positions at ~5 Hz until both axes move < 0.05°/s (and report SLEW_DONE). */
  private async verifyStopped(ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    let prev: (Enc & { time: number }) | null = null;
    while (Date.now() < end) {
      try {
        await this.readPositions();
        const cur = this.lastPos!;
        if (prev && cur.time > prev.time) {
          const dt = (cur.time - prev.time) / 1000;
          const vAz = Math.abs(wrap180(cur.az - prev.az)) / dt;
          const vAlt = Math.abs(cur.alt - prev.alt) / dt;
          if (vAz < 0.05 && vAlt < 0.05) {
            for (const axis of AXES) await this.req(this.dev(axis), AuxCmd.SLEW_DONE); // clears the GOTO-active flag
            return true;
          }
        }
        prev = cur;
      } catch (e) {
        if (e instanceof AuxDisconnectedError) return false;
      }
      await sleep(200);
    }
    return false;
  }

  private async abortGoto(): Promise<void> {
    this.gotoSeq++;
    this.gotoActive = false;
    this.leg = null;
    this.slew = 'idle';
    await this.haltAxes(1);
    await this.verifyStopped(this.config.stopVerifyMs);
  }

  // ---------- goto ----------

  /** Sky alt-az of a target at time t, including any manual-nudge offset. */
  private skyOf(ref: TrackRef, t: number): AltAz {
    const tg = ref.target;
    let sky: AltAz;
    if (tg.kind === 'altaz') sky = { az: tg.az, alt: tg.alt };
    else {
      if (!this.location) throw new Error('Set your location first');
      sky = this.astro.targetAltAz(tg, this.location, t);
    }
    if (ref.offset) sky = { az: mod360(sky.az + ref.offset.az), alt: sky.alt + ref.offset.alt };
    return sky;
  }

  private encoderFor(sky: AltAz): Enc {
    const e = this.astro.skyToEncoder(sky, this.alignment.model!);
    return { az: mod360(e.az), alt: e.alt };
  }

  /** Unwrapped azimuth nearest to `from` for an azimuth given mod 360. */
  private nearestUnwrapped(az: number, from: number): number {
    return from + wrap180(az - mod360(from));
  }

  async goto(target: Target, force = false): Promise<GotoResult> {
    this.requireMotionAllowed();
    const cfg = this.config;
    if (this.alignment.state.quality === 'none') throw new Error('Altitude reference unknown: do the Home step (tube level, pointing north) or align first');
    if (target.kind !== 'altaz' && !this.location) throw new Error('Set your location before a GoTo');
    this.requireAutoMotionSunSafe();

    const ref: TrackRef = { target };
    const now = this.clock.now();
    const skyNow = this.skyOf(ref, now);

    // Sun proximity: refused unless solar filter mode is configured and the user forces it.
    const sun = this.sunAltAz(now);
    const isSun = target.kind === 'body' && target.body === 'Sun';
    if (isSun || (sun && sepAltAz(this.astro, skyNow, sun) < cfg.sunSafetyDeg)) {
      const sep = sun ? sepAltAz(this.astro, skyNow, sun) : 0;
      const msg = `${isSun ? 'Pointing at the Sun' : `${target.name} is ${sep.toFixed(1)}° from the Sun`}. Never look at the Sun without a full-aperture solar filter, and cap the finder.`;
      if (!cfg.solarFilterMode) throw new Error(`${msg} GoTo refused.`);
      if (!force) return { status: 'confirm', message: `${msg} Solar filter fitted and finder capped?` };
    }

    const tgtNow = this.encoderFor(skyNow);
    const [lo, hi] = this.altEncLimits();
    if (tgtNow.alt < lo || tgtNow.alt > hi) {
      throw new Error(`${target.name} is outside the mechanical altitude limits (${cfg.altLimitsDeg[0]}° … ${cfg.altLimitsDeg[1]}°); GoTo refused.`);
    }
    if (!force && skyNow.alt < 0) return { status: 'confirm', message: `${target.name} is below the horizon (alt ${skyNow.alt.toFixed(1)}°).` };
    if (target.kind === 'body' && (target.body === 'Moon' || target.body === 'Venus')) this.log('info', `${target.name} is bright: expect dazzle; consider a Moon filter.`);

    // Pre-target where the object will be after the slew, offset against the approach direction.
    const startPose: Pose = { az: this.unwrappedAz!, alt: this.lastPos!.alt };
    const dist = Math.max(Math.abs(wrap180(tgtNow.az - this.lastPos!.az)), Math.abs(tgtNow.alt - startPose.alt));
    const slewSec = dist / cfg.gotoMaxRateDegPerSec + 2 + cfg.gotoApproachOffsetDeg / cfg.gotoSlowRateDegPerSec;
    const tgt = this.encoderFor(this.skyOf(ref, now + slewSec * 1000));
    const off = cfg.gotoApproachOffsetDeg;
    const pre: Pose = { az: mod360(tgt.az - cfg.azApproach * off), alt: clamp(tgt.alt - cfg.altApproach * off, lo, hi) };
    const route = this.planRoute(startPose, pre, sun);

    const seq = ++this.gotoSeq;
    this.gotoActive = true;
    this.tracking = false;
    this.trackRef = null;
    this.reanchorAt = null;
    for (const a of AXES) this.axes[a].moving = false;
    this.target = target;
    this.slew = 'goto-fast';
    this.changed();
    this.log('info', `GoTo ${target.name} (route: ${route.name}, ${route.steps.length} leg${route.steps.length > 1 ? 's' : ''})`);
    const home = this.alignment.state.home;
    if (this.alignment.state.quality === 'rough' && home?.source === 'sensors') {
      this.log('info', `Home came from the phone compass (±${home.azSigmaDeg?.toFixed(0) ?? '?'}° az): expect ${target.name} within ~${expectedFirstStarErrorDeg(home) ?? 10}°. Find it in the finder, centre it, then press Centred.`);
    }

    try {
      // No guide rate may be sent from here until both axes report SLEW_DONE (MC 7.13 runaway bug).
      await this.setGuideRate('az', 0, true);
      await this.setGuideRate('alt', 0, true);
      for (const step of route.steps) {
        if (!(await this.runLeg(step, true, seq))) return { status: 'cancelled' };
      }

      this.slew = 'goto-slow';
      this.changed();
      const slowSec = off / cfg.gotoSlowRateDegPerSec + 1;
      const fin = this.encoderFor(this.skyOf(ref, this.clock.now() + slowSec * 1000));
      const finAlt = clamp(fin.alt, lo, hi);
      if (!(await this.runLeg({ az: this.nearestUnwrapped(fin.az, this.unwrappedAz!), alt: finAlt }, false, seq))) return { status: 'cancelled' };

      this.gotoActive = false;
      this.slew = 'idle';
      this.lastMotionEnd = this.clock.now();
      this.log('info', `Arrived at ${target.name}`);
      if (target.kind !== 'altaz') this.startTracking(ref);
      this.persist();
      this.changed();
      return { status: 'done', route: route.name };
    } catch (e) {
      if (seq !== this.gotoSeq) return { status: 'cancelled' };
      this.gotoActive = false;
      this.leg = null;
      this.slew = 'idle';
      this.changed();
      this.log('error', `GoTo failed: ${(e as Error).message}`);
      if (this.link) await this.haltAndVerify().catch(() => {});
      throw e;
    }
  }

  /** Choose the first candidate route whose simulated path keeps clear of the Sun (SAFETY.md §3.3). */
  private planRoute(start: Pose, dest: Pose, sun: AltAz | null): { name: string; steps: Step[] } {
    const cfg = this.config;
    const level = this.levelEncoderAlt() ?? 0;
    const waypointAlt = level + Math.max(cfg.altLimitsDeg[0] + 5, 10);
    const plans = candidatePlans(start, dest, { azRange: this.azRange(), waypointAlt });
    if (!plans.length) throw new Error(`Target would exceed the cable-wrap limit (±${cfg.azWrapSoftDeg}°) either way round; unwind first.`);
    const k: Kinematics = { vmax: cfg.gotoMaxRateDegPerSec, accel: cfg.gotoAccelDegPerSec2 };
    const params = this.alignment.model!;
    const checkSun = !cfg.solarFilterMode && !!sun && sun.alt > cfg.sunAltBlockDeg;
    const keepout = this.sunKeepoutDeg();
    for (const plan of plans) {
      const steps = splitLegs(start, plan.steps, cfg.azMaxLegDeg);
      if (!checkSun) return { name: plan.name, steps };
      const { poses } = simulate(start, steps, k, 0.1);
      const clear = poses.every((p) => sepAltAz(this.astro, this.astro.encoderToSky({ az: mod360(p.az), alt: p.alt }, params), sun!) >= keepout);
      if (clear) return { name: plan.name, steps };
    }
    throw new Error(`No GoTo route keeps ${keepout.toFixed(0)}° from the Sun; refused.`);
  }

  /** One GOTO leg on the axes in `step`; waits for SLEW_DONE with a per-leg timeout. false if cancelled. */
  private async runLeg(step: Step, fast: boolean, seq: number): Promise<boolean> {
    const cfg = this.config;
    await this.readPositions(); // fresh position for the allow-list distance checks
    if (seq !== this.gotoSeq) return false;
    const from: Pose = { az: this.unwrappedAz!, alt: this.lastPos!.alt };
    const k: Kinematics = fast ? { vmax: cfg.gotoMaxRateDegPerSec, accel: cfg.gotoAccelDegPerSec2 } : { vmax: cfg.gotoSlowRateDegPerSec, accel: cfg.gotoAccelDegPerSec2 };
    const dAz = step.az === undefined ? 0 : step.az - from.az;
    const dAlt = step.alt === undefined ? 0 : step.alt - from.alt;
    const predicted = Math.max(moveDuration(dAz, k), moveDuration(dAlt, k));
    const timeoutMs = Math.min(cfg.gotoTimeoutMs, (1.5 * predicted + 10) * 1000);
    const leg: Leg = { targets: {}, fast, startedAt: this.clock.now(), done: new Set(), peak: 0, distance: Math.max(Math.abs(dAz), Math.abs(dAlt)) };
    if (step.az !== undefined) leg.targets.az = step.az;
    if (step.alt !== undefined) leg.targets.alt = step.alt;
    this.leg = leg;
    const cmd = fast ? AuxCmd.GOTO_FAST : AuxCmd.GOTO_SLOW;
    for (const axis of AXES) {
      const t = leg.targets[axis];
      if (t === undefined) continue;
      if (seq !== this.gotoSeq) return false;
      this.axes[axis].lastChange = this.clock.now();
      await this.req(this.dev(axis), cmd, encodePosition(this.toRaw(axis, axis === 'az' ? mod360(t) : t)));
    }
    const deadline = Date.now() + timeoutMs;
    while (leg.done.size < Object.keys(leg.targets).length) {
      await sleep(cfg.pollIntervalMs);
      if (seq !== this.gotoSeq) return false;
      for (const axis of AXES) {
        if (leg.targets[axis] === undefined || leg.done.has(axis)) continue;
        const r = await this.req(this.dev(axis), AuxCmd.SLEW_DONE);
        if (seq !== this.gotoSeq) return false;
        if (r[0] === 0xff) {
          leg.done.add(axis);
          this.axes[axis].lastChange = this.clock.now();
        }
      }
      if (Date.now() > deadline) throw new Error(`GoTo leg timed out after ${(timeoutMs / 1000).toFixed(0)} s`);
    }
    if (fast && leg.distance > 15 && leg.peak > 0) {
      this.slewSpeedRatio = Math.round((leg.peak / cfg.gotoMaxRateDegPerSec) * 100) / 100;
      this.setWarning('power', this.slewSpeedRatio < 0.7 ? `Slew speed only ${Math.round(this.slewSpeedRatio * 100)}% of expected: power may be low.` : null);
    }
    this.leg = null;
    return true;
  }

  // ---------- tracking ----------

  async setTracking(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.tracking = false;
      this.reanchorAt = null;
      this.changed();
      if (!this.link) return;
      await this.setGuideRate('az', 0, true);
      await this.setGuideRate('alt', 0, true);
      return;
    }
    this.requireMotionAllowed();
    if (!this.alignment.model) throw new Error('Tracking needs an alignment (Home or a star) first');
    if (!this.location) throw new Error('Set your location before tracking');
    if (!this.lastPos) throw new Error('Telescope position unknown');
    if (this.gotoActive) throw new Error('GoTo in progress');
    this.requireAutoMotionSunSafe();
    // Resume the current target if we are still on it, else track wherever the scope points.
    const tg = this.target;
    let ref: TrackRef | null = null;
    if (tg && tg.kind !== 'altaz') {
      const sky = this.skyOf({ target: tg }, this.clock.now());
      const here = this.astro.encoderToSky(this.currentEncoder(), this.alignment.model);
      if (sepAltAz(this.astro, sky, here) < 1) ref = { target: tg };
    }
    this.startTracking(ref ?? this.anchorHere());
  }

  private startTracking(ref: TrackRef): void {
    this.trackRef = ref;
    this.tracking = true;
    this.reanchorAt = null;
    for (const a of AXES) this.axes[a].lastRateKey = null;
    this.changed();
    void this.trackTick();
  }

  /** A tracking reference for the current pointing: fixed RA/Dec, or an offset from the body being followed. */
  private anchorHere(): TrackRef {
    const params = this.alignment.model!;
    const loc = this.location!;
    const t = this.clock.now();
    const sky = this.astro.encoderToSky(this.currentEncoder(t), params);
    const base = this.trackRef?.target ?? this.target;
    if (base?.kind === 'body') {
      const b = this.astro.targetAltAz(base, loc, t);
      return { target: base, offset: { az: wrap180(sky.az - b.az), alt: sky.alt - b.alt } };
    }
    const rd = this.astro.altAzToRaDec(sky, loc, t);
    return { target: { kind: 'radec', ra: rd.ra, dec: rd.dec, name: base?.name ?? 'Current position' } };
  }

  private async stopTracking(reason: string): Promise<void> {
    this.log('warn', `${reason}; tracking stopped`);
    await this.setTracking(false);
  }

  /** One iteration of PROTOCOL.md §6.4: predictive central-difference rate + proportional correction. */
  private async trackTick(): Promise<void> {
    if (!this.tracking || !this.link || this.gotoActive || this.stopping || this.trackBusy || !this.lastPos) return;
    const params = this.alignment.model;
    if (!params || !this.location) return;
    this.trackBusy = true;
    const cfg = this.config;
    try {
      if (this.alignment.state.quality !== 'aligned' && this.sunIsUp()) return await this.stopTracking('The Sun is up and the alignment is rough');
      const t = this.clock.now();
      if (this.reanchorAt !== null) {
        if (t < this.reanchorAt) return;
        this.reanchorAt = null;
        this.trackRef = this.anchorHere();
        for (const a of AXES) this.axes[a].lastRateKey = null;
      }
      const ref = this.trackRef ?? (this.trackRef = this.anchorHere());
      const h = cfg.trackingPredictSec * 1000;
      const skyNow = this.skyOf(ref, t);
      const toEnc = (sky: AltAz) => this.astro.skyToEncoder(sky, params);
      const cur = toEnc(skyNow);
      const [lo, hi] = this.altEncLimits();
      if (cur.alt < lo + 2 || cur.alt > hi - 2) return await this.stopTracking(`${ref.target.name} is within 2° of the altitude limit`);
      if (skyNow.alt < 0) return await this.stopTracking(`${ref.target.name} has set`);
      const u = this.unwrappedAz;
      if (u !== null && Math.abs(u) > cfg.azWrapSoftDeg - 2) return await this.stopTracking('Cable-wrap limit reached');

      const prev = toEnc(this.skyOf(ref, t - h));
      const next = toEnc(this.skyOf(ref, t + h));
      const pos = this.currentEncoder(t);
      const maxCorr = cfg.trackingMaxCorrArcsec / 3600;
      for (const axis of AXES) {
        if (this.axes[axis].moving || !this.tracking || this.gotoActive) continue;
        const diff = (a: Enc, b: Enc) => (axis === 'az' ? wrap180(a.az - b.az) : a.alt - b.alt);
        const pred = diff(next, prev) / (2 * cfg.trackingPredictSec);
        const corr = clamp(diff(cur, pos) / cfg.trackingTauSec, -maxCorr, maxCorr);
        // Clamp keeps the azimuth rate bounded near the zenith.
        const rate = clamp(pred + corr, -cfg.trackingMaxRateDegPerSec, cfg.trackingMaxRateDegPerSec);
        await this.setGuideRate(axis, rate);
      }
    } catch (e) {
      if (!(e instanceof AuxDisconnectedError)) this.log('warn', `Tracking update failed: ${(e as Error).message}`);
    } finally {
      this.trackBusy = false;
    }
  }

  // ---------- location & alignment ----------

  setLocation(loc: GeoLocation): void {
    this.location = loc;
    try {
      this.alignment.refit(loc);
    } catch (e) {
      this.log('warn', `Alignment refit failed after location change: ${(e as Error).message}`);
    }
    this.persist();
    this.changed();
  }

  private requirePosition(): Enc {
    if (!this.lastPos) throw new Error('Telescope position unknown (connect first)');
    return this.currentEncoder();
  }

  /** Wait for the mount to settle after motion before capturing a position (SAFETY.md §6). */
  private async settle(): Promise<void> {
    const wait = this.lastMotionEnd + this.config.settleMs - this.clock.now();
    if (wait > 0) await sleep(wait);
  }

  /**
   * Home: the tube points at sky (azDeg, altDeg) now. Manual = level & north (0, 0); sensors = measured by a phone
   * on the tube (true az, with 1-sigma uncertainty). Both give quality 'rough': the same pre-alignment Sun rules.
   */
  alignHome(azDeg = 0, altDeg = 0, opts: AlignHomeOptions = {}): void {
    const source = opts.source ?? 'manual';
    if (!Number.isFinite(azDeg) || !Number.isFinite(altDeg)) throw new Error('Home: az/alt must be numbers');
    if (source === 'sensors' && Math.abs(altDeg) > MAX_SENSOR_ALT_DEG) {
      throw new Error(`Home from sensors refused: tube altitude ${altDeg.toFixed(1)}° (the compass is unreliable above ${MAX_SENSOR_ALT_DEG}°). Lower the tube and capture again.`);
    }
    if (Math.abs(altDeg) > 85) throw new Error(`Home refused: altitude ${altDeg.toFixed(1)}° is not plausible`);
    const az = azDeg >= 0 && azDeg < 360 ? azDeg : mod360(azDeg);
    const u = opts.uncertainty;
    this.alignment.setHome(this.requirePosition(), {
      source,
      azDeg: az,
      altDeg,
      ...(u ? { azSigmaDeg: u.azSigmaDeg, altSigmaDeg: u.altSigmaDeg } : {}),
      ...(opts.magHeadingDeg != null ? { magHeadingDeg: opts.magHeadingDeg } : {}),
      ...(opts.declinationDeg != null ? { declinationDeg: opts.declinationDeg } : {}),
      time: this.clock.now(),
    });
    const sig = u ? ` (±${u.azSigmaDeg.toFixed(1)}° az, ±${u.altSigmaDeg.toFixed(1)}° alt)` : '';
    this.log('info', `Home set from ${source === 'sensors' ? 'phone sensors' : 'level & north'}: encoder now means az ${az.toFixed(2)}°, alt ${altDeg.toFixed(2)}°${sig} (rough alignment)`);
    if (source === 'sensors') {
      const exp = expectedFirstStarErrorDeg(this.alignment.state.home);
      this.log('info', `The phone compass is only good to a few degrees: expect the first star within ~${exp ?? 10}°. Use the finder, then add stars to refine.`);
    }
    this.afterModelChange(null);
  }

  async alignAddPoint(target: Target): Promise<void> {
    if (!this.location) throw new Error('Set your location before aligning');
    await this.settle();
    const p = this.alignment.addPoint(target, this.requirePosition(), this.clock.now(), this.location);
    const a = this.alignment.state;
    this.log('info', `Alignment point ${p.id} (${target.name}) added; RMS ${a.rmsArcmin?.toFixed(1) ?? '?'}′, solved ${a.solved.join(',')}`);
    for (const w of this.alignment.fitWarnings) this.log('warn', `Alignment: ${w}`);
    this.afterModelChange(target);
  }

  alignRemovePoint(id: number): void {
    this.alignment.removePoint(id, this.location);
    for (const w of this.alignment.fitWarnings) this.log('warn', `Alignment: ${w}`);
    this.afterModelChange(null);
  }

  alignClear(): void {
    this.alignment.clear();
    this.afterModelChange(null);
  }

  async sync(target: Target): Promise<void> {
    if (!this.location) throw new Error('Set your location before syncing');
    await this.settle();
    this.alignment.sync(target, this.requirePosition(), this.clock.now(), this.location);
    this.log('info', `Synced on ${target.name}`);
    this.afterModelChange(target);
  }

  /** After the model changes: keep tracking what is centred, or stop if there is no model any more. */
  private afterModelChange(centred: Target | null): void {
    if (this.tracking) {
      if (!this.alignment.model) void this.setTracking(false);
      else if (centred && centred.kind !== 'altaz') {
        this.target = centred;
        this.startTracking({ target: centred });
      } else {
        try {
          this.trackRef = this.anchorHere();
        } catch {
          void this.setTracking(false);
        }
      }
    }
    this.persist();
    this.changed();
  }
}
