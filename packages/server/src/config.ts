// Server configuration. Everything PROTOCOL.md §10 marks as unverified lives here, with env overrides.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TELESCOPE_HOST, DEFAULT_TELESCOPE_PORT, SERVER_PORT } from '@stargazer/shared/api.ts';
import { AuxDevice, DEFAULT_RATE_SCALE } from '@stargazer/shared/aux.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface ServerConfig {
  serverPort: number;
  telescopeHost: string;
  telescopePort: number;

  // AUX bus
  sourceDevice: number; // our SRC id (0x20 = APP)
  azDevice: number;
  altDevice: number;
  wifiDevice: number;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  requestRetries: number;
  /** Consecutive failed polls before the link is declared dead. */
  maxPollFailures: number;
  reconnectDelayMs: number;
  enableCordwrap: boolean;

  // Mount geometry / rates (unverified on Astro Fi)
  /** Guide-rate value = arcsec/s × trackingScale. */
  trackingScale: number;
  /** +1: AZM encoder increases N→E (clockwise from above). -1 if the hardware is mirrored. */
  azDirection: 1 | -1;
  /** +1: ALT encoder increases upward. */
  altDirection: 1 | -1;
  /** deg/s for MOVE rates 0..9 (used for estimates only; the MC owns the real values). */
  slewRatesDegPerSec: number[];
  /** GOTO_FAST speed estimate (deg/s) for slew-time prediction. */
  gotoMaxRateDegPerSec: number;
  /** GOTO_SLOW speed estimate (deg/s). */
  gotoSlowRateDegPerSec: number;
  /** Fast slew stops this far short of the target, on the side opposite the approach direction. */
  gotoApproachOffsetDeg: number;
  /** Final approach direction per axis: AZM arrives moving +, ALT arrives moving − (SkySafari). */
  azApproach: 1 | -1;
  altApproach: 1 | -1;
  /** GOTO_FAST acceleration estimate (deg/s²) for path simulation and timeouts. */
  gotoAccelDegPerSec2: number;
  /** Upper cap for one GoTo leg's timeout (ms); the per-leg timeout is 1.5 × predicted + 10 s. */
  gotoTimeoutMs: number;
  /** Mechanical altitude limits (deg above level, SAFETY.md §1.3). */
  altLimitsDeg: [number, number];
  /** Alt envelope around the power-on position while the alt reference is unknown (quality 'none'). */
  unknownAltEnvelopeDeg: number;
  /** Max manual rate while the alt reference is unknown. */
  unknownMaxRate: number;
  /** Cable wrap, unwrapped azimuth from cable-neutral (deg). */
  azWrapSoftDeg: number;
  azWrapHardDeg: number;
  /** Max azimuth travel of one GOTO command (deg); longer slews are split into legs. */
  azMaxLegDeg: number;
  /** Targets closer than this to the Sun are refused (unless solarFilterMode and force). */
  sunSafetyDeg: number;
  /** GoTo paths keep at least this + 3 × model RMS from the Sun while it is up. */
  sunPathKeepoutDeg: number;
  /** "Sun is up" threshold (deg). With quality none/rough, no automatic motion above it. */
  sunAltBlockDeg: number;
  /** Allows `force` to override the Sun-proximity refusal (explicit solar-filter setup). */
  solarFilterMode: boolean;
  /** Firmware older than this gets a warning (7.13 runaway bug, 7.15.8160 fixes). */
  minMcVersion: string;

  // Motion protection (SAFETY.md §2)
  stallSpeedFraction: number;
  stallWindowMs: number;
  runawayFactor: number;
  stopVerifyMs: number;
  reversalWaitMs: number;
  moveMaxMsFast: number;
  moveMaxMsSlow: number;
  deadmanMs: number;
  settleMs: number;
  discoveryTimeoutMs: number;
  batteryPollMs: number;

  // Loops
  pollIntervalMs: number;
  trackingPeriodMs: number;
  /** Central-difference half window for the predictive rate (s). */
  trackingPredictSec: number;
  /** Proportional correction time constant (s). */
  trackingTauSec: number;
  /** Max proportional correction (arcsec/s). */
  trackingMaxCorrArcsec: number;
  /** Max |rate| sent while tracking (deg/s); clamps the azimuth rate near the zenith. */
  trackingMaxRateDegPerSec: number;

  // Power-cycle detection
  powerCycleZeroTolDeg: number;
  powerCycleMinMoveDeg: number;

  // Paths
  stateFile: string | null;
  /** Rotating TX/RX packet log (hex); null disables. */
  packetLogFile: string | null;
  webDist: string;
  dataDir: string;
}

export const DEFAULT_CONFIG: ServerConfig = {
  serverPort: SERVER_PORT,
  telescopeHost: DEFAULT_TELESCOPE_HOST,
  telescopePort: DEFAULT_TELESCOPE_PORT,
  sourceDevice: AuxDevice.APP,
  azDevice: AuxDevice.AZM,
  altDevice: AuxDevice.ALT,
  wifiDevice: AuxDevice.WIFI,
  connectTimeoutMs: 5000,
  requestTimeoutMs: 800,
  requestRetries: 2,
  maxPollFailures: 3,
  reconnectDelayMs: 5000,
  // Off: we track unwrapped azimuth and split GoTos into ≤170° legs, so the MC's own cordwrap
  // avoidance (which may take the long way round) would only make the direction unpredictable.
  enableCordwrap: false,
  trackingScale: DEFAULT_RATE_SCALE,
  azDirection: 1,
  altDirection: 1,
  slewRatesDegPerSec: [0, 0.008, 0.017, 0.033, 0.067, 0.133, 0.5, 1, 2, 3],
  gotoMaxRateDegPerSec: 3,
  gotoSlowRateDegPerSec: 0.5,
  gotoApproachOffsetDeg: 2,
  azApproach: 1,
  altApproach: -1,
  gotoAccelDegPerSec2: 3,
  gotoTimeoutMs: 150_000,
  altLimitsDeg: [-5, 70],
  unknownAltEnvelopeDeg: 30,
  unknownMaxRate: 6,
  azWrapSoftDeg: 200,
  azWrapHardDeg: 240,
  azMaxLegDeg: 170,
  sunSafetyDeg: 20,
  sunPathKeepoutDeg: 15,
  sunAltBlockDeg: -6,
  solarFilterMode: false,
  minMcVersion: '7.15.8160',
  stallSpeedFraction: 0.25,
  stallWindowMs: 1500,
  runawayFactor: 1.5,
  stopVerifyMs: 2000,
  reversalWaitMs: 400,
  moveMaxMsFast: 30_000,
  moveMaxMsSlow: 120_000,
  deadmanMs: 600,
  settleMs: 2500,
  discoveryTimeoutMs: 300,
  batteryPollMs: 30_000,
  pollIntervalMs: 250,
  trackingPeriodMs: 1000,
  trackingPredictSec: 5,
  trackingTauSec: 10,
  trackingMaxCorrArcsec: 30,
  trackingMaxRateDegPerSec: 1,
  powerCycleZeroTolDeg: 0.05,
  powerCycleMinMoveDeg: 0.5,
  stateFile: path.join(os.homedir(), '.stargazer', 'state.json'),
  packetLogFile: path.join(os.homedir(), '.stargazer', 'packets.log'),
  webDist: path.join(repoRoot, 'packages/web/dist'),
  dataDir: path.join(repoRoot, 'data'),
};

type Env = Record<string, string | undefined>;

const num = (v: string | undefined, def: number) => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`config: not a number: ${v}`);
  return n;
};
const sign = (v: string | undefined, def: 1 | -1): 1 | -1 => (v === undefined || v === '' ? def : Number(v) < 0 ? -1 : 1);
const bool = (v: string | undefined, def: boolean) => (v === undefined || v === '' ? def : !['0', 'false', 'no', 'off'].includes(v.toLowerCase()));
const list = (v: string | undefined, def: number[]) => (v ? v.split(',').map((x) => num(x.trim(), NaN)) : def);

/** Build config from defaults, env (STARGAZER_xxx, TELESCOPE_HOST/PORT, SERVER_PORT) and explicit overrides. */
export function loadConfig(env: Env = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const d = DEFAULT_CONFIG;
  const altLimits = list(env.STARGAZER_ALT_LIMITS, d.altLimitsDeg);
  const cfg: ServerConfig = {
    ...d,
    serverPort: num(env.SERVER_PORT ?? env.PORT, d.serverPort),
    telescopeHost: env.TELESCOPE_HOST || d.telescopeHost,
    telescopePort: num(env.TELESCOPE_PORT, d.telescopePort),
    sourceDevice: num(env.STARGAZER_SOURCE_DEVICE, d.sourceDevice),
    requestTimeoutMs: num(env.STARGAZER_REQUEST_TIMEOUT_MS, d.requestTimeoutMs),
    enableCordwrap: bool(env.STARGAZER_CORDWRAP, d.enableCordwrap),
    trackingScale: num(env.STARGAZER_TRACKING_SCALE, d.trackingScale),
    azDirection: sign(env.STARGAZER_AZ_DIRECTION, d.azDirection),
    altDirection: sign(env.STARGAZER_ALT_DIRECTION, d.altDirection),
    slewRatesDegPerSec: list(env.STARGAZER_SLEW_RATES, d.slewRatesDegPerSec),
    gotoMaxRateDegPerSec: num(env.STARGAZER_GOTO_MAX_RATE, d.gotoMaxRateDegPerSec),
    gotoSlowRateDegPerSec: num(env.STARGAZER_GOTO_SLOW_RATE, d.gotoSlowRateDegPerSec),
    gotoApproachOffsetDeg: num(env.STARGAZER_APPROACH_OFFSET, d.gotoApproachOffsetDeg),
    azApproach: sign(env.STARGAZER_AZ_APPROACH, d.azApproach),
    altApproach: sign(env.STARGAZER_ALT_APPROACH, d.altApproach),
    altLimitsDeg: [altLimits[0] ?? d.altLimitsDeg[0], altLimits[1] ?? d.altLimitsDeg[1]],
    sunSafetyDeg: num(env.STARGAZER_SUN_SAFETY_DEG, d.sunSafetyDeg),
    solarFilterMode: bool(env.STARGAZER_SOLAR_FILTER_MODE, d.solarFilterMode),
    azWrapSoftDeg: num(env.STARGAZER_AZ_WRAP_SOFT, d.azWrapSoftDeg),
    azWrapHardDeg: num(env.STARGAZER_AZ_WRAP_HARD, d.azWrapHardDeg),
    settleMs: num(env.STARGAZER_SETTLE_MS, d.settleMs),
    pollIntervalMs: num(env.STARGAZER_POLL_MS, d.pollIntervalMs),
    trackingPeriodMs: num(env.STARGAZER_TRACKING_PERIOD_MS, d.trackingPeriodMs),
    stateFile: env.STARGAZER_STATE_FILE === 'none' ? null : env.STARGAZER_STATE_FILE || d.stateFile,
    packetLogFile: env.STARGAZER_PACKET_LOG === 'none' ? null : env.STARGAZER_PACKET_LOG || d.packetLogFile,
    webDist: env.STARGAZER_WEB_DIST || d.webDist,
    dataDir: env.STARGAZER_DATA_DIR || d.dataDir,
    ...overrides,
  };
  if (cfg.slewRatesDegPerSec.length !== 10 || cfg.slewRatesDegPerSec.some((r) => !Number.isFinite(r))) {
    throw new Error('config: slew-rate table needs 10 numbers');
  }
  return cfg;
}
