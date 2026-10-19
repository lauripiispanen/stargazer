// Network front-ends for the simulator: TCP AUX server and HTTP debug API.
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { AuxFrameParser, describePacket, encodePacket, toHex } from '@stargazer/shared/aux.ts';
import { Simulator, type SimConfig } from './sim.ts';

export interface RunningSimulator {
  sim: Simulator;
  auxPort: number;
  httpPort: number | null;
  /** Drop all TCP clients (e.g. power cycle). */
  dropClients(): void;
  close(): Promise<void>;
}

export interface StartOptions extends Partial<SimConfig> {
  /** Set false to skip the HTTP debug server (tests). */
  http?: boolean;
  log?: (msg: string) => void;
}

export async function startSimulator(opts: StartOptions = {}): Promise<RunningSimulator> {
  const { http: withHttp = true, log = (m: string) => console.log(m), ...cfg } = opts;
  const sim = new Simulator(cfg);
  const clients = new Set<net.Socket>();
  const ticker = setInterval(() => sim.advance(), 50);

  const delay = () => Math.max(0, sim.cfg.latencyMs + (Math.random() * 2 - 1) * sim.cfg.jitterMs);

  const auxServer = net.createServer((sock) => {
    if (sim.cfg.singleClient) for (const c of clients) c.destroy();
    clients.add(sock);
    sock.setNoDelay(true);
    const peer = `${sock.remoteAddress}:${sock.remotePort}`;
    log(`[sim] client connected ${peer}`);
    const parser = new AuxFrameParser();

    const write = (bytes: Uint8Array) => {
      if (!sock.destroyed) sock.write(bytes);
    };

    sock.on('data', (chunk) => {
      for (const frame of parser.push(chunk)) {
        if (sim.cfg.verbose) log(`[sim] <- ${toHex(frame.raw)}  ${describePacket(frame)}`);
        const resp = sim.handle(frame);
        const respBytes = resp ? encodePacket(resp) : null;
        if (resp && sim.cfg.verbose) log(`[sim] -> ${toHex(respBytes!)}  ${describePacket(resp)}`);
        const echo = sim.cfg.echo ? frame.raw : null;
        const ms = delay();
        if (sim.cfg.coalesce) {
          const parts = [echo, respBytes].filter((b): b is Uint8Array => !!b);
          if (!parts.length) continue;
          const all = Buffer.concat(parts);
          ms > 0 ? setTimeout(() => write(all), ms) : write(all);
        } else {
          if (echo) write(echo);
          if (respBytes) ms > 0 ? setTimeout(() => write(respBytes), ms) : write(respBytes);
        }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clients.delete(sock);
      log(`[sim] client disconnected ${peer}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    auxServer.once('error', reject);
    auxServer.listen(sim.cfg.auxPort, sim.cfg.host, () => resolve());
  });
  const auxPort = (auxServer.address() as AddressInfo).port;

  const dropClients = () => {
    for (const c of clients) c.destroy();
  };

  let httpServer: http.Server | null = null;
  if (withHttp) {
    httpServer = http.createServer((req, res) => handleHttp(sim, dropClients, req, res));
    await new Promise<void>((resolve, reject) => {
      httpServer!.once('error', reject);
      httpServer!.listen(sim.cfg.httpPort, sim.cfg.host, () => resolve());
    });
  }
  const httpPort = httpServer ? (httpServer.address() as AddressInfo).port : null;

  return {
    sim,
    auxPort,
    httpPort,
    dropClients,
    async close() {
      clearInterval(ticker);
      dropClients();
      await Promise.all([
        new Promise<void>((r) => auxServer.close(() => r())),
        httpServer ? new Promise<void>((r) => httpServer!.close(() => r())) : Promise.resolve(),
      ]);
    },
  };
}

function handleHttp(sim: Simulator, dropClients: () => void, req: http.IncomingMessage, res: http.ServerResponse): void {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body, null, 2));
  };
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /truth') return send(200, sim.truth());
  if (route === 'GET /config') return send(200, sim.cfg);
  if (route === 'GET /status') return send(200, sim.status());
  if (route === 'POST /power-cycle') {
    sim.powerCycle();
    dropClients();
    return send(200, { ok: true });
  }
  if (route === 'POST /randomize') {
    sim.randomizeOrientation();
    return send(200, { ok: true, hidden: sim.cfg.hidden });
  }
  if (route === 'POST /config') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}') as Record<string, unknown>;
        const allowed = ['location', 'hidden', 'echo', 'latencyMs', 'slewRates', 'jitterMs', 'coalesce', 'verbose', 'maxRateDeg', 'slowRateDeg', 'accelDeg', 'battery', 'batteryVolts'];
        const unknown = Object.keys(patch).filter((k) => !allowed.includes(k));
        if (unknown.length) return send(400, { error: `unknown keys: ${unknown.join(', ')}`, allowed });
        sim.updateConfig(patch as Partial<SimConfig>);
        send(200, sim.cfg);
      } catch (e) {
        send(400, { error: (e as Error).message });
      }
    });
    return;
  }
  send(404, { error: 'not found', routes: ['GET /truth', 'GET /config', 'POST /config', 'GET /status', 'POST /power-cycle', 'POST /randomize'] });
}
