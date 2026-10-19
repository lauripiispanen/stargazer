import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@stargazer/shared/api.ts';
import { buildApp, CA_CERT_PATH, parseClientMessage, serverNetwork } from './app.ts';
import { loadConfig } from './config.ts';
import { Mount } from './mount.ts';
import { fakeAstro } from './testing.ts';
import { certSans, ensureTlsCert, sanList, tlsDir, tlsHosts } from './tls.ts';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-tls-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('tls helpers', () => {
  it('keeps certificates next to the state file (dev: .dev/tls)', () => {
    expect(tlsDir('/home/u/.stargazer/state.json', {})).toBe('/home/u/.stargazer/tls');
    expect(tlsDir('/repo/.dev/state.json', {})).toBe('/repo/.dev/tls');
    expect(tlsDir(null, { STARGAZER_TLS_DIR: '/x/tls' })).toBe('/x/tls');
  });
  it('covers loopback, the hostname and every LAN address', () => {
    const h = tlsHosts(['192.168.1.5', '10.0.0.2'], 'mylaptop.local');
    expect(sanList(h)).toEqual(['DNS:localhost', 'DNS:mylaptop', 'DNS:mylaptop.local', 'IP:127.0.0.1', 'IP:192.168.1.5', 'IP:10.0.0.2']);
  });
  it('HTTPS LAN URLs', () => {
    expect(serverNetwork('0.0.0.0', 8080, () => ['192.168.4.2'], true)).toEqual({ bind: '0.0.0.0', port: 8080, lanUrls: ['https://192.168.4.2:8080/'], https: true });
  });
});

describe.skipIf(!hasOpenssl)('certificate generation (openssl)', () => {
  it('creates a CA-signed server certificate with the SANs, reuses it, and re-issues for a new IP', () => {
    const a = ensureTlsCert(dir, tlsHosts(['192.168.1.5'], 'scope'));
    expect(a.issued).toBe(true);
    expect(a.sans).toEqual(expect.arrayContaining(['DNS:localhost', 'DNS:scope.local', 'IP:127.0.0.1', 'IP:192.168.1.5']));
    const leaf = new crypto.X509Certificate(a.cert);
    const ca = new crypto.X509Certificate(a.ca!);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkIP('192.168.1.5')).toBe('192.168.1.5');
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    // iOS: at most 825 days
    expect((new Date(leaf.validTo).getTime() - new Date(leaf.validFrom).getTime()) / 86400e3).toBeLessThanOrEqual(825);
    expect(fs.statSync(path.join(dir, 'ca.key')).mode & 0o077).toBe(0);

    const b = ensureTlsCert(dir, tlsHosts(['192.168.1.5'], 'scope'));
    expect(b.issued).toBe(false);
    expect(b.fingerprint256).toBe(a.fingerprint256);

    const c = ensureTlsCert(dir, tlsHosts(['1.2.3.10'], 'scope'));
    expect(c.issued).toBe(true);
    expect(certSans(c.cert)).toEqual(expect.arrayContaining(['IP:1.2.3.10', 'IP:192.168.1.5']));
    expect(c.ca!.equals(a.ca!)).toBe(true); // same CA: a phone that installed it keeps trusting the server
  });

  it('serves HTTPS and WSS (state over a TLS WebSocket) and the CA certificate', async () => {
    const m = ensureTlsCert(dir, tlsHosts([], 'scope'));
    const config = loadConfig({}, { stateFile: null, packetLogFile: null, webDist: '/nonexistent', serverPort: 0 });
    const mount = new Mount({ config, astro: fakeAstro(), consoleLog: false });
    const app = await buildApp(config, mount, { https: { key: m.key, cert: m.cert, ca: m.ca, fingerprint256: m.fingerprint256 }, lanAddresses: () => ['192.168.9.9'] });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    try {
      const get = (p: string) =>
        new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
          https.get({ host: '127.0.0.1', port, path: p, ca: m.ca! }, (res) => {
            let body = '';
            res.on('data', (d) => (body += d));
            res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body }));
          }).on('error', reject);
        });
      const page = await get('/');
      expect(page.status).toBe(200); // verified against our CA, hostname 127.0.0.1 is in the SANs
      const ca = await get(CA_CERT_PATH);
      expect(ca.type).toMatch(/x509-ca-cert/);
      expect(ca.body).toMatch(/BEGIN CERTIFICATE/);
      expect(ca.body).not.toMatch(/PRIVATE KEY/);

      // WSS with the `ws` client (Fastify's own dependency), trusting our CA
      const { default: WS } = (await import('ws' as string)) as unknown as { default: new (url: string, opts: { ca: Buffer }) => { on(ev: string, cb: (d: unknown) => void): void; close(): void } };
      const state = await new Promise<Extract<ServerMessage, { type: 'state' }>['state']>((resolve, reject) => {
        const ws = new WS(`wss://127.0.0.1:${port}/ws`, { ca: m.ca! });
        ws.on('error', reject);
        ws.on('message', (d) => {
          const msg = JSON.parse(String(d)) as ServerMessage;
          if (msg.type === 'state') {
            ws.close();
            resolve(msg.state);
          }
        });
      });
      expect(state.network).toMatchObject({ https: true, caCertPath: CA_CERT_PATH, certFingerprint: m.fingerprint256 });
    } finally {
      await mount.dispose();
      await app.close();
    }
  });
});

describe('alignHome validation', () => {
  it('accepts the sensor fields and rejects bad ones', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'alignHome' }))).toEqual({ type: 'alignHome' });
    const ok = { type: 'alignHome', azDeg: 12, altDeg: 3, source: 'sensors', uncertainty: { azSigmaDeg: 5, altSigmaDeg: 0.5 }, magHeadingDeg: 2, declinationDeg: 10 };
    expect(parseClientMessage(JSON.stringify(ok))).toEqual(ok);
    expect(() => parseClientMessage(JSON.stringify({ ...ok, source: 'gps' }))).toThrow(/source/);
    expect(() => parseClientMessage(JSON.stringify({ ...ok, uncertainty: { azSigmaDeg: -1, altSigmaDeg: 1 } }))).toThrow(/uncertainty/);
    expect(() => parseClientMessage(JSON.stringify({ type: 'alignHome', source: 'sensors' }))).toThrow(/azDeg/);
  });
});
