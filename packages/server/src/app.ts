// Fastify app: static web UI + /data, and the WebSocket /ws implementing the api.ts contract.
import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ClientMessage, ServerMessage } from '@stargazer/shared/api.ts';
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
  const isTarget = (t: unknown) => {
    if (!t || typeof t !== 'object') return false;
    const x = t as Record<string, unknown>;
    if (typeof x.name !== 'string') return false;
    if (x.kind === 'radec') return isNum(x.ra) && isNum(x.dec);
    if (x.kind === 'altaz') return isNum(x.az) && isNum(x.alt);
    return x.kind === 'body' && typeof x.body === 'string';
  };
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
    case 'alignHome':
      need((msg.azDeg === undefined || isNum(msg.azDeg)) && (msg.altDeg === undefined || isNum(msg.altDeg)), 'azDeg/altDeg must be numbers');
      break;
    case 'alignRemovePoint':
      need(isNum(msg.id), 'id must be a number');
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

export async function buildApp(config: ServerConfig, mount: Mount, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
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

  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0]!;
    const spaRoute = req.method === 'GET' && !url.startsWith('/data/') && url !== '/ws' && !path.extname(url);
    if (spaRoute && hasUi) return reply.sendFile('index.html', config.webDist);
    if (spaRoute) return reply.type('text/html').send(MISSING_UI_HTML(config.webDist));
    if (url.startsWith('/data/')) return reply.code(404).send(dataHint());
    return reply.code(404).send({ error: 'not found' });
  });

  // ---------- WebSocket ----------
  const clients = new Set<WsLike>();
  const send = (ws: WsLike, msg: ServerMessage) => {
    if (ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage) => {
    if (!clients.size) return;
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === WS_OPEN) ws.send(data);
  };
  const broadcastState = () => broadcast({ type: 'state', state: mount.getState() });

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
  mount.on('change', onChange);
  mount.on('log', onLog);
  mount.on('alert', onAlert);
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
  });

  app.get('/ws', { websocket: true }, (socket: WsLike) => {
    clients.add(socket);
    send(socket, { type: 'state', state: mount.getState() });
    socket.on('close', () => {
      clients.delete(socket);
      // Dead-man: a vanished client must not leave a press-and-hold move running.
      void mount.stopManual().catch(() => {});
    });
    socket.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = parseClientMessage(data.toString());
      } catch (e) {
        return send(socket, { type: 'error', message: (e as Error).message });
      }
      handleMessage(mount, msg, (m) => send(socket, m)).catch((e: Error) =>
        send(socket, { type: 'error', message: e.message, requestType: msg.type }),
      );
    });
  });

  return app;
}

async function handleMessage(mount: Mount, msg: ClientMessage, reply: (m: ServerMessage) => void): Promise<void> {
  switch (msg.type) {
    case 'connect':
      return mount.connect(msg.host, msg.port);
    case 'disconnect':
      return mount.disconnect();
    case 'move':
      return mount.move(msg.axis, msg.direction, msg.rate);
    case 'stopAxis':
      return mount.stopAxis(msg.axis);
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
      return mount.alignHome(msg.azDeg, msg.altDeg);
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
