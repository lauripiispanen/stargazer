// Fake Celestron Astro Fi. Usage: npm run sim -- [--verbose] [--no-echo] [--latency 15] [--realistic] ...
import { parseArgs } from 'node:util';
import { SIMULATOR_AUX_PORT, SIMULATOR_HTTP_PORT } from '@stargazer/shared/api.ts';
import { DEFAULT_SIM_CONFIG, type SimConfig } from './sim.ts';
import { startSimulator } from './server.ts';

const HELP = `Stargazer Astro Fi simulator

Options (env var in brackets):
  --host <ip>            bind address (SIM_HOST, default 127.0.0.1)
  --aux-port <n>         AUX TCP port (SIMULATOR_AUX_PORT, default ${SIMULATOR_AUX_PORT})
  --http-port <n>        HTTP debug port (SIMULATOR_HTTP_PORT, default ${SIMULATOR_HTTP_PORT})
  --no-echo              disable bus echo (SIM_ECHO=0)
  --no-coalesce          write echo and response separately (SIM_COALESCE=0)
  --latency <ms>         response latency (SIM_LATENCY_MS, default ${DEFAULT_SIM_CONFIG.latencyMs})
  --jitter <ms>          latency jitter (SIM_JITTER_MS, default ${DEFAULT_SIM_CONFIG.jitterMs})
  --realistic            encoders 0,0 with random physical orientation and mount errors (SIM_REALISTIC=1)
  --lat <deg> --lon <deg> observer location (SIM_LAT / SIM_LON)
  --slew-rates <list>    10 comma-separated deg/s values for rates 0..9 (SIM_SLEW_RATES)
  --max-rate <deg/s>     GOTO_FAST speed (SIM_MAX_RATE, default ${DEFAULT_SIM_CONFIG.maxRateDeg})
  --slow-rate <deg/s>    GOTO_SLOW speed (SIM_SLOW_RATE, default ${DEFAULT_SIM_CONFIG.slowRateDeg})
  --battery              emulate the Evolution battery device 0xB6 (SIM_BATTERY=1)
  --verbose              log every packet in hex (SIM_VERBOSE=1)
`;

const { values } = parseArgs({
  options: {
    host: { type: 'string' },
    'aux-port': { type: 'string' },
    'http-port': { type: 'string' },
    'no-echo': { type: 'boolean' },
    'no-coalesce': { type: 'boolean' },
    latency: { type: 'string' },
    jitter: { type: 'string' },
    realistic: { type: 'boolean' },
    lat: { type: 'string' },
    lon: { type: 'string' },
    'slew-rates': { type: 'string' },
    'max-rate': { type: 'string' },
    'slow-rate': { type: 'string' },
    battery: { type: 'boolean' },
    verbose: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const env = process.env;
const num = (flag: string | undefined, envVal: string | undefined, def: number) => {
  const v = flag ?? envVal;
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return n;
};
const bool = (flag: boolean | undefined, envVal: string | undefined, def: boolean) =>
  flag ?? (envVal === undefined ? def : !['0', 'false', 'no', 'off'].includes(envVal.toLowerCase()));

const d = DEFAULT_SIM_CONFIG;
const ratesStr = values['slew-rates'] ?? env.SIM_SLEW_RATES;
const slewRates = ratesStr ? ratesStr.split(',').map(Number) : d.slewRates;
if (slewRates.length !== 10 || slewRates.some((r) => !Number.isFinite(r))) throw new Error('--slew-rates needs 10 numbers');

const cfg: Partial<SimConfig> = {
  host: values.host ?? env.SIM_HOST ?? d.host,
  auxPort: num(values['aux-port'], env.SIMULATOR_AUX_PORT, SIMULATOR_AUX_PORT),
  httpPort: num(values['http-port'], env.SIMULATOR_HTTP_PORT, SIMULATOR_HTTP_PORT),
  echo: values['no-echo'] ? false : bool(undefined, env.SIM_ECHO, d.echo),
  coalesce: values['no-coalesce'] ? false : bool(undefined, env.SIM_COALESCE, d.coalesce),
  latencyMs: num(values.latency, env.SIM_LATENCY_MS, d.latencyMs),
  jitterMs: num(values.jitter, env.SIM_JITTER_MS, d.jitterMs),
  realistic: bool(values.realistic, env.SIM_REALISTIC, d.realistic),
  location: { lat: num(values.lat, env.SIM_LAT, d.location.lat), lon: num(values.lon, env.SIM_LON, d.location.lon), elevation: 0 },
  slewRates,
  maxRateDeg: num(values['max-rate'], env.SIM_MAX_RATE, d.maxRateDeg),
  slowRateDeg: num(values['slow-rate'], env.SIM_SLOW_RATE, d.slowRateDeg),
  verbose: bool(values.verbose, env.SIM_VERBOSE, d.verbose),
  battery: bool(values.battery, env.SIM_BATTERY, d.battery),
};

const running = await startSimulator(cfg);
const c = running.sim.cfg;
console.log(
  `[sim] AUX on ${c.host}:${running.auxPort}, HTTP on http://${c.host}:${running.httpPort} ` +
    `(echo ${c.echo ? 'on' : 'off'}, latency ${c.latencyMs}±${c.jitterMs} ms${c.realistic ? ', realistic power-on' : ''})`,
);

const shutdown = () => {
  void running.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
