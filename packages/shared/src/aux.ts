// Celestron AUX packet codec, constants and 24-bit position/rate math (PROTOCOL.md §3-6).
// Isomorphic: uses Uint8Array only (Node Buffers are Uint8Arrays too).

export const AUX_PREAMBLE = 0x3b;

/** AUX bus device IDs (PROTOCOL.md §3.1). */
export const AuxDevice = {
  ANY: 0x00,
  MB: 0x01,
  HC: 0x04,
  HC_PLUS: 0x0d,
  STARSENSE_HC: 0x0e,
  AZM: 0x10,
  ALT: 0x11,
  FOCUSER: 0x12,
  APP: 0x20,
  GPS: 0xb0,
  STARSENSE_CAM: 0xb4,
  WIFI: 0xb5,
} as const;

/** Motor-controller command IDs (PROTOCOL.md §4). */
export const AuxCmd = {
  GET_POSITION: 0x01,
  GOTO_FAST: 0x02,
  SET_POSITION: 0x04,
  GET_MODEL: 0x05,
  SET_POS_GUIDERATE: 0x06,
  SET_NEG_GUIDERATE: 0x07,
  LEVEL_START: 0x0b,
  SET_POS_BACKLASH: 0x10,
  SET_NEG_BACKLASH: 0x11,
  LEVEL_DONE: 0x12,
  SLEW_DONE: 0x13,
  GOTO_SLOW: 0x17,
  SEEK_DONE: 0x18,
  SEEK_INDEX: 0x19,
  SET_MAXRATE: 0x20,
  GET_MAXRATE: 0x21,
  ENABLE_MAXRATE: 0x22,
  MAXRATE_ENABLED: 0x23,
  MOVE_POS: 0x24,
  MOVE_NEG: 0x25,
  AUX_GUIDE: 0x26,
  AUX_GUIDE_ACTIVE: 0x27,
  ENABLE_CORDWRAP: 0x38,
  DISABLE_CORDWRAP: 0x39,
  SET_CORDWRAP_POS: 0x3a,
  POLL_CORDWRAP: 0x3b,
  GET_CORDWRAP_POS: 0x3c,
  GET_POS_BACKLASH: 0x40,
  GET_NEG_BACKLASH: 0x41,
  SET_AUTOGUIDE_RATE: 0x46,
  GET_AUTOGUIDE_RATE: 0x47,
  /** Firmware quirk: GET_AUTOGUIDE_RATE is answered with CMD 0xF0 and data[0] = 0x47. */
  QUIRK_F0: 0xf0,
  GET_APPROACH: 0xfc,
  SET_APPROACH: 0xfd,
  GET_VER: 0xfe,
} as const;

export interface AuxPacket {
  src: number;
  dst: number;
  cmd: number;
  data: Uint8Array;
}

/** Two's complement of the byte sum over LEN..DATA. `body` = [LEN, SRC, DST, CMD, ...DATA]. */
export function auxChecksum(body: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += body[i]!;
  return -sum & 0xff;
}

export function encodePacket(p: { src: number; dst: number; cmd: number; data?: ArrayLike<number> }): Uint8Array {
  const data = p.data ?? [];
  const len = 3 + data.length;
  if (len > 0xff) throw new Error(`AUX payload too long (${data.length} bytes)`);
  const out = new Uint8Array(len + 3);
  out[0] = AUX_PREAMBLE;
  out[1] = len;
  out[2] = p.src & 0xff;
  out[3] = p.dst & 0xff;
  out[4] = p.cmd & 0xff;
  for (let i = 0; i < data.length; i++) out[5 + i] = data[i]! & 0xff;
  out[len + 2] = auxChecksum(out.subarray(1, len + 2));
  return out;
}

/** Decode exactly one complete packet. Returns null if the framing or checksum is invalid. */
export function decodePacket(bytes: ArrayLike<number>): AuxPacket | null {
  if (bytes.length < 6 || bytes[0] !== AUX_PREAMBLE) return null;
  const len = bytes[1]!;
  if (len < 3 || bytes.length !== len + 3) return null;
  const body = Array.prototype.slice.call(bytes, 1, len + 2) as number[];
  if (auxChecksum(body) !== bytes[len + 2]) return null;
  return { src: bytes[2]!, dst: bytes[3]!, cmd: bytes[4]!, data: Uint8Array.from(body.slice(4)) };
}

export interface ParsedFrame extends AuxPacket {
  raw: Uint8Array;
}

/**
 * Streaming frame parser. Feed arbitrary TCP chunks; complete, checksum-valid packets come out.
 * Skips non-0x3B bytes (ASCII banners etc.) and resyncs byte-by-byte after a bad checksum.
 */
export class AuxFrameParser {
  private buf = new Uint8Array(0);
  /** Count of bytes discarded while resyncing (diagnostics). */
  discarded = 0;

  /** maxLen caps LEN so a stray 0x3B in garbage cannot stall the parser (real packets have LEN <= ~11). */
  constructor(private readonly maxLen = 32) {}

  push(chunk: ArrayLike<number>): ParsedFrame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk as ArrayLike<number>, this.buf.length);
    const out: ParsedFrame[] = [];
    let i = 0;
    while (i < merged.length) {
      if (merged[i] !== AUX_PREAMBLE) {
        i++;
        this.discarded++;
        continue;
      }
      if (i + 1 >= merged.length) break; // need LEN
      const len = merged[i + 1]!;
      if (len < 3 || len > this.maxLen) {
        i++;
        this.discarded++;
        continue;
      }
      const total = len + 3;
      if (i + total > merged.length) break; // wait for more bytes
      const raw = merged.slice(i, i + total);
      const pkt = decodePacket(raw);
      if (!pkt) {
        i++; // bad checksum: resync from the next byte
        this.discarded++;
        continue;
      }
      out.push({ ...pkt, raw });
      i += total;
    }
    this.buf = merged.slice(i);
    return out;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }
}

// ---------- 24-bit positions (PROTOCOL.md §5) ----------

export const STEPS_PER_REV = 1 << 24;
const MASK24 = 0xffffff;

export function be24(v: number): [number, number, number] {
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

export function readBe24(b: ArrayLike<number>, offset = 0): number {
  return ((b[offset]! << 16) | (b[offset + 1]! << 8) | b[offset + 2]!) >>> 0;
}

export function readBe16(b: ArrayLike<number>, offset = 0): number {
  return (b[offset]! << 8) | b[offset + 1]!;
}

/** Degrees to unsigned 24-bit steps (wraps; negative angles become two's complement). */
export function degToSteps(deg: number): number {
  const s = Math.round((deg / 360) * STEPS_PER_REV) % STEPS_PER_REV;
  return (s + STEPS_PER_REV) % STEPS_PER_REV;
}

/** Unsigned steps to azimuth degrees 0..360. */
export function stepsToDegAz(steps: number): number {
  return ((steps & MASK24) * 360) / STEPS_PER_REV;
}

/** Steps interpreted as signed 24-bit to altitude degrees -180..180. */
export function stepsToDegAlt(steps: number): number {
  const s = steps & MASK24;
  return ((s >= 0x800000 ? s - STEPS_PER_REV : s) * 360) / STEPS_PER_REV;
}

export function encodePosition(deg: number): [number, number, number] {
  return be24(degToSteps(deg));
}

/**
 * Decode a position payload. 3 bytes is the normal form; a 2-byte form is the top 16 bits.
 * `signed` = true for ALT (-180..180), false for AZM (0..360).
 */
export function decodePosition(data: ArrayLike<number>, signed: boolean): number {
  const steps = data.length >= 3 ? readBe24(data) : data.length === 2 ? readBe16(data) << 8 : NaN;
  if (Number.isNaN(steps)) throw new Error(`bad position payload length ${data.length}`);
  return signed ? stepsToDegAlt(steps) : stepsToDegAz(steps);
}

// ---------- guide rates (PROTOCOL.md §6.1) ----------

/** Default guide-rate scale: 3-byte value = arcsec/s × 1024. Unverified on Astro Fi, hence configurable. */
export const DEFAULT_RATE_SCALE = 1024;
export const SIDEREAL_ARCSEC_PER_SEC = 15.041;

/** Unsigned 24-bit guide-rate value for a rate magnitude in arcsec/s (clamped to 0..0xFFFFFF). */
export function rateToValue(arcsecPerSec: number, scale = DEFAULT_RATE_SCALE): number {
  return Math.min(MASK24, Math.max(0, Math.round(Math.abs(arcsecPerSec) * scale)));
}

export function valueToRate(value: number, scale = DEFAULT_RATE_SCALE): number {
  return value / scale;
}

/** Build the SET_POS/NEG_GUIDERATE command + payload for a signed rate in arcsec/s. */
export function encodeGuideRate(arcsecPerSec: number, scale = DEFAULT_RATE_SCALE): { cmd: number; data: [number, number, number]; value: number } {
  const value = rateToValue(arcsecPerSec, scale);
  return { cmd: arcsecPerSec < 0 ? AuxCmd.SET_NEG_GUIDERATE : AuxCmd.SET_POS_GUIDERATE, data: be24(value), value };
}

/** 2-byte guide-rate specials (EQ modes only; never used for alt-az tracking). */
export const GUIDERATE_SIDEREAL = 0xffff;
export const GUIDERATE_SOLAR = 0xfffe;
export const GUIDERATE_LUNAR = 0xfffd;

/**
 * Decode a guide-rate payload to an unsigned rate in arcsec/s.
 * 3 bytes: value/scale. 2 bytes: specials, else value in 1/4 arcsec/s (= value<<8 / 1024).
 */
export function decodeGuideRate(data: ArrayLike<number>, scale = DEFAULT_RATE_SCALE): number {
  if (data.length >= 3) return valueToRate(readBe24(data), scale);
  if (data.length === 2) {
    const v = readBe16(data);
    if (v === GUIDERATE_SIDEREAL) return SIDEREAL_ARCSEC_PER_SEC;
    if (v === GUIDERATE_SOLAR) return 15.0;
    if (v === GUIDERATE_LUNAR) return 14.685;
    return valueToRate(v << 8, scale);
  }
  throw new Error(`bad guide-rate payload length ${data.length}`);
}

// ---------- misc helpers ----------

export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes as ArrayLike<number>, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2) throw new Error('odd hex length');
  return Uint8Array.from(clean.match(/../g) ?? [], (h) => parseInt(h, 16));
}

/** Format a GET_VER payload: 4 bytes "7.10.4109", 2 bytes "4.21". */
export function formatVersion(data: ArrayLike<number>): string {
  if (data.length >= 4) return `${data[0]}.${data[1]}.${(data[2]! << 8) | data[3]!}`;
  if (data.length >= 2) return `${data[0]}.${data[1]}`;
  return Array.from(data as ArrayLike<number>).join('.');
}

export function deviceName(id: number): string {
  for (const [k, v] of Object.entries(AuxDevice)) if (v === id) return k;
  return `0x${id.toString(16).padStart(2, '0')}`;
}

export function commandName(id: number): string {
  for (const [k, v] of Object.entries(AuxCmd)) if (v === id) return k;
  return `0x${id.toString(16).padStart(2, '0')}`;
}

export function describePacket(p: AuxPacket): string {
  return `${deviceName(p.src)}->${deviceName(p.dst)} ${commandName(p.cmd)}${p.data.length ? ' [' + toHex(p.data) + ']' : ''}`;
}
