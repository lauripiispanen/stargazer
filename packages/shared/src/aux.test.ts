import { describe, expect, it } from 'vitest';
import {
  AuxCmd,
  AuxDevice,
  AuxFrameParser,
  decodeGuideRate,
  decodePacket,
  decodePosition,
  degToSteps,
  encodeGuideRate,
  encodePacket,
  encodePosition,
  formatVersion,
  fromHex,
  stepsToDegAlt,
  stepsToDegAz,
  toHex,
} from './aux.ts';

const { APP, AZM, ALT } = AuxDevice;
const enc = (src: number, dst: number, cmd: number, data: number[] = []) => toHex(encodePacket({ src, dst, cmd, data }));

describe('AUX packet encoding (PROTOCOL.md §4.1 examples)', () => {
  it.each([
    ['GET_VER AZM', enc(APP, AZM, AuxCmd.GET_VER), '3b 03 20 10 fe cf'],
    ['GET_POSITION AZM', enc(APP, AZM, AuxCmd.GET_POSITION), '3b 03 20 10 01 cc'],
    ['GET_POSITION ALT', enc(APP, ALT, AuxCmd.GET_POSITION), '3b 03 20 11 01 cb'],
    ['GOTO_FAST AZM 90°', enc(APP, AZM, AuxCmd.GOTO_FAST, encodePosition(90)), '3b 06 20 10 02 40 00 00 88'],
    ['GOTO_FAST ALT -1°', enc(APP, ALT, AuxCmd.GOTO_FAST, encodePosition(-1)), '3b 06 20 11 02 ff 49 f5 8a'],
    ['GOTO_SLOW AZM 90°', enc(APP, AZM, AuxCmd.GOTO_SLOW, encodePosition(90)), '3b 06 20 10 17 40 00 00 73'],
    ['SLEW_DONE AZM', enc(APP, AZM, AuxCmd.SLEW_DONE), '3b 03 20 10 13 ba'],
    ['MOVE_POS ALT 9', enc(APP, ALT, AuxCmd.MOVE_POS, [9]), '3b 04 20 11 24 09 9e'],
    ['MOVE_POS ALT stop', enc(APP, ALT, AuxCmd.MOVE_POS, [0]), '3b 04 20 11 24 00 a7'],
    ['MOVE_NEG AZM 5', enc(APP, AZM, AuxCmd.MOVE_NEG, [5]), '3b 04 20 10 25 05 a2'],
    ['SET_POSITION AZM 0', enc(APP, AZM, AuxCmd.SET_POSITION, encodePosition(0)), '3b 06 20 10 04 00 00 00 c6'],
    ['SET_POSITION ALT 0', enc(APP, ALT, AuxCmd.SET_POSITION, encodePosition(0)), '3b 06 20 11 04 00 00 00 c5'],
    ['SET_CORDWRAP_POS 180°', enc(APP, AZM, AuxCmd.SET_CORDWRAP_POS, [0x7f, 0xff, 0xff]), '3b 06 20 10 3a 7f ff ff 13'],
    ['ENABLE_CORDWRAP', enc(APP, AZM, AuxCmd.ENABLE_CORDWRAP), '3b 03 20 10 38 95'],
    ['MOVE_POS ack', enc(AZM, APP, AuxCmd.MOVE_POS), '3b 03 10 20 24 a9'],
    ['GOTO_FAST ack', enc(AZM, APP, AuxCmd.GOTO_FAST), '3b 03 10 20 02 cb'],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('guide-rate examples', () => {
    const sid = encodeGuideRate(15.041);
    expect(sid.value).toBe(15402);
    expect(enc(APP, AZM, sid.cmd, sid.data)).toBe('3b 06 20 10 06 00 3c 2a 5e');
    const neg = encodeGuideRate(-15.041);
    expect(enc(APP, ALT, neg.cmd, neg.data)).toBe('3b 06 20 11 07 00 3c 2a 5c');
    const zero = encodeGuideRate(0);
    expect(enc(APP, AZM, zero.cmd, zero.data)).toBe('3b 06 20 10 06 00 00 00 c4');
    expect(decodeGuideRate(fromHex('00 2e 4f'))).toBeCloseTo(11.577, 3);
    expect(decodeGuideRate(fromHex('ff ff'))).toBeCloseTo(15.041);
    expect(encodeGuideRate(15.041, 512).value).toBe(7701);
    expect(encodeGuideRate(1e9).value).toBe(0xffffff);
  });
});

describe('AUX packet decoding', () => {
  it('decodes responses', () => {
    const ver = decodePacket(fromHex('3b 07 10 20 fe 07 0a 10 0d 9d'))!;
    expect(ver).toMatchObject({ src: AZM, dst: APP, cmd: AuxCmd.GET_VER });
    expect(formatVersion(ver.data)).toBe('7.10.4109');

    const az = decodePacket(fromHex('3b 06 10 20 01 00 c0 1a ef'))!;
    expect(decodePosition(az.data, false)).toBeCloseTo(1.0553, 3);
    const alt = decodePacket(fromHex('3b 06 11 20 01 ff ff ac 1e'))!;
    expect(decodePosition(alt.data, true)).toBeCloseTo((-84 * 360) / 2 ** 24, 9);

    expect(decodePacket(fromHex('3b 04 10 20 13 00 b9'))!.data[0]).toBe(0x00);
    expect(decodePacket(fromHex('3b 04 10 20 13 ff ba'))!.data[0]).toBe(0xff);
  });

  it('rejects bad checksum and bad framing', () => {
    expect(decodePacket(fromHex('3b 03 20 10 fe ce'))).toBeNull();
    expect(decodePacket(fromHex('3a 03 20 10 fe cf'))).toBeNull();
    expect(decodePacket(fromHex('3b 04 20 10 fe cf'))).toBeNull();
  });

  it('tolerates the GET_AUTOGUIDE_RATE quirk packet', () => {
    const p = decodePacket(fromHex('3b 04 10 20 f0 47 95'))!;
    expect(p.cmd).toBe(AuxCmd.QUIRK_F0);
    expect(p.data[0]).toBe(AuxCmd.GET_AUTOGUIDE_RATE);
  });
});

describe('AuxFrameParser', () => {
  it('splits coalesced echo + response (capture example)', () => {
    const p = new AuxFrameParser();
    const frames = p.push(fromHex('3b 03 20 10 fe cf 3b 07 10 20 fe 07 0a 10 0d 9d'));
    expect(frames.map((f) => toHex(f.raw))).toEqual(['3b 03 20 10 fe cf', '3b 07 10 20 fe 07 0a 10 0d 9d']);
  });

  it('handles fragmentation at every byte boundary', () => {
    const stream = fromHex('3b 06 10 20 01 00 c0 1a ef 3b 04 10 20 13 ff ba');
    const p = new AuxFrameParser();
    const frames = [];
    for (const b of stream) frames.push(...p.push([b]));
    expect(frames).toHaveLength(2);
    expect(frames[1]!.cmd).toBe(AuxCmd.SLEW_DONE);
  });

  it('skips ASCII banners and resyncs after garbage / bad checksums', () => {
    const p = new AuxFrameParser();
    const garbage = new TextEncoder().encode('*HELLO*CMD\r\n');
    const bad = fromHex('3b 03 20 10 fe 00'); // bad checksum
    const fake = fromHex('3b 3b 3b ff'); // stray preambles
    const good = fromHex('3b 03 20 10 fe cf');
    const all = new Uint8Array([...garbage, ...bad, ...fake, ...good]);
    const frames = p.push(all.subarray(0, 10));
    frames.push(...p.push(all.subarray(10)));
    expect(frames.map((f) => toHex(f.raw))).toEqual(['3b 03 20 10 fe cf']);
    expect(p.discarded).toBeGreaterThan(0);
  });

  it('finds a valid packet hidden after a stray 0x3B', () => {
    const p = new AuxFrameParser();
    const frames = p.push(fromHex('3b 3b 03 20 10 fe cf'));
    expect(frames).toHaveLength(1);
  });
});

describe('position helpers', () => {
  it('converts degrees and steps', () => {
    expect(degToSteps(90)).toBe(0x400000);
    expect(degToSteps(360)).toBe(0);
    expect(degToSteps(-1)).toBe(0xff49f5);
    expect(stepsToDegAz(0xff49f5)).toBeCloseTo(359, 4);
    expect(stepsToDegAlt(0xff49f5)).toBeCloseTo(-1, 4);
    expect(stepsToDegAlt(0x7fffff)).toBeCloseTo(180, 4);
    expect(decodePosition([0x40, 0x00], false)).toBeCloseTo(90);
  });
});
