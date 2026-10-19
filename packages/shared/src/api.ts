// Contract between the web GUI and the server (WebSocket JSON messages on /ws).
// All angles are DEGREES. RA is degrees (0..360), not hours. Sky coordinates are J2000 unless noted.
// Times are milliseconds since epoch (UTC).

export type Axis = 'az' | 'alt';

export interface GeoLocation {
  lat: number; // +N
  lon: number; // +E
  elevation: number; // metres
  source: 'gps' | 'cache' | 'manual' | 'city';
  label?: string;
}

/** Something the telescope can point at. Bodies move, so the server recomputes their position continuously. */
export type Target =
  | { kind: 'radec'; ra: number; dec: number; name: string; id?: string }
  | { kind: 'body'; body: SolarBody; name: string }
  | { kind: 'altaz'; az: number; alt: number; name: string }; // fixed terrestrial direction, never tracked

export type SolarBody = 'Moon' | 'Mercury' | 'Venus' | 'Mars' | 'Jupiter' | 'Saturn' | 'Uranus' | 'Neptune' | 'Sun';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type SlewState = 'idle' | 'manual' | 'goto-fast' | 'goto-slow';

export interface AlignmentPoint {
  id: number;
  target: Target; // what the user centred
  encoder: { az: number; alt: number }; // raw encoder degrees when centred (alt signed)
  time: number;
  residualArcmin?: number; // after fit
}

export interface PointingModelParams {
  IA: number; // az encoder zero offset (deg)
  IE: number; // alt encoder zero offset (deg)
  AN: number; // az axis tilt toward north (deg)
  AW: number; // az axis tilt toward west (deg)
  CA: number; // collimation (deg)
  NPAE: number; // non-perpendicularity (deg)
}

export interface AlignmentState {
  /** 'none' = no model. 'rough' = home position only. 'aligned' = fitted from >=1 star. */
  quality: 'none' | 'rough' | 'aligned';
  points: AlignmentPoint[];
  params: PointingModelParams | null;
  rmsArcmin: number | null;
  /** Which params were solved, e.g. ['IA','IE'] for 1 star. */
  solved: (keyof PointingModelParams)[];
  /** How Home was set (absent from older servers; null before Home). */
  home?: AlignmentHome | null;
}

export type HomeSource = 'manual' | 'sensors';

/** The Home reference: where the tube pointed (sky az/alt) when Home was pressed, and how that was known. */
export interface AlignmentHome {
  /** 'manual' = the user levelled the tube and pointed it north; 'sensors' = measured by a phone on the tube. */
  source: HomeSource;
  azDeg: number;
  altDeg: number;
  /** 1-sigma uncertainty (deg), when known (sensors). */
  azSigmaDeg?: number;
  altSigmaDeg?: number;
  /** Sensors only: the raw magnetic heading and the WMM declination added to it. */
  magHeadingDeg?: number;
  declinationDeg?: number;
  time: number;
}

export interface MountState {
  connection: ConnectionStatus;
  host: string;
  port: number;
  error?: string;
  firmware?: { az?: string; alt?: string; wifi?: string };
  /** Raw encoder degrees (az 0..360, alt -180..180); null when unknown. */
  encoder: { az: number; alt: number } | null;
  /** Where the scope points according to the model. null if no model (quality 'none'). */
  pointing: { ra: number; dec: number; az: number; alt: number } | null;
  slew: SlewState;
  target: Target | null;
  tracking: boolean;
  alignment: AlignmentState;
  location: GeoLocation | null;
  serverTime: number;
  simulator: boolean; // true when connected to the local simulator
  /** Optional safety/telemetry details (SAFETY.md §5). Absent from older servers. */
  health?: MountHealth;
  /** Safety limits from the server config, so the GUI can explain refusals before they happen. */
  limits?: MountLimits;
  /** GUI clients (WebSocket connections) on this server right now, including the receiver. Absent from older servers. */
  clients?: number;
  /** How other devices can reach this server (for the phone remote). Absent from older servers and the mock. */
  network?: ServerNetwork;
}

export interface ServerNetwork {
  /** Address the HTTP server listens on, e.g. '127.0.0.1' (this computer only) or '0.0.0.0' (all interfaces). */
  bind: string;
  port: number;
  /** http(s)://<LAN IPv4>:<port>/ URLs for other devices; empty when bound to loopback. */
  lanUrls: string[];
  /** Served over HTTPS/WSS with a local self-signed certificate (`npm run start:lan:https`). Absent = false. */
  https?: boolean;
  /** SHA-256 fingerprint of the server certificate (HTTPS only), so the user can check the browser warning. */
  certFingerprint?: string;
  /** Path of the local CA certificate a phone may install to skip the warning (HTTPS only), e.g. '/stargazer-ca.crt'. */
  caCertPath?: string;
}

/** An entry in the shared observing list (persisted on the server, broadcast to every client). */
export interface ObservingListEntry {
  id: string;
  name: string;
  target: Target;
  addedAt: number;
  /** When it was marked observed; null if not yet. */
  observedAt: number | null;
  note?: string;
}

export interface MountLimits {
  /** Mechanical altitude limits (deg above level). GoTo targets outside are refused, even with force. */
  altDeg: [number, number];
  /** GoTo targets closer than this to the Sun are refused (deg). */
  sunDeg: number;
  /** "Sun is up" threshold (deg). While above it, GoTo/tracking need quality 'aligned'. */
  sunUpAltDeg: number;
  /** Cable wrap soft / hard limits on the unwrapped azimuth (deg from cable-neutral). */
  azSoftDeg: number;
  azHardDeg: number;
  /** Solar-filter mode: Sun-proximity refusals become confirmations. */
  solarFilterMode: boolean;
  /** The server waits this long after motion before capturing an alignment point (ms). */
  settleMs: number;
}

export interface MountHealth {
  /** null = no battery device (expected on Astro Fi); undefined = not probed yet. */
  battery?: { volts: number; level: string; charging: boolean } | null;
  /** Median AUX round-trip time (ms). */
  latencyMs: number;
  /** AUX request timeouts this session. */
  timeouts: number;
  /** Peak GOTO_FAST speed / expected cruise speed for the last long slew (power-health proxy). */
  slewSpeedRatio?: number;
  /** Human-readable warnings and latched faults (faults are prefixed "FAULT:"; a `stop` acknowledges them). */
  warnings: string[];
  /** Unwrapped azimuth from cable-neutral (deg); cable-wrap limits apply to this. */
  unwrappedAz?: number;
  /** Latched fault (stall, runaway, limit, ...). Motion is refused until a `stop` acknowledges it. */
  fault?: string;
  /** The last stop could not be verified: the mount may still be moving. The user must cut the power. */
  stopFailed?: boolean;
  /** A hand controller is attached: Stargazer is read-only. */
  observer?: boolean;
}

/** Message of the `error` the server sends when a stop fails (also flagged by `health.stopFailed`). */
export const STOP_FAILED_MESSAGE = 'STOP FAILED: UNPLUG THE TELESCOPE POWER NOW';

// ---------- client -> server ----------
export type ClientMessage =
  | { type: 'connect'; host?: string; port?: number } // defaults 1.2.3.4:2000, or env TELESCOPE_HOST/PORT
  | { type: 'disconnect' }
  /**
   * Press-and-hold manual move. rate 1..9. Stops tracking for that axis while moving.
   * Dead-man: while held, re-send the same message every ~200 ms as a heartbeat; the server stops the axis
   * if no heartbeat arrives within 600 ms (and on WS close). Send stopAxis (or rate 0) on release.
   * Several clients: the latest client to send `move` for an axis owns it. A client's stopAxis, dead-man and
   * disconnect only stop the axes it owns; `stop` from any client stops everything.
   */
  | { type: 'move'; axis: Axis; direction: 1 | -1; rate: number }
  | { type: 'stopAxis'; axis: Axis }
  | { type: 'stop' } // abort everything: goto, manual, tracking
  | { type: 'goto'; target: Target; force?: boolean } // force overrides sun-safety and alt-limit warnings where allowed
  | { type: 'setTracking'; enabled: boolean }
  | { type: 'setLocation'; location: GeoLocation }
  /**
   * Home: the tube points at sky (azDeg, altDeg) right now, which gives the initial IA/IE guess (quality 'rough').
   * Manual Home: the user levelled the tube and pointed it north (defaults 0, 0). Sensor Home: a phone on the tube
   * measured az/alt (`source: 'sensors'`, with 1-sigma `uncertainty`; az is true, i.e. declination-corrected).
   * Safety is the same for both (quality 'rough'). `source` defaults to 'manual'.
   */
  | {
      type: 'alignHome';
      azDeg?: number;
      altDeg?: number;
      source?: HomeSource;
      uncertainty?: { azSigmaDeg: number; altSigmaDeg: number };
      /** Sensors only (for display): magnetic heading and the declination that was added to it. */
      magHeadingDeg?: number;
      declinationDeg?: number;
    }
  /** User centred `target` in the eyepiece: record current encoder position as an alignment point and refit. */
  | { type: 'alignAddPoint'; target: Target }
  | { type: 'alignRemovePoint'; id: number }
  | { type: 'alignClear' }
  /** Quick sync: adjust IA/IE only so that current position == target. */
  | { type: 'sync'; target: Target }
  // Observing list (shared by all clients; the server replies to everyone with `list`).
  | { type: 'listAdd'; target: Target; note?: string }
  | { type: 'listRemove'; id: string }
  /** Move an entry to position `index` (0-based, clamped). */
  | { type: 'listMove'; id: string; index: number }
  /** Mark observed (default) or not; `note` replaces the entry's note when given ('' clears it). */
  | { type: 'listMarkObserved'; id: string; observed?: boolean; note?: string };

// ---------- server -> client ----------
export type ServerMessage =
  | { type: 'state'; state: MountState } // sent on change and at least every 250 ms while connected, 1 s otherwise
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; time: number }
  | { type: 'error'; message: string; requestType?: ClientMessage['type'] }
  /** Server refused a goto that needs confirmation (sun proximity, below horizon). Resend with force:true. */
  | { type: 'confirm'; message: string; request: ClientMessage }
  /** The whole observing list: sent on WS connect and to every client after each change. Older servers never send it. */
  | { type: 'list'; entries: ObservingListEntry[] };

export const DEFAULT_TELESCOPE_HOST = '1.2.3.4';
export const DEFAULT_TELESCOPE_PORT = 2000;
export const SERVER_PORT = 8080;
export const SIMULATOR_AUX_PORT = 2000;
export const SIMULATOR_HTTP_PORT = 2001;

/** Simulator debug HTTP API (GET http://localhost:2001/truth). Not available on real hardware. */
export interface SimulatorTruth {
  encoder: { az: number; alt: number };
  /** Where the tube truly points, using the simulator's hidden mount errors and location/time. */
  sky: { ra: number; dec: number; az: number; alt: number };
  hidden: PointingModelParams;
  location: { lat: number; lon: number };
}
