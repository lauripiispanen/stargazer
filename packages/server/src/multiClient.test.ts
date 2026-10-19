// Several GUI clients on one server (laptop + phone remote): per-client manual-move ownership, dead-man and
// disconnect handling, the shared observing list, the client count and LAN info.
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Axis, ClientMessage, MountState, ObservingListEntry, ServerMessage } from '@stargazer/shared/api.ts';
import { type RunningSimulator, startSimulator } from '../../simulator/src/server.ts';
import { buildApp, lanAddresses, serverNetwork } from './app.ts';
import { loadConfig, type ServerConfig } from './config.ts';
import { Mount } from './mount.ts';
import { StateStore } from './persist.ts';
import { fakeAstro, sleep, TEST_LOCATION, waitFor } from './testing.ts';

let sim: RunningSimulator | undefined;
let app: FastifyInstance | undefined;
let mount: Mount | undefined;
let sockets: Client[] = [];

afterEach(async () => {
  for (const c of sockets) c.close();
  sockets = [];
  await mount?.dispose();
  await app?.close();
  await sim?.close();
  sim = app = mount = undefined;
});

class Client {
  inbox: ServerMessage[] = [];
  state: MountState | null = null;
  list: ObservingListEntry[] | null = null;
  errors: string[] = [];
  private beats = new Map<Axis, NodeJS.Timeout>();
  constructor(readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      this.inbox.push(m);
      if (m.type === 'state') this.state = m.state;
      if (m.type === 'list') this.list = m.entries;
      if (m.type === 'error') this.errors.push(m.message);
    };
  }
  send(m: ClientMessage) {
    this.ws.send(JSON.stringify(m));
  }
  /** Start a press-and-hold move with 150 ms heartbeats (like the GUI's slew controller). */
  hold(axis: Axis, direction: 1 | -1, rate: number) {
    this.release(axis, false);
    const m: ClientMessage = { type: 'move', axis, direction, rate };
    this.send(m);
    this.beats.set(axis, setInterval(() => this.send(m), 150));
  }
  release(axis: Axis, sendStop = true) {
    clearInterval(this.beats.get(axis));
    this.beats.delete(axis);
    if (sendStop) this.send({ type: 'stopAxis', axis });
  }
  /** Stop heartbeats without telling the server (a frozen tab). */
  freeze() {
    for (const t of this.beats.values()) clearInterval(t);
    this.beats.clear();
  }
  close() {
    this.freeze();
    this.ws.close();
  }
}

async function setup(cfg: Partial<ServerConfig> = {}, store: StateStore | null = null) {
  sim = await startSimulator({ auxPort: 0, http: false, latencyMs: 2, jitterMs: 0, log: () => {} });
  const config = loadConfig(
    {},
    { telescopeHost: '127.0.0.1', telescopePort: sim.auxPort, stateFile: null, packetLogFile: null, discoveryTimeoutMs: 20, webDist: '/nonexistent', serverPort: 0, pollIntervalMs: 100, ...cfg },
  );
  mount = new Mount({ config, astro: fakeAstro(), store, consoleLog: false });
  app = await buildApp(config, mount, { lanAddresses: () => ['192.168.1.20'] });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return (app.server.address() as AddressInfo).port;
}

async function client(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const c = new Client(ws);
  sockets.push(c);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  await waitFor(() => !!c.state && !!c.list);
  return c;
}

const simVel = (axis: Axis) => Math.abs(sim!.sim[axis].velocity);

async function connectMount(c: Client) {
  c.send({ type: 'connect' });
  c.send({ type: 'setLocation', location: TEST_LOCATION });
  await waitFor(() => c.state?.connection === 'connected');
  c.send({ type: 'alignHome' });
  await waitFor(() => c.state?.alignment.quality === 'rough');
}

describe('multiple clients', () => {
  it('reports the number of connected clients', async () => {
    const port = await setup();
    const a = await client(port);
    await waitFor(() => a.state?.clients === 1);
    const b = await client(port);
    await waitFor(() => a.state?.clients === 2 && b.state?.clients === 2);
    b.close();
    await waitFor(() => a.state?.clients === 1);
  });

  it('a disconnecting client stops only the axes it is moving', async () => {
    const port = await setup();
    const laptop = await client(port);
    const phone = await client(port);
    await connectMount(laptop);

    laptop.hold('alt', 1, 6);
    phone.hold('az', 1, 6);
    await waitFor(() => simVel('alt') > 0.1 && simVel('az') > 0.1, 3000);
    const owners = mount!.manualOwners();
    expect(owners.alt).not.toBeNull();
    expect(owners.az).not.toBeNull();
    expect(owners.alt).not.toBe(owners.az);

    phone.close(); // WS close without a stopAxis: like a phone that walked out of WiFi range
    await waitFor(() => simVel('az') < 0.01, 2000);
    await sleep(700); // well past the dead-man window: the laptop's heartbeats keep alt going
    expect(simVel('alt')).toBeGreaterThan(0.1);
    expect(mount!.getState().slew).toBe('manual');

    laptop.release('alt');
    await waitFor(() => simVel('alt') < 0.01 && mount!.getState().slew === 'idle', 2000);
  });

  it('the dead-man is per axis: a frozen client stops only its own move', async () => {
    const port = await setup();
    const laptop = await client(port);
    const phone = await client(port);
    await connectMount(laptop);
    laptop.hold('alt', 1, 6);
    phone.hold('az', -1, 6);
    await waitFor(() => simVel('alt') > 0.1 && simVel('az') > 0.1, 3000);
    phone.freeze(); // socket stays open but heartbeats stop
    await waitFor(() => simVel('az') < 0.01, 2500);
    expect(simVel('alt')).toBeGreaterThan(0.1);
    laptop.release('alt');
  });

  it('the latest mover owns an axis; a stale release does not stop it; STOP from anyone stops all', async () => {
    const port = await setup();
    const laptop = await client(port);
    const phone = await client(port);
    await connectMount(laptop);

    laptop.hold('az', 1, 5);
    await waitFor(() => simVel('az') > 0.05, 3000);
    const laptopId = mount!.manualOwners().az;
    // The phone takes over the same axis (opposite direction)
    laptop.freeze();
    phone.hold('az', -1, 5);
    await waitFor(() => mount!.manualOwners().az !== laptopId && mount!.manualOwners().az !== null, 3000);
    // The laptop's late key-up must not stop the phone's move
    laptop.send({ type: 'stopAxis', axis: 'az' });
    await sleep(400);
    expect(mount!.getState().slew).toBe('manual');
    // ... nor does the laptop disconnecting
    laptop.close();
    await sleep(800);
    expect(mount!.manualOwners().az).not.toBeNull();
    await waitFor(() => (sim!.sim.az.velocity ?? 0) < -0.05, 3000);

    // STOP from a third client stops everything
    const tablet = await client(port);
    phone.hold('alt', 1, 5);
    await waitFor(() => simVel('alt') > 0.05, 3000);
    tablet.send({ type: 'stop' });
    await waitFor(() => mount!.getState().slew === 'idle' && simVel('az') < 0.01 && simVel('alt') < 0.01, 3000);
    phone.freeze();
  });

  it('shares the observing list with every client and persists it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-list-'));
    const store = new StateStore(path.join(dir, 'state.json'));
    const port = await setup({}, store);
    const laptop = await client(port);
    const phone = await client(port);
    expect(phone.list).toEqual([]);

    phone.send({ type: 'listAdd', target: { kind: 'radec', ra: 10.68, dec: 41.27, name: 'Andromeda Galaxy', id: 'M31' } });
    phone.send({ type: 'listAdd', target: { kind: 'body', body: 'Jupiter', name: 'Jupiter' }, note: 'GRS transit 22:10' });
    await waitFor(() => laptop.list?.length === 2);
    expect(laptop.list![1]).toMatchObject({ name: 'Jupiter', note: 'GRS transit 22:10', observedAt: null });

    const [m31, jup] = laptop.list!;
    laptop.send({ type: 'listMove', id: jup!.id, index: 0 });
    laptop.send({ type: 'listMarkObserved', id: m31!.id, note: 'core only, hazy' });
    await waitFor(() => phone.list?.[0]?.id === jup!.id && phone.list?.[1]?.observedAt != null);
    expect(phone.list![1]!.note).toBe('core only, hazy');

    // duplicates and unknown ids are refused with an error to the sender only
    phone.send({ type: 'listAdd', target: { kind: 'body', body: 'Jupiter', name: 'Jupiter' } });
    await waitFor(() => phone.errors.some((e) => /already/.test(e)));
    expect(laptop.errors).toEqual([]);
    phone.send({ type: 'listRemove', id: 'nope' });
    await waitFor(() => phone.errors.some((e) => /no longer/.test(e)));
    // malformed
    phone.ws.send(JSON.stringify({ type: 'listAdd', target: { kind: 'radec', name: 'x' } }));
    await waitFor(() => phone.errors.some((e) => /invalid target/.test(e)));

    laptop.send({ type: 'listRemove', id: jup!.id });
    await waitFor(() => phone.list?.length === 1);

    // persisted alongside the rest of the state, and restored by a new Mount
    const saved = store.load()!;
    expect(saved.observingList).toHaveLength(1);
    expect(saved.observingList![0]).toMatchObject({ name: 'Andromeda Galaxy', note: 'core only, hazy' });
    const config = loadConfig({}, { stateFile: null, packetLogFile: null });
    const m2 = new Mount({ config, astro: fakeAstro(), store, consoleLog: false });
    expect(m2.getObservingList().map((e) => e.name)).toEqual(['Andromeda Galaxy']);
    await m2.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports how to reach the server', async () => {
    const port = await setup();
    const c = await client(port);
    // bound to loopback in tests: no LAN URLs
    expect(c.state?.network).toEqual({ bind: '127.0.0.1', port, lanUrls: [] });
  });
});

describe('LAN info', () => {
  it('lists LAN URLs only when bound to all interfaces', () => {
    expect(serverNetwork('0.0.0.0', 8080, () => ['192.168.4.2', '10.0.0.5'])).toEqual({
      bind: '0.0.0.0',
      port: 8080,
      lanUrls: ['http://192.168.4.2:8080/', 'http://10.0.0.5:8080/'],
    });
    expect(serverNetwork('::', 8080, () => ['192.168.4.2']).lanUrls).toEqual(['http://192.168.4.2:8080/']);
    expect(serverNetwork('127.0.0.1', 8080, () => ['192.168.4.2']).lanUrls).toEqual([]);
    expect(serverNetwork('192.168.4.2', 8080).lanUrls).toEqual(['http://192.168.4.2:8080/']);
  });

  it('picks non-internal IPv4 addresses', () => {
    const iface = (address: string, family: string, internal: boolean) => ({ address, family, internal, netmask: '', mac: '', cidr: null }) as os.NetworkInterfaceInfo;
    expect(
      lanAddresses({
        lo0: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
        en0: [iface('fe80::1', 'IPv6', false), iface('192.168.4.3', 'IPv4', false)],
        en5: [iface('169.254.10.1', 'IPv4', false)],
      }),
    ).toEqual(['192.168.4.3']);
  });
});
