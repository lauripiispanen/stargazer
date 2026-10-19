import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AuxCmd, AuxDevice, decodePosition, encodePacket, encodePosition, formatVersion } from '@stargazer/shared/aux.ts';
import { type RunningSimulator, startSimulator } from '../../simulator/src/server.ts';
import { AuxClient, AuxDisconnectedError, AuxForbiddenError, AuxTimeoutError } from './auxClient.ts';

const { AZM, ALT, WIFI, GPS } = AuxDevice;

describe.each([
  { echo: true, coalesce: true },
  { echo: false, coalesce: true },
  { echo: true, coalesce: false },
])('AuxClient against simulator (echo=$echo, coalesce=$coalesce)', ({ echo, coalesce }) => {
  let sim: RunningSimulator;
  let client: AuxClient;

  afterEach(async () => {
    client?.close();
    await sim?.close();
  });

  const setup = async () => {
    sim = await startSimulator({ auxPort: 0, http: false, echo, coalesce, latencyMs: 3, jitterMs: 2, log: () => {} });
    client = await AuxClient.connect({ host: '127.0.0.1', port: sim.auxPort, timeoutMs: 200, retries: 1 });
  };

  it('gets versions and positions', async () => {
    await setup();
    expect(formatVersion(await client.request(AZM, AuxCmd.GET_VER))).toBe('7.15.8160');
    expect(formatVersion(await client.request(WIFI, AuxCmd.GET_VER))).toBe('2.40.0');
    await expect(client.request(ALT, AuxCmd.GET_POSITION)).rejects.toBeInstanceOf(AuxForbiddenError); // ALT not identified yet
    await client.request(ALT, AuxCmd.GET_VER);
    await client.request(ALT, AuxCmd.SET_POSITION, encodePosition(-1.5));
    expect(decodePosition(await client.request(ALT, AuxCmd.GET_POSITION), true)).toBeCloseTo(-1.5, 4);
  });

  it('serializes concurrent requests and matches responses', async () => {
    await setup();
    const devs = Array.from({ length: 20 }, (_, i) => (i % 2 ? WIFI : AZM));
    const results = await Promise.all(devs.map((d) => client.request(d, AuxCmd.GET_VER)));
    results.forEach((r, i) => expect(formatVersion(r)).toBe(devs[i] === AZM ? '7.15.8160' : '2.40.0'));
  });

  it('times out on an absent device without breaking the queue', async () => {
    await setup();
    const t0 = Date.now();
    await expect(client.request(GPS, AuxCmd.GET_VER)).rejects.toBeInstanceOf(AuxTimeoutError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380); // 1 retry × 200 ms
    await client.request(AZM, AuxCmd.GET_VER);
    expect((await client.request(AZM, AuxCmd.SLEW_DONE))[0]).toBe(0xff);
    expect(client.stats.timeouts).toBe(1);
  });

  it('refuses commands outside the allow-list and guide rates during a GOTO', async () => {
    await setup();
    await client.request(AZM, AuxCmd.GET_VER);
    await expect(client.request(AZM, AuxCmd.GET_AUTOGUIDE_RATE)).rejects.toBeInstanceOf(AuxForbiddenError);
    await client.request(AZM, AuxCmd.GET_POSITION);
    await client.request(AZM, AuxCmd.GOTO_FAST, encodePosition(20));
    await expect(client.request(AZM, AuxCmd.SET_POS_GUIDERATE, [0, 0x3c, 0x2a])).rejects.toThrow(/GOTO is active/);
    await client.request(AZM, AuxCmd.SET_POS_GUIDERATE, [0, 0, 0]); // zero (stop) is always allowed
    await client.request(AZM, AuxCmd.MOVE_POS, [0]);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await client.request(AZM, AuxCmd.SLEW_DONE))[0]).toBe(0xff);
    await client.request(AZM, AuxCmd.SET_POS_GUIDERATE, [0, 0x3c, 0x2a]);
  });

  it('emits disconnect and rejects pending requests when the link drops', async () => {
    await setup();
    const down = new Promise<string>((r) => client.once('disconnect', r));
    sim.sim.updateConfig({ latencyMs: 200 });
    const pending = client.request(WIFI, AuxCmd.GET_VER);
    setTimeout(() => sim.dropClients(), 20);
    await expect(pending).rejects.toBeInstanceOf(AuxDisconnectedError);
    await down;
    expect(client.connected).toBe(false);
    await expect(client.request(WIFI, AuxCmd.GET_VER)).rejects.toBeInstanceOf(AuxDisconnectedError);
  });
});

describe('AuxClient with a hostile byte stream', () => {
  let server: net.Server;
  let client: AuxClient;
  afterEach(async () => {
    client?.close();
    await new Promise((r) => server.close(r));
  });

  it('ignores banners, echoes, foreign traffic and mismatched responses', async () => {
    server = net.createServer((sock) => {
      sock.write('*HELLO*');
      sock.on('data', (req) => {
        const resp = encodePacket({ src: AZM, dst: 0x20, cmd: req[4]!, data: [0x40, 0, 0] });
        sock.write(
          Buffer.concat([
            Buffer.from(req), // echo
            Buffer.from(encodePacket({ src: 0x0d, dst: AZM, cmd: AuxCmd.GET_POSITION })), // HC traffic
            Buffer.from(encodePacket({ src: ALT, dst: 0x20, cmd: AuxCmd.GET_POSITION, data: [1, 2, 3] })), // wrong device
            Buffer.from(encodePacket({ src: AZM, dst: 0x20, cmd: AuxCmd.SLEW_DONE, data: [0] })), // wrong command
            Buffer.from([0x3b, 0x03, 0x10, 0x20, 0x01, 0x00]), // bad checksum
            Buffer.from(resp.subarray(0, 4)),
          ]),
        );
        setTimeout(() => sock.write(resp.subarray(4)), 10);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    client = await AuxClient.connect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, timeoutMs: 300 });
    const seen: number[] = [];
    client.on('packet', (f) => seen.push(f.src));
    await client.request(AZM, AuxCmd.GET_VER);
    const data = await client.request(AZM, AuxCmd.GET_POSITION);
    expect(decodePosition(data, false)).toBeCloseTo(90);
    expect(seen).toContain(0x0d);
  });
});
