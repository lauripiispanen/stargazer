// Stargazer server entry point. Env: see config.ts (TELESCOPE_HOST/PORT, SERVER_PORT, STARGAZER_*).
import type https from 'node:https';
import { type AppTls, buildApp, CA_CERT_PATH, lanAddresses, MISSING_DATA_HINT, missingDataFiles, serverNetwork } from './app.ts';
import { loadConfig } from './config.ts';
import { Mount } from './mount.ts';
import { StateStore } from './persist.ts';
import { ensureTlsCert, tlsDir, tlsHosts } from './tls.ts';

const config = loadConfig();
const store = config.stateFile ? new StateStore(config.stateFile) : null;
const mount = new Mount({ config, store });

// HTTPS (opt-in: `--https`, HTTPS=1, or `npm run start:lan:https`): phone sensor APIs need a secure context.
// Plain HTTP stays the default. The certificate is local and self-signed (tls.ts).
const useHttps = process.argv.includes('--https') || ['1', 'true', 'yes', 'on'].includes((process.env.HTTPS ?? '').toLowerCase());
const dir = tlsDir(config.stateFile);
let tls: AppTls | undefined;
if (useHttps) {
  try {
    const m = ensureTlsCert(dir, tlsHosts(lanAddresses()));
    tls = { key: m.key, cert: m.cert, ca: m.ca, fingerprint256: m.fingerprint256 };
    console.log(`[server] HTTPS certificate ${m.issued ? 'created' : 'loaded'} (${m.dir}); SHA-256 ${m.fingerprint256}`);
  } catch (e) {
    console.error(`[server] cannot enable HTTPS: ${(e as Error).message}`);
    process.exit(1);
  }
}
const app = await buildApp(config, mount, { https: tls });
const scheme = tls ? 'https' : 'http';

// Loopback by default: anyone who can reach the server can move the telescope. HOST=0.0.0.0 lets a tablet on
// the telescope WiFi use the GUI (see README). `--lan` (npm run start:lan) is the same as HOST=0.0.0.0.
const host = process.env.HOST || (process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1');
await app.listen({ port: config.serverPort, host });
console.log(`[server] ${scheme}://${host === '0.0.0.0' ? 'localhost' : host}:${config.serverPort}  (telescope ${config.telescopeHost}:${config.telescopePort})`);
if (host === '0.0.0.0') {
  console.warn('[server] listening on all interfaces: any device on this network can control the telescope');
  const urls = serverNetwork(host, config.serverPort, lanAddresses, !!tls).lanUrls;
  console.log(urls.length ? `[server] phone remote: ${urls.join('  ')}` : '[server] no LAN address yet (join the telescope WiFi); the GUI shows it once available');
  if (tls) console.log(`[server] phones show a one-time certificate warning (check SHA-256 ${tls.fingerprint256.slice(0, 23)}…), or install ${CA_CERT_PATH}`);
}
// A new LAN address (e.g. joining the telescope WiFi after start) needs it in the certificate: re-issue and swap
// it into the running server. The CA stays the same.
if (tls) {
  const t = tls;
  setInterval(() => {
    try {
      const m = ensureTlsCert(dir, tlsHosts(lanAddresses()));
      if (!m.issued) return;
      (app.server as unknown as https.Server).setSecureContext({ key: m.key, cert: m.cert });
      Object.assign(t, { key: m.key, cert: m.cert, fingerprint256: m.fingerprint256 });
      console.log(`[server] network changed: HTTPS certificate re-issued for ${m.sans.join(', ')} (SHA-256 ${m.fingerprint256})`);
    } catch (e) {
      console.warn(`[server] could not refresh the HTTPS certificate: ${(e as Error).message}`);
    }
  }, 15_000).unref();
}
const missing = missingDataFiles(config.dataDir);
if (missing.length) console.warn(`[server] Catalog data not found (${missing.join(', ')} in ${config.dataDir}): ${MISSING_DATA_HINT}.`);

if (process.env.STARGAZER_AUTOCONNECT === '1') {
  mount.connect().catch(() => {}); // errors are logged and shown in state
}

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  await mount.dispose().catch(() => {}); // stops tracking and motion before closing the link
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
