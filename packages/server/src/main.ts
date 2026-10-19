// Stargazer server entry point. Env: see config.ts (TELESCOPE_HOST/PORT, SERVER_PORT, STARGAZER_*).
import { buildApp, MISSING_DATA_HINT, missingDataFiles } from './app.ts';
import { loadConfig } from './config.ts';
import { Mount } from './mount.ts';
import { StateStore } from './persist.ts';

const config = loadConfig();
const store = config.stateFile ? new StateStore(config.stateFile) : null;
const mount = new Mount({ config, store });
const app = await buildApp(config, mount);

// Loopback by default: anyone who can reach the server can move the telescope. HOST=0.0.0.0 lets a tablet on
// the telescope WiFi use the GUI (see README).
const host = process.env.HOST || '127.0.0.1';
await app.listen({ port: config.serverPort, host });
console.log(`[server] http://${host === '0.0.0.0' ? 'localhost' : host}:${config.serverPort}  (telescope ${config.telescopeHost}:${config.telescopePort})`);
if (host === '0.0.0.0') console.warn('[server] listening on all interfaces: any device on this network can control the telescope');
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
