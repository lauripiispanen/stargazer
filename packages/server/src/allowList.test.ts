import { describe, expect, it } from 'vitest';
import { AuxCmd, AuxDevice, encodePosition } from '@stargazer/shared/aux.ts';
import { type AllowContext, AuxForbiddenError, checkAllowed } from './allowList.ts';

const ctx = (over: Partial<AllowContext> = {}): AllowContext => ({
  answered: new Set([AuxDevice.AZM, AuxDevice.ALT]),
  gotoActive: () => false,
  position: () => 0,
  ...over,
});
const ok = (dst: number, cmd: number, data: number[] = [], c = ctx()) => checkAllowed(AuxDevice.APP, dst, cmd, data, c);
const refused = (dst: number, cmd: number, data: number[] = [], c = ctx()) =>
  expect(() => checkAllowed(AuxDevice.APP, dst, cmd, data, c)).toThrow(AuxForbiddenError);

describe('AUX allow-list (SAFETY.md §4.3)', () => {
  it('refuses firmware programming commands to every device', () => {
    for (let dst = 0; dst < 256; dst++) for (const cmd of [0x81, 0x82, 0x83, 0x84]) for (const len of [0, 1, 3]) refused(dst, cmd, Array(len).fill(0));
  });

  it('refuses persistent register writes and dangerous MC commands', () => {
    for (const dst of [AuxDevice.AZM, AuxDevice.ALT]) {
      for (const cmd of [AuxCmd.SET_POS_BACKLASH, AuxCmd.SET_NEG_BACKLASH, AuxCmd.SET_APPROACH, AuxCmd.SET_AUTOGUIDE_RATE, AuxCmd.ENABLE_MAXRATE])
        refused(dst, cmd, [0]);
      refused(dst, AuxCmd.SET_MAXRATE, [0x0d, 0xb8]);
      for (const cmd of [AuxCmd.LEVEL_START, AuxCmd.SEEK_INDEX, AuxCmd.GET_AUTOGUIDE_RATE, AuxCmd.AUX_GUIDE, 0x0c, 0x0d, 0x14, 0x15, 0x16]) refused(dst, cmd);
    }
  });

  it('allows reads, keyed on payload length', () => {
    ok(AuxDevice.AZM, AuxCmd.GET_POSITION);
    ok(AuxDevice.ALT, AuxCmd.GET_POS_BACKLASH);
    ok(AuxDevice.AZM, AuxCmd.POLL_CORDWRAP);
    refused(AuxDevice.ALT, AuxCmd.POLL_CORDWRAP);
    refused(AuxDevice.AZM, AuxCmd.GET_POSITION, [1]);
    refused(AuxDevice.AZM, AuxCmd.GET_POSITION, [], ctx({ answered: new Set() })); // MC not identified
  });

  it('only GET_VER to non-MC devices; battery status only after 0xB6 answered', () => {
    ok(0xb6, AuxCmd.GET_VER);
    refused(0xb6, 0x10);
    ok(0xb6, 0x10, [], ctx({ answered: new Set([0xb6]) }));
    refused(0xb6, 0x10, [1], ctx({ answered: new Set([0xb6]) })); // with payload = write
    refused(0xb6, 0x18);
    refused(AuxDevice.WIFI, 0x10);
    refused(AuxDevice.WIFI, 0x32, [1]);
    refused(0x00, AuxCmd.GET_VER);
    expect(() => checkAllowed(0x21, AuxDevice.AZM, AuxCmd.GET_VER, [], ctx())).toThrow(/source/);
  });

  it('value-checks motion commands', () => {
    ok(AuxDevice.AZM, AuxCmd.MOVE_POS, [9]);
    refused(AuxDevice.AZM, AuxCmd.MOVE_POS, [10]);
    ok(AuxDevice.AZM, AuxCmd.GOTO_FAST, encodePosition(170));
    refused(AuxDevice.AZM, AuxCmd.GOTO_FAST, encodePosition(175));
    ok(AuxDevice.ALT, AuxCmd.GOTO_FAST, encodePosition(60));
    refused(AuxDevice.ALT, AuxCmd.GOTO_SLOW, encodePosition(8));
    refused(AuxDevice.AZM, AuxCmd.GOTO_FAST, encodePosition(10), ctx({ position: () => null }));
    ok(AuxDevice.AZM, AuxCmd.SET_POS_GUIDERATE, [0x38, 0x40, 0x00]);
    refused(AuxDevice.AZM, AuxCmd.SET_POS_GUIDERATE, [0x38, 0x40, 0x01]);
    refused(AuxDevice.AZM, AuxCmd.SET_POS_GUIDERATE, [0xff, 0xff]); // 2-byte specials
    const busy = ctx({ gotoActive: (d) => d === AuxDevice.ALT });
    refused(AuxDevice.AZM, AuxCmd.SET_NEG_GUIDERATE, [0, 0x3c, 0x2a], busy);
    ok(AuxDevice.AZM, AuxCmd.SET_NEG_GUIDERATE, [0, 0, 0], busy);
  });
});
