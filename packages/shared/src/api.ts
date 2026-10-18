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
}

// ---------- client -> server ----------
export type ClientMessage =
  | { type: 'connect'; host?: string; port?: number } // defaults 1.2.3.4:2000, or env TELESCOPE_HOST/PORT
  | { type: 'disconnect' }
  /** Press-and-hold manual move. rate 1..9. Send rate 0 (or 'stop') on release. Stops tracking for that axis while moving. */
  | { type: 'move'; axis: Axis; direction: 1 | -1; rate: number }
  | { type: 'stopAxis'; axis: Axis }
  | { type: 'stop' } // abort everything: goto, manual, tracking
  | { type: 'goto'; target: Target; force?: boolean } // force overrides sun-safety and alt-limit warnings where allowed
  | { type: 'setTracking'; enabled: boolean }
  | { type: 'setLocation'; location: GeoLocation }
  /** User has physically pointed the tube level & north: gives initial IA/IE guess (quality 'rough'). */
  | { type: 'alignHome'; azDeg?: number; altDeg?: number } // defaults 0 (north), 0 (level)
  /** User centred `target` in the eyepiece: record current encoder position as an alignment point and refit. */
  | { type: 'alignAddPoint'; target: Target }
  | { type: 'alignRemovePoint'; id: number }
  | { type: 'alignClear' }
  /** Quick sync: adjust IA/IE only so that current position == target. */
  | { type: 'sync'; target: Target };

// ---------- server -> client ----------
export type ServerMessage =
  | { type: 'state'; state: MountState } // sent on change and at least every 250 ms while connected, 1 s otherwise
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; time: number }
  | { type: 'error'; message: string; requestType?: ClientMessage['type'] }
  /** Server refused a goto that needs confirmation (sun proximity, below horizon). Resend with force:true. */
  | { type: 'confirm'; message: string; request: ClientMessage };

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
