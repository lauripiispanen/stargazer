// Outgoing AUX command allow-list (SAFETY.md §4.3). Keyed on (DST, CMD, payload length) with value checks.
// Everything not listed is refused: firmware programming (0x81–0x84), persistent register writes
// (backlash, max rate, approach, autoguide), autonomous index/level seeks, and any write to non-MC devices.
import { AuxCmd, AuxDevice, commandName, decodePosition, deviceName, readBe24 } from '@stargazer/shared/aux.ts';

export class AuxForbiddenError extends Error {
  constructor(reason: string) {
    super(`AUX command refused: ${reason}`);
    this.name = 'AuxForbiddenError';
  }
}

/** Devices probed with GET_VER once per connect (SAFETY.md §5.4). */
export const DISCOVERY_DEVICES = [0x01, 0x04, 0x0d, 0x0e, 0x12, 0xb0, 0xb4, AuxDevice.WIFI, 0xb6, 0xb7, 0xbf] as const;
export const BATTERY_DEVICE = 0xb6;
export const BAT_GET_STATUS = 0x10;
/** Max guide-rate value (1°/s at ×1024). */
export const MAX_GUIDE_VALUE = 0x384000;
export const MAX_AZ_LEG_DEG = 170;
export const MAX_SLOW_GOTO_DEG = 5;

export interface AllowContext {
  /** Devices that answered GET_VER on this connection. */
  answered: ReadonlySet<number>;
  /** True while a GOTO is running on the given motor controller (cleared by SLEW_DONE = ff). */
  gotoActive(dev: number): boolean;
  /** Last polled raw position (deg) of a motor controller, or null. */
  position(dev: number): number | null;
}

const MC_READS = new Set<number>([
  AuxCmd.GET_POSITION,
  AuxCmd.SLEW_DONE,
  AuxCmd.GET_VER,
  AuxCmd.GET_MODEL,
  AuxCmd.GET_MAXRATE,
  AuxCmd.MAXRATE_ENABLED,
  AuxCmd.GET_POS_BACKLASH,
  AuxCmd.GET_NEG_BACKLASH,
  AuxCmd.GET_APPROACH,
]);
const AZM_READS = new Set<number>([AuxCmd.POLL_CORDWRAP, AuxCmd.GET_CORDWRAP_POS]);

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Throws AuxForbiddenError unless the packet is explicitly allowed. */
export function checkAllowed(src: number, dst: number, cmd: number, data: ArrayLike<number>, ctx: AllowContext): void {
  const len = data.length;
  const what = `${commandName(cmd)} (0x${cmd.toString(16)}) len ${len} to ${deviceName(dst)}`;
  const deny = (why: string): never => {
    throw new AuxForbiddenError(`${what}: ${why}`);
  };
  if (src !== AuxDevice.APP) deny('source must be 0x20');
  if (cmd >= 0x81 && cmd <= 0x84) deny('firmware programming command');

  const isMc = dst === AuxDevice.AZM || dst === AuxDevice.ALT;
  if (!isMc) {
    if (cmd === AuxCmd.GET_VER && len === 0 && (DISCOVERY_DEVICES as readonly number[]).includes(dst)) return;
    if (dst === BATTERY_DEVICE && cmd === BAT_GET_STATUS && len === 0) {
      if (!ctx.answered.has(BATTERY_DEVICE)) deny('battery device did not answer GET_VER');
      return;
    }
    deny('not on the allow-list');
  }

  if (cmd === AuxCmd.GET_VER && len === 0) return;
  if (!ctx.answered.has(dst)) deny('motor controller has not answered GET_VER');
  if (MC_READS.has(cmd) && len === 0) return;
  if (dst === AuxDevice.AZM && AZM_READS.has(cmd) && len === 0) return;

  switch (cmd) {
    case AuxCmd.MOVE_POS:
    case AuxCmd.MOVE_NEG:
      if (len !== 1) deny('needs 1 byte');
      if (data[0]! > 9) deny('rate must be 0..9');
      return;
    case AuxCmd.GOTO_FAST:
    case AuxCmd.GOTO_SLOW: {
      if (len !== 3) deny('needs 3 bytes');
      const pos = ctx.position(dst);
      if (pos === null) deny('current position unknown');
      const target = decodePosition(data, dst === AuxDevice.ALT);
      const dist = Math.abs(dst === AuxDevice.AZM ? wrap180(target - pos!) : target - pos!);
      if (cmd === AuxCmd.GOTO_SLOW && dist > MAX_SLOW_GOTO_DEG + 0.5) deny(`GOTO_SLOW ${dist.toFixed(1)}° away (max ${MAX_SLOW_GOTO_DEG}°)`);
      if (cmd === AuxCmd.GOTO_FAST && dst === AuxDevice.AZM && dist > MAX_AZ_LEG_DEG + 0.5) deny(`AZM leg ${dist.toFixed(1)}° (max ${MAX_AZ_LEG_DEG}°)`);
      return;
    }
    case AuxCmd.SET_POS_GUIDERATE:
    case AuxCmd.SET_NEG_GUIDERATE: {
      if (len !== 3) deny('3-byte form only (no 2-byte specials)');
      const v = readBe24(data);
      if (v > MAX_GUIDE_VALUE) deny('rate above 1°/s');
      // Astro Fi MC 7.13 runaway bug: never a tracking rate while a GOTO runs.
      if (v !== 0 && (ctx.gotoActive(AuxDevice.AZM) || ctx.gotoActive(AuxDevice.ALT))) deny('guide rate while a GOTO is active');
      return;
    }
    case AuxCmd.SET_POSITION:
      if (len !== 3) deny('needs 3 bytes');
      return;
    case AuxCmd.SET_CORDWRAP_POS:
      if (dst !== AuxDevice.AZM || len !== 3) deny('AZM, 3 bytes only');
      return;
    case AuxCmd.ENABLE_CORDWRAP:
      if (dst !== AuxDevice.AZM || len !== 0) deny('AZM, no payload only');
      return;
  }
  deny('not on the allow-list');
}
