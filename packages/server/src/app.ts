// Fastify app: static web UI + /data, and the WebSocket /ws implementing the api.ts contract.
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ClientMessage, MountState, ObservingListEntry, ServerMessage, ServerNetwork } from '@stargazer/shared/api.ts';
import { isListMessage, isValidTarget, LIST_NOTE_MAX } from '@stargazer/shared/observingList.ts';
import type { ServerConfig } from './config.ts';
import type { LogEntry, Mount } from './mount.ts';

/** The bits of a `ws` WebSocket we use (no @types/ws in the repo). */
interface WsLike {
  readyState: number;
  send(data: string): void;
  on(event: 'message', cb: (data: Buffer | string) => void): void;
  on(event: 'close', cb: () => void): void;
}
const WS_OPEN = 1;

const MISSING_UI_HTML = (dist: string) => `<!doctype html><meta charset="utf-8"><title>Stargazer</title>
<body style="font-family:system-ui;background:#111;color:#ddd;padding:2em;line-height:1.5">
<h1>Stargazer server is running</h1>
<p>The web UI has not been built (no <code>${dist}</code>).</p>
<ul><li>Production: <code>npm run build && npm start</code>, then open http://localhost:8080</li>
<li>Development: <code>npm run dev</code> and open the Vite URL (it proxies <code>/ws</code> and <code>/data</code> here)</li></ul>
<p>WebSocket endpoint: <code>/ws</code></p></body>`;

const AXES = new Set(['az', 'alt']);

/** Catalog files the GUI cannot work without (ARCHITECTURE.md "Offline data"). */
export const REQUIRED_DATA = ['stars.json', 'star-names.json', 'dso.json', 'constellations.json'];
export const MISSING_DATA_HINT = 'run `npm run setup` while online';

/** Required catalog files missing from dataDir (empty when all present). */
export function missingDataFiles(dataDir: string): string[] {
  return REQUIRED_DATA.filter((f) => !fs.existsSync(path.join(dataDir, f)));
}

/** Light structural validation of an incoming message. Throws with a helpful message. */
export function parseClientMessage(raw: string): ClientMessage {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON');
  }
  if (!m || typeof m !== 'object' || typeof (m as { type?: unknown }).type !== 'string') throw new Error('message needs a "type"');
  const msg = m as Record<string, unknown> & { type: string };
  const need = (cond: boolean, what: string) => {
    if (!cond) throw new Error(`${msg.type}: ${what}`);
  };
  const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const isTarget = isValidTarget;
  const isId = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 100;
  const isNote = (v: unknown) => v === undefined || (typeof v === 'string' && v.length <= LIST_NOTE_MAX * 2);
  switch (msg.type) {
    case 'connect':
      need(msg.host === undefined || typeof msg.host === 'string', 'host must be a string');
      need(msg.port === undefined || isNum(msg.port), 'port must be a number');
      break;
    case 'move':
      need(AXES.has(msg.axis as string), 'axis must be az|alt');
      need(msg.direction === 1 || msg.direction === -1, 'direction must be 1|-1');
      need(isNum(msg.rate), 'rate must be a number');
      break;
    case 'stopAxis':
      need(AXES.has(msg.axis as string), 'axis must be az|alt');
      break;
    case 'goto':
    case 'alignAddPoint':
    case 'sync':
      need(isTarget(msg.target), 'invalid target');
      break;
    case 'setTracking':
      need(typeof msg.enabled === 'boolean', 'enabled must be boolean');
      break;
    case 'setLocation': {
      const l = msg.location as Record<string, unknown> | undefined;
      need(!!l && isNum(l.lat) && isNum(l.lon), 'location needs lat/lon');
      if (l && !isNum(l.elevation)) l.elevation = 0;
      break;
    }
    case 'alignHome': {
      need((msg.azDeg === undefined || isNum(msg.azDeg)) && (msg.altDeg === undefined || isNum(msg.altDeg)), 'azDeg/altDeg must be numbers');
      need(msg.source === undefined || msg.source === 'manual' || msg.source === 'sensors', 'source must be manual|sensors');
      const u = msg.uncertainty as Record<string, unknown> | undefined;
      const sigma = (v: unknown) => isNum(v) && (v as number) >= 0 && (v as number) <= 180;
      need(u === undefined || (!!u && typeof u === 'object' && sigma(u.azSigmaDeg) && sigma(u.altSigmaDeg)), 'uncertainty needs azSigmaDeg/altSigmaDeg (0..180)');
      need((msg.magHeadingDeg === undefined || isNum(msg.magHeadingDeg)) && (msg.declinationDeg === undefined || isNum(msg.declinationDeg)), 'magHeadingDeg/declinationDeg must be numbers');
      if (msg.source === 'sensors') need(isNum(msg.azDeg) && isNum(msg.altDeg), 'sensor Home needs azDeg and altDeg');
      break;
    }
    case 'alignRemovePoint':
      need(isNum(msg.id), 'id must be a number');
      break;
    case 'listAdd':
      need(isTarget(msg.target), 'invalid target');
      need(isNote(msg.note), 'note must be a short string');
      break;
    case 'listRemove':
      need(isId(msg.id), 'id must be a string');
      break;
    case 'listMove':
      need(isId(msg.id), 'id must be a string');
      need(isNum(msg.index), 'index must be a number');
      break;
    case 'listMarkObserved':
      need(isId(msg.id), 'id must be a string');
      need(msg.observed === undefined || typeof msg.observed === 'boolean', 'observed must be boolean');
      need(isNote(msg.note), 'note must be a short string');
      break;
    case 'disconnect':
    case 'stop':
    case 'alignClear':
      break;
    default:
      throw new Error(`unknown message type "${msg.type}"`);
  }
  return msg as unknown as ClientMessage;
}

/** Non-internal IPv4 addresses of this machine (where a phone on the same WiFi can reach the server). */
export function lanAddresses(ifaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      // Node 18.0-18.3 reported family as a number
      const v4 = a.family === 'IPv4' || (a.family as unknown) === 4;
      if (v4 && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

/** How other devices can reach a server bound to `bind`:`port` (https: served with TLS). */
export function serverNetwork(bind: string, port: number, addrs: () => string[] = lanAddresses, https = false): ServerNetwork {
  const all = bind === '0.0.0.0' || bind === '::' || bind === '';
  const ips = all ? addrs() : bind.startsWith('127.') || bind === '::1' || bind === 'localhost' ? [] : [bind];
  const scheme = https ? 'https' : 'http';
  return { bind: all ? '0.0.0.0' : bind, port, lanUrls: ips.map((ip) => `${scheme}://${ip}:${port}/`), ...(https ? { https: true } : {}) };
}

/** Path where the local CA certificate is served in HTTPS mode (a phone may install it to skip the warning). */
export const CA_CERT_PATH = '/stargazer-ca.crt';

/** TLS material for HTTPS mode. main.ts may replace key/cert/fingerprint in place after re-issuing (new LAN IP). */
export interface AppTls {
  key: Buffer;
  cert: Buffer;
  ca: Buffer | null;
  fingerprint256: string;
}

export interface AppOptions {
  logger?: boolean;
  /** Override LAN address discovery (tests). */
  lanAddresses?: () => string[];
  /** Serve HTTPS + WSS with this certificate instead of plain HTTP. */
  https?: AppTls;
}

export async function buildApp(config: ServerConfig, mount: Mount, opts: AppOptions = {}): Promise<FastifyInstance> {
  const tls = opts.https;
  // (cast: with `https` Fastify's instance type is parameterised on https.Server; we only use the common API)
  const app = (tls ? Fastify({ logger: opts.logger ?? false, https: { key: tls.key, cert: tls.cert } }) : Fastify({ logger: opts.logger ?? false })) as unknown as FastifyInstance;
  await app.register(fastifyWebsocket);

  const hasUi = fs.existsSync(path.join(config.webDist, 'index.html'));
  if (hasUi) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/' });
  }
  if (fs.existsSync(config.dataDir)) {
    await app.register(fastifyStatic, { root: config.dataDir, prefix: '/data/', decorateReply: !hasUi });
  }
  // The GUI shows its own banner; this makes a plain 404 self-explanatory too.
  const dataHint = () => ({ error: `catalog data not found in ${config.dataDir}: ${MISSING_DATA_HINT}` });
  if (!hasUi) app.get('/', (_req, reply) => reply.type('text/html').send(MISSING_UI_HTML(config.webDist)));
  if (tls?.ca) {
    // the public CA certificate (never the key); iOS offers to install a profile from this content type
    app.get(CA_CERT_PATH, (_req, reply) => reply.type('application/x-x509-ca-cert').header('content-disposition', 'attachment; filename="stargazer-ca.crt"').send(tls.ca));
  }

  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0]!;
    const spaRoute = req.method === 'GET' && !url.startsWith('/data/') && url !== '/ws' && !path.extname(url);
    if (spaRoute && hasUi) return reply.sendFile('index.html', config.webDist);
    if (spaRoute) return reply.type('text/html').send(MISSING_UI_HTML(config.webDist));
    if (url.startsWith('/data/')) return reply.code(404).send(dataHint());
    return reply.code(404).send({ error: 'not found' });
  });

  // ---------- WebSocket ----------
  // Each WS client gets an id: manual moves are owned per client (dead-man and disconnect stop only its axes).
  const clients = new Map<WsLike, string>();
  let clientSeq = 0;
  const send = (ws: WsLike, msg: ServerMessage) => {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage) => {
    if (!clients.size) return;
    const data = JSON.stringify(msg);
    for (const ws of clients.keys()) if (ws.readyState === WS_OPEN) ws.send(data);
  };
  // Network info is cached: interfaces change rarely (joining the telescope WiFi) and the state goes out at 4 Hz.
  let network: { value: ServerNetwork; at: number } | null = null;
  const networkInfo = (): ServerNetwork | undefined => {
    const addr = app.server.address() as AddressInfo | string | null;
    if (!addr || typeof addr === 'string') return undefined;
    if (!network || Date.now() - network.at > 10_000) {
      const value = serverNetwork(addr.address, addr.port, opts.lanAddresses, !!tls);
      if (tls) {
        value.certFingerprint = tls.fingerprint256;
        if (tls.ca) value.caCertPath = CA_CERT_PATH;
      }
      network = { value, at: Date.now() };
    }
    return network.value;
  };
  const fullState = (): MountState => {
    const net = networkInfo();
    return { ...mount.getState(), clients: clients.size, ...(net ? { network: net } : {}) };
  };
  const broadcastState = () => broadcast({ type: 'state', state: fullState() });

  // Push on change (coalesced), and at least every 250 ms while connected / 1 s otherwise.
  let pending: NodeJS.Timeout | null = null;
  let lastSent = 0;
  const flush = () => {
    pending = null;
    lastSent = Date.now();
    broadcastState();
  };
  const onChange = () => {
    if (!pending) pending = setTimeout(flush, 20);
  };
  const onLog = (e: LogEntry) => broadcast({ type: 'log', ...e });
  const onAlert = (message: string) => broadcast({ type: 'error', message });
  const onList = (entries: ObservingListEntry[]) => broadcast({ type: 'list', entries });
  mount.on('change', onChange);
  mount.on('log', onLog);
  mount.on('alert', onAlert);
  mount.on('list', onList);
  const ticker = setInterval(() => {
    const period = mount.isConnected ? 250 : 1000;
    if (Date.now() - lastSent >= period - 10) flush();
  }, 125);

  app.addHook('onClose', async () => {
    clearInterval(ticker);
    if (pending) clearTimeout(pending);
    mount.off('change', onChange);
    mount.off('log', onLog);
    mount.off('alert', onAlert);
    mount.off('list', onList);
  });

  app.get('/ws', { websocket: true }, (socket: WsLike) => {
    const id = `c${++clientSeq}`;
    clients.set(socket, id);
    send(socket, { type: 'state', state: fullState() });
    send(socket, { type: 'list', entries: mount.getObservingList() });
    onChange(); // everyone sees the new client count
    socket.on('close', () => {
      clients.delete(socket);
      // Dead-man: a vanished client must not leave its press-and-hold moves running. Other clients' moves go on.
      void mount.stopManual(id).catch(() => {});
      onChange();
    });
    socket.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = parseClientMessage(data.toString());
      } catch (e) {
        return send(socket, { type: 'error', message: (e as Error).message });
      }
      handleMessage(mount, msg, id, (m) => send(socket, m)).catch((e: Error) =>
        send(socket, { type: 'error', message: e.message, requestType: msg.type }),
      );
    });
  });

  return app;
}

async function handleMessage(mount: Mount, msg: ClientMessage, client: string, reply: (m: ServerMessage) => void): Promise<void> {
  if (isListMessage(msg)) return mount.listCommand(msg);
  switch (msg.type) {
    case 'connect':
      return mount.connect(msg.host, msg.port);
    case 'disconnect':
      return mount.disconnect();
    case 'move':
      return mount.move(msg.axis, msg.direction, msg.rate, client);
    case 'stopAxis':
      return mount.stopAxis(msg.axis, client);
    case 'stop':
      return mount.stop();
    case 'goto': {
      const r = await mount.goto(msg.target, msg.force ?? false);
      if (r.status === 'confirm') reply({ type: 'confirm', message: r.message, request: msg });
      return;
    }
    case 'setTracking':
      return mount.setTracking(msg.enabled);
    case 'setLocation':
      return mount.setLocation(msg.location);
    case 'alignHome':
      return mount.alignHome(msg.azDeg, msg.altDeg, { source: msg.source, uncertainty: msg.uncertainty, magHeadingDeg: msg.magHeadingDeg, declinationDeg: msg.declinationDeg });
    case 'alignAddPoint':
      return mount.alignAddPoint(msg.target);
    case 'alignRemovePoint':
      return mount.alignRemovePoint(msg.id);
    case 'alignClear':
      return mount.alignClear();
    case 'sync':
      return mount.sync(msg.target);
  }
}
