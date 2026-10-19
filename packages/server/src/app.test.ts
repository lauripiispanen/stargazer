import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClientMessage, ServerMessage } from '@stargazer/shared/api.ts';
import { type RunningSimulator, startSimulator } from '../../simulator/src/server.ts';
import { buildApp, missingDataFiles, parseClientMessage } from './app.ts';
import { loadConfig } from './config.ts';
import { Mount } from './mount.ts';
import { fakeAstro, TEST_LOCATION } from './testing.ts';

describe('WebSocket /ws smoke test', () => {
  let sim: RunningSimulator;
  let mount: Mount;
  let app: FastifyInstance;
  let ws: WebSocket;
  const inbox: ServerMessage[] = [];

  beforeAll(async () => {
    sim = await startSimulator({ auxPort: 0, http: false, latencyMs: 2, jitterMs: 0, log: () => {} });
    const config = loadConfig({}, { telescopeHost: '127.0.0.1', telescopePort: sim.auxPort, stateFile: null, packetLogFile: null, discoveryTimeoutMs: 20, webDist: '/nonexistent', serverPort: 0 });
    mount = new Mount({ config, astro: fakeAstro(), consoleLog: false });
    app = await buildApp(config, mount);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)) as ServerMessage);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
  });

  afterAll(async () => {
    ws?.close();
    await mount?.dispose();
    await app?.close();
    await sim?.close();
  });

  const send = (m: ClientMessage | Record<string, unknown>) => ws.send(JSON.stringify(m));
  const next = async (pred: (m: ServerMessage) => boolean, timeoutMs = 3000): Promise<ServerMessage> => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(0, i + 1).pop()!;
      if (Date.now() > end) throw new Error(`timed out waiting for ${pred.toString()}; last: ${JSON.stringify(inbox.at(-1))?.slice(0, 600)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const state = (pred: (s: Extract<ServerMessage, { type: 'state' }>['state']) => boolean) =>
    next((m) => m.type === 'state' && pred(m.state)) as Promise<Extract<ServerMessage, { type: 'state' }>>;

  it('sends state on connect, then drives the mount', async () => {
    const first = await state(() => true);
    expect(first.state.connection).toBe('disconnected');

    send({ type: 'connect' });
    const connected = await state((s) => s.connection === 'connected');
    expect(connected.state.firmware?.az).toBe('7.15.8160');

    send({ type: 'setLocation', location: TEST_LOCATION });
    send({ type: 'alignHome' });
    await state((s) => s.alignment.quality === 'rough' && s.location?.lat === 60);

    send({ type: 'move', axis: 'alt', direction: 1, rate: 7 });
    await state((s) => s.slew === 'manual');
    send({ type: 'stopAxis', axis: 'alt' });
    await state((s) => s.slew === 'idle' && (s.encoder?.alt ?? 0) > 0);

    send({ type: 'goto', target: { kind: 'radec', ra: 10, dec: -3, name: 'Low' } });
    const confirm = await next((m) => m.type === 'confirm');
    expect(confirm).toMatchObject({ type: 'confirm', request: { type: 'goto' } });

    send({ type: 'move', axis: 'up', direction: 1, rate: 3 } as unknown as ClientMessage);
    expect(await next((m) => m.type === 'error')).toMatchObject({ type: 'error', message: expect.stringMatching(/axis/) });

    send({ type: 'alignRemovePoint', id: 999 });
    expect(await next((m) => m.type === 'error')).toMatchObject({ requestType: 'alignRemovePoint' });

    send({ type: 'stop' });
    send({ type: 'disconnect' });
    await state((s) => s.connection === 'disconnected');
  });

  it('serves a helpful page when the UI is not built', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/not been built/);
    const spa = await app.inject({ method: 'GET', url: '/some/route' });
    expect(spa.body).toMatch(/not been built/);
  });
});

describe('missing catalog data', () => {
  it('explains how to get the data', async () => {
    const config = loadConfig({}, { stateFile: null, packetLogFile: null, webDist: '/nonexistent', dataDir: '/nonexistent-data' });
    const mount = new Mount({ config, astro: fakeAstro(), consoleLog: false });
    const app = await buildApp(config, mount);
    try {
      expect(missingDataFiles(config.dataDir)).toContain('stars.json');
      const res = await app.inject({ method: 'GET', url: '/data/stars.json' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/npm run setup.*while online/);
    } finally {
      await mount.dispose();
      await app.close();
    }
  });
});

describe('parseClientMessage', () => {
  it('validates shapes', () => {
    expect(parseClientMessage('{"type":"stop"}')).toEqual({ type: 'stop' });
    expect(() => parseClientMessage('nope')).toThrow(/JSON/);
    expect(() => parseClientMessage('{"type":"goto","target":{"kind":"radec","ra":1,"name":"x"}}')).toThrow(/target/);
    expect(() => parseClientMessage('{"type":"fly"}')).toThrow(/unknown/);
  });
});
