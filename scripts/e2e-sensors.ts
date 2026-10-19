// Sensor auto-align end-to-end test: realistic simulator + server + built GUI on an iPhone-sized touch browser
// with `?fakeSensors` (the phone "lies on the tube": its orientation comes from the simulator's /truth plus a
// constant 3° compass / 0.3° altitude error and noise).
//
//   npm run e2e:sensors        (also run by npm run e2e:mobile)
//
// 1. Manual Home for comparison: the tube is driven to true level & north (within 20′), Home, GoTo a star,
//    measure the first-star GoTo error.
// 2. Sensor Home from wherever the tube now points (no levelling): Align › Sensors › Start › Capture › Set Home.
// 3. 3-star alignment from the phone (GoTo, centre, Centred), reporting each GoTo error.
// 4. HTTPS mode: the server restarts with a local certificate; the phone loads https://, the WebSocket runs over
//    wss:, the page is a secure context with the Sensors step, and the laptop card explains the certificate.
// Screenshots: E2E_SENSOR_SHOTS (default <E2E_OUT>/sensors). Results: <E2E_OUT>/e2e-sensors-results.json.
// Env: CHROME, E2E_OUT, E2E_SENSOR_SHOTS, E2E_NO_BUILD=1, E2E_HEADFUL=1. Uses ports 2000/2001/8080.
import { type ChildProcess, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { ClientMessage, GeoLocation, MountState, ServerMessage, Target } from '../packages/shared/src/api.ts';
import { type AltAz, separation, separationAltAz, sunAltitude, targetAltAz, targetRaDec } from '../packages/shared/src/astro.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.E2E_OUT || path.join(ROOT, 'e2e-output'));
const SHOTS = path.resolve(process.env.E2E_SENSOR_SHOTS || path.join(OUT, 'sensors'));
const SERVER = 'http://127.0.0.1:8080';
const SERVER_TLS = 'https://127.0.0.1:8080';
const SIM = 'http://127.0.0.1:2001';
const SIM_RATES = [0, 0.008, 0.017, 0.033, 0.067, 0.133, 0.5, 1, 2, 3];
const FAKE = { headingErr: 3, altErr: 0.3 };

type Truth = { encoder: { az: number; alt: number }; sky: { ra: number; dec: number; az: number; alt: number }; hidden: Record<string, number> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const log = (...a: unknown[]) => console.log(`[e2e-sensors ${new Date().toLocaleTimeString()}]`, ...a);
const fmtA = (arcmin: number) => `${arcmin.toFixed(1)}′ (${(arcmin / 60).toFixed(2)}°)`;

const children: ChildProcess[] = [];
function startProc(name: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const p = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(path.join(OUT, `sensors-${name}.log`));
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  children.push(p);
  return p;
}
const browsers: Browser[] = [];
function cleanup() {
  for (const b of browsers) b.process()?.kill('SIGKILL');
  for (const p of children) if (p.exitCode === null) p.kill('SIGTERM');
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

async function up(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}
async function waitHttp(url: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await up(url)) return;
    await sleep(200);
  }
  throw new Error(`${url} did not come up`);
}
const simGet = async <T>(p: string): Promise<T> => (await (await fetch(SIM + p)).json()) as T;
const simPost = (p: string, body: unknown) => fetch(SIM + p, { method: 'POST', body: JSON.stringify(body) });
const truth = () => simGet<Truth>('/truth');

class Observer {
  state: MountState | null = null;
  errors: string[] = [];
  logs: string[] = [];
  private ws!: WebSocket;
  async open() {
    this.ws = new WebSocket(SERVER.replace('http', 'ws') + '/ws');
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.type === 'state') this.state = m.state;
      else if (m.type === 'error') this.errors.push(m.message);
      else if (m.type === 'log') this.logs.push(m.message);
    };
    await new Promise((r, j) => {
      this.ws.onopen = r;
      this.ws.onerror = j;
    });
  }
  send(m: ClientMessage) {
    this.ws.send(JSON.stringify(m));
  }
  async until(pred: (s: MountState) => boolean, what: string, ms = 20_000): Promise<MountState> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.state && pred(this.state)) return this.state;
      await sleep(50);
    }
    throw new Error(`timed out waiting for: ${what} (errors: ${this.errors.slice(-3).join(' | ')})`);
  }
  close() {
    this.ws.close();
  }
}

function darkLocation(now: number): GeoLocation {
  const cands = [{ lat: 60.17, lon: 24.94 }, ...Array.from({ length: 24 }, (_, i) => ({ lat: 45, lon: -180 + i * 15 }))];
  for (const c of cands) {
    const loc: GeoLocation = { ...c, elevation: 0, source: 'manual', label: 'e2e' };
    if (sunAltitude(loc, now) < -15 && sunAltitude(loc, now + 3 * 3600e3) < -15) return loc;
  }
  throw new Error('no dark location found');
}

const STARS: [string, number, number][] = [
  ['Vega', 279.2347, 38.7837], ['Capella', 79.1723, 45.998], ['Arcturus', 213.9153, 19.1824], ['Altair', 297.6958, 8.8683],
  ['Deneb', 310.358, 45.2803], ['Aldebaran', 68.98, 16.5093], ['Betelgeuse', 88.7929, 7.4071], ['Procyon', 114.8255, 5.225],
  ['Pollux', 116.329, 28.0262], ['Regulus', 152.093, 11.9672], ['Spica', 201.2983, -11.1613], ['Dubhe', 165.932, 61.751],
  ['Mirfak', 51.0807, 49.8612], ['Alpheratz', 2.0969, 29.0904], ['Hamal', 31.7934, 23.4624], ['Fomalhaut', 344.4127, -29.6222],
];
/** A bright star 20–45° up (low enough that a sensor Home taken there is in the compass's good range). */
function pickStar(loc: GeoLocation): { name: string; target: Target } {
  let best: { name: string; target: Target; score: number } | null = null;
  for (const [name, ra, dec] of STARS) {
    const target: Target = { kind: 'radec', ra, dec, name };
    const aa = targetAltAz(target, loc, Date.now());
    if (aa.alt < 20 || aa.alt > 45) continue;
    const score = -Math.abs(aa.alt - 32);
    if (!best || score > best.score) best = { name, target, score };
  }
  if (!best) throw new Error('no comparison star available');
  return best;
}

/** Drive the mount with WS press-and-hold moves (with heartbeats) until the tube truly points at `want`. */
async function centreWithMoves(obs: Observer, want: () => AltAz, tolArcmin: number, maxRate: number): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const t = await truth();
    const w = want();
    const err = separationAltAz(t.sky, w) * 60;
    if (err < tolArcmin) return err;
    const dAz = wrap180(w.az - t.sky.az);
    const dAlt = w.alt - t.sky.alt;
    const azAng = Math.abs(dAz) * Math.cos((t.sky.alt * Math.PI) / 180);
    const [axis, dir, deg] = azAng > Math.abs(dAlt) ? (['az', dAz > 0 ? 1 : -1, Math.abs(dAz)] as const) : (['alt', dAlt > 0 ? 1 : -1, Math.abs(dAlt)] as const);
    let r = 1;
    for (let k = maxRate; k >= 1; k--) if (deg / SIM_RATES[k]! >= 0.7) { r = k; break; }
    const ms = Math.min(25_000, (deg / SIM_RATES[r]!) * 1000);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      obs.send({ type: 'move', axis, direction: dir, rate: r });
      await sleep(Math.min(150, Math.max(10, end - Date.now())));
    }
    obs.send({ type: 'stopAxis', axis });
    await sleep(r >= 6 ? 800 : 450);
  }
  throw new Error('could not centre');
}

async function tap(page: Page, selector: string, timeout = 10_000) {
  const el = await page.waitForSelector(selector, { visible: true, timeout });
  if (!el) throw new Error(`not found: ${selector}`);
  const disabled = await el.evaluate((e) => (e as HTMLButtonElement).disabled === true);
  if (disabled) {
    const why = await el.evaluate((e) => e.closest('[title]')?.getAttribute('title') ?? '');
    throw new Error(`disabled: ${selector}${why ? ` (${why})` : ''}`);
  }
  await el.scrollIntoView();
  await el.tap();
}
async function confirmModal(page: Page) {
  const modal = await page.waitForSelector('.modal', { visible: true, timeout: 1500 }).catch(() => null);
  if (!modal) return;
  const dontAsk = await page.$('.modal input[type=checkbox]');
  if (dontAsk) await dontAsk.tap();
  await tap(page, '.modal button.primary');
}
async function shot(page: Page, name: string, full = false) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  log(`screenshot ${file}`);
}
/** Screenshot the whole scrollable remote content (the .r-main scroller) by temporarily un-clipping it. */
async function shotRemoteFull(page: Page, name: string) {
  const h = await page.$eval('.r-main', (e) => e.scrollHeight + 200);
  const vp = page.viewport()!;
  await page.setViewport({ ...vp, height: Math.max(vp.height, Math.min(h, 3000)) });
  await sleep(300);
  await shot(page, name);
  await page.setViewport(vp);
  await sleep(200);
}
async function waitGoto(obs: Observer, name: string, ms = 180_000): Promise<MountState> {
  await obs.until((s) => s.slew.startsWith('goto') && s.target?.name === name, `GoTo ${name} to start`, 10_000);
  return obs.until((s) => s.slew === 'idle' && s.target?.name === name, `arrival at ${name}`, ms);
}
const pointingErr = async (target: Target, loc: GeoLocation) => separation((await truth()).sky, targetRaDec(target, loc, Date.now())) * 60;

const PHONE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const failures: string[] = [];
  const checks: string[] = [];
  const results: Record<string, unknown> = { checks, fakeSensorError: FAKE };
  const check = (ok: boolean, what: string) => {
    log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
    checks.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };

  for (const url of [SERVER, SIM]) if (await up(url)) throw new Error(`${url} is already in use: stop npm run dev / npm start first`);
  if (!process.env.E2E_NO_BUILD) {
    log('building the GUI');
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  }
  const stateDir = fs.mkdtempSync(path.join(OUT, 'sensors-state-'));
  startProc('simulator', ['packages/simulator/src/main.ts', '--realistic']);
  await waitHttp(`${SIM}/config`);
  const serverEnv = { TELESCOPE_HOST: '127.0.0.1', STARGAZER_STATE_FILE: path.join(stateDir, 'state.json'), STARGAZER_PACKET_LOG: 'none', STARGAZER_TLS_DIR: path.join(stateDir, 'tls') };
  let server = startProc('server', ['packages/server/src/main.ts'], serverEnv);
  await waitHttp(SERVER);

  const loc = darkLocation(Date.now());
  await simPost('/config', { location: { lat: loc.lat, lon: loc.lon } });
  // like scripts/e2e.ts: hidden mount errors from --realistic, and the tube carried out roughly north and level
  const hidden0 = (await truth()).hidden;
  const IA = (((Math.random() * 40 - 20) % 360) + 360) % 360;
  const IE = Math.random() * 20 - 8;
  await simPost('/config', { hidden: { IA, IE } });
  results.location = { lat: loc.lat, lon: loc.lon };
  results.hiddenErrors = { ...hidden0, IA, IE };
  log(`location ${loc.lat}, ${loc.lon}; hidden ${JSON.stringify(results.hiddenErrors)}`);

  const obs = new Observer();
  await obs.open();
  obs.send({ type: 'setLocation', location: loc });
  await obs.until((s) => s.location?.lat === loc.lat, 'server location');

  const chrome =
    process.env.CHROME ||
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('Chrome not found: set CHROME=/path/to/chrome');
  const launch = async (args: string[], acceptInsecureCerts = false) => {
    const b = await puppeteer.launch({ executablePath: chrome, headless: !process.env.E2E_HEADFUL, acceptInsecureCerts, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', ...args], defaultViewport: null });
    browsers.push(b);
    return b;
  };
  const consoleErrors: string[] = [];
  const external: string[] = [];
  const watch = (name: string, page: Page) => {
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${name}: ${m.text()}`));
    page.on('pageerror', (e) => consoleErrors.push(`${name}: ${String(e)}`));
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) external.push(r.url());
    });
  };
  const phoneBrowser = await launch(['--window-size=390,844']);
  const phone = (await phoneBrowser.pages())[0] ?? (await phoneBrowser.newPage());
  await phone.setUserAgent(PHONE_UA);
  await phone.setViewport(PHONE_VIEWPORT);
  watch('phone', phone);
  const deskBrowser = await launch(['--window-size=1400,900']);
  const desk = (await deskBrowser.pages())[0] ?? (await deskBrowser.newPage());
  await desk.setViewport({ width: 1400, height: 900 });
  watch('desktop', desk);

  try {
    // ---------------------------------------------------------------- connect
    await phone.goto(`${SERVER}/?remote&fakeSensors&fakeHeadingErr=${FAKE.headingErr}&fakeAltErr=${FAKE.altErr}`, { waitUntil: 'networkidle0' });
    await tap(phone, '.r-preset::-p-text(Simulator)');
    await tap(phone, 'button::-p-text(Connect)');
    await obs.until((s) => s.connection === 'connected' && !!s.encoder, 'telescope connection', 15_000);

    // ---------------------------------------------------------------- 1. manual Home baseline
    const star = pickStar(loc);
    const levelErr = await centreWithMoves(obs, () => ({ az: 0, alt: 0 }), 20, 6);
    log(`manual: tube ${fmtA(levelErr)} from true level/north`);
    obs.send({ type: 'alignHome' });
    await obs.until((s) => s.alignment.quality === 'rough' && s.alignment.home?.source === 'manual', 'manual Home');
    obs.send({ type: 'goto', target: star.target, force: true });
    await waitGoto(obs, star.name);
    await sleep(1500);
    const manualErr = await pointingErr(star.target, loc);
    log(`manual Home: first-star (${star.name}) GoTo error ${fmtA(manualErr)}`);

    // ---------------------------------------------------------------- 2. sensor Home from wherever the tube is
    obs.send({ type: 'alignClear' });
    await obs.until((s) => s.alignment.quality === 'none', 'alignment cleared');
    obs.send({ type: 'stop' });
    await obs.until((s) => s.slew === 'idle' && !s.tracking, 'stopped');
    await tap(phone, '.r-tab[data-tab=align]');
    await tap(phone, 'button::-p-text(Looks right)');
    await phone.waitForSelector('.sensors-step', { visible: true });
    check(!!(await phone.$('.step::-p-text(Sensors)')), 'Align tab lists the Sensors step');
    await sleep(300);
    await shot(phone, '01-sensors-intro');
    await tap(phone, 'button::-p-text(Start sensors)');
    await phone.waitForFunction(() => /°/.test(document.querySelector('.sensor-readout .sr-val')?.textContent ?? ''), { timeout: 10_000 });
    await sleep(1800); // stability meter fills
    const shown = await phone.$$eval('.sensor-readout .sr-val', (els) => els.map((e) => e.textContent ?? ''));
    const t0 = await truth();
    const shownAlt = parseFloat(shown[0] ?? '');
    const shownAz = parseFloat(shown[1] ?? '');
    log(`live readout: alt ${shown[0]}, heading ${shown[1]} (truth alt ${t0.sky.alt.toFixed(2)}°, az ${t0.sky.az.toFixed(2)}°)`);
    check(Math.abs(shownAlt - t0.sky.alt) < FAKE.altErr + 0.3, `live altitude matches the tube (${shownAlt}° vs true ${t0.sky.alt.toFixed(2)}°)`);
    check(Math.abs(wrap180(shownAz - t0.sky.az)) < FAKE.headingErr + 2, `live true heading = magnetic + declination (${shownAz}° vs true ${t0.sky.az.toFixed(2)}°)`);
    const decl = await phone.$eval('.sensors-step', (e) => /Declination\s*([+−-][\d.]+)/.exec(e.textContent ?? '')?.[1] ?? '');
    results.declinationShown = decl;
    await shotRemoteFull(phone, '02-sensors-live');
    await tap(phone, 'button::-p-text(Capture)');
    await sleep(800);
    await shot(phone, '03-sensors-capturing');
    await phone.waitForSelector('.sensor-review', { visible: true, timeout: 8000 });
    await sleep(200);
    await shotRemoteFull(phone, '04-sensors-review');
    const tCap = await truth();
    await tap(phone, 'button::-p-text(Set Home from sensors)');
    const homed = await obs.until((s) => s.alignment.quality === 'rough' && s.alignment.home?.source === 'sensors', 'sensor Home');
    const home = homed.alignment.home!;
    const homeAzErr = wrap180(home.azDeg - tCap.sky.az);
    const homeAltErr = home.altDeg - tCap.sky.alt;
    log(`sensor Home: az ${home.azDeg.toFixed(2)}° ±${home.azSigmaDeg}° (true ${tCap.sky.az.toFixed(2)}°, err ${homeAzErr.toFixed(2)}°), alt ${home.altDeg.toFixed(2)}° ±${home.altSigmaDeg}° (true ${tCap.sky.alt.toFixed(2)}°, err ${homeAltErr.toFixed(2)}°)`);
    check(Math.abs(homeAltErr) < FAKE.altErr + 0.3, `sensor Home altitude within ${FAKE.altErr + 0.3}° of the truth (${homeAltErr.toFixed(2)}°)`);
    check(Math.abs(homeAzErr) < FAKE.headingErr + 1.5, `sensor Home azimuth within ${FAKE.headingErr + 1.5}° of the truth (${homeAzErr.toFixed(2)}°)`);
    check(home.azSigmaDeg != null && home.azSigmaDeg >= 5 && home.altSigmaDeg != null && home.altSigmaDeg < 1, `uncertainty sent (az ±${home.azSigmaDeg}°, alt ±${home.altSigmaDeg}°)`);
    check(home.declinationDeg != null && Math.abs(home.declinationDeg) > 0.1, `declination recorded (${home.declinationDeg?.toFixed(2)}°)`);
    await phone.waitForSelector('button::-p-text(Continue with stars)', { visible: true });
    await sleep(300);
    await shot(phone, '05-sensors-done');
    await desk.goto(`${SERVER}/?panel=align`, { waitUntil: 'networkidle0' });
    await desk.waitForFunction(() => !document.querySelector('.loading'), { timeout: 20_000 });
    await desk.waitForSelector('.home-summary[data-source=sensors]', { visible: true, timeout: 10_000 }).catch(() => null);
    const deskHome = await desk.$eval('.home-summary[data-source=sensors]', (e) => e.textContent ?? '').catch(() => '');
    check(/phone sensors/.test(deskHome) && /±/.test(deskHome), `desktop wizard shows Home came from the phone sensors ("${deskHome.slice(0, 80)}…")`);
    await shot(desk, '06-desktop-wizard-sensor-home');

    // ---------------------------------------------------------------- 3. stars from the phone
    await tap(phone, 'button::-p-text(Continue with stars)');
    await phone.waitForSelector('.r-suggest li', { visible: true, timeout: 15_000 });
    await sleep(300);
    await shot(phone, '07-stars-after-sensor-home');
    const gotoErr: number[] = [];
    const used: string[] = [];
    for (let k = 0; k < 3; k++) {
      await phone.waitForSelector('.r-suggest li .r-sg-main b', { visible: true, timeout: 15_000 });
      const name = await phone.$eval('.r-suggest li .r-sg-main b', (e) => e.textContent ?? '');
      await tap(phone, '.r-suggest li:first-child button::-p-text(GoTo)');
      await confirmModal(phone);
      const arrived = await waitGoto(obs, name);
      const target = arrived.target!;
      await sleep(1500);
      gotoErr.push(await pointingErr(target, loc));
      log(`star ${k + 1} ${name}: GoTo error ${fmtA(gotoErr[k]!)} (${arrived.alignment.points.length} star(s) in the model)`);
      used.push(name);
      await centreWithMoves(obs, () => targetAltAz(target, loc, Date.now()), 1.5, 5);
      await tap(phone, '.r-suggest li.on button::-p-text(Centred)');
      const st = await obs.until((s) => s.alignment.points.length === k + 1, `alignment point ${k + 1}`, 15_000);
      log(`  point added; RMS ${st.alignment.rmsArcmin?.toFixed(2)}′, solved ${st.alignment.solved.join(',')}`);
      await phone.waitForSelector('.note.settling', { hidden: true, timeout: 5000 }).catch(() => null);
    }
    await shotRemoteFull(phone, '08-aligned');
    const aligned = obs.state!.alignment;
    results.firstStarGotoErrorArcmin = { manualHome: manualErr, manualStar: star.name, manualLevelErrArcmin: levelErr, sensorHome: gotoErr[0], sensorStar: used[0] };
    results.sensorRun = { home, homeAzErrDeg: homeAzErr, homeAltErrDeg: homeAltErr, gotoErrArcmin: gotoErr, stars: used, rmsArcmin: aligned.rmsArcmin, solved: aligned.solved };
    check(gotoErr[0]! < 10 * 60, `first star after sensor Home within ~10° (${fmtA(gotoErr[0]!)})`);
    check(gotoErr[2]! < gotoErr[0]! && gotoErr[2]! < 30, `stars refine it: ${fmtA(gotoErr[0]!)} -> ${fmtA(gotoErr[2]!)} by star 3`);
    check(aligned.quality === 'aligned' && aligned.points.length === 3, '3-star alignment done after a sensor Home');
    check(obs.logs.some((l) => /expect .* within ~\d+°/.test(l)), 'server log tells what to expect for the first GoTo after a sensor Home');

    // ---------------------------------------------------------------- 4. HTTPS + WSS
    obs.send({ type: 'stop' });
    obs.close();
    await phoneBrowser.close();
    await deskBrowser.close();
    server.kill('SIGTERM');
    for (let i = 0; i < 50 && (await up(SERVER)); i++) await sleep(100);
    server = startProc('server-https', ['packages/server/src/main.ts', '--https'], { ...serverEnv, HOST: '0.0.0.0' });
    for (let i = 0; i < 100; i++) {
      const ok = await new Promise<boolean>((resolve) => {
        import('node:https').then((https) => https.get(`${SERVER_TLS}/`, { rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode === 200); }).on('error', () => resolve(false)));
      });
      if (ok) break;
      await sleep(200);
    }
    check(fs.existsSync(path.join(stateDir, 'tls', 'cert.pem')) && fs.existsSync(path.join(stateDir, 'tls', 'ca.crt')), 'HTTPS mode created a local CA + certificate in the state dir');
    const tlsPhoneB = await launch(['--window-size=390,844'], true);
    const tlsPhone = (await tlsPhoneB.pages())[0] ?? (await tlsPhoneB.newPage());
    await tlsPhone.setUserAgent(PHONE_UA);
    await tlsPhone.setViewport(PHONE_VIEWPORT);
    watch('https-phone', tlsPhone);
    const wsUrls: string[] = [];
    const cdp = await tlsPhone.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketCreated', (e: { url: string }) => wsUrls.push(e.url));
    await tlsPhone.goto(`${SERVER_TLS}/?remote`, { waitUntil: 'networkidle0' });
    const tlsDeskB = await launch(['--window-size=1400,900'], true);
    const tlsDesk = (await tlsDeskB.pages())[0] ?? (await tlsDeskB.newPage());
    await tlsDesk.setViewport({ width: 1400, height: 900 });
    watch('https-desktop', tlsDesk);
    await tlsDesk.goto(`${SERVER_TLS}/?panel=status`, { waitUntil: 'networkidle0' });
    await tlsDesk.waitForFunction(() => !document.querySelector('.loading'), { timeout: 20_000 });
    const devices = await tlsPhone.waitForFunction(() => /2 devices/.test(document.querySelector('.r-devices')?.textContent ?? ''), { timeout: 10_000 }).then(() => true).catch(() => false);
    check(wsUrls.some((u) => u.startsWith('wss://127.0.0.1:8080/ws')), `the page on https opens its WebSocket over wss: (${wsUrls.join(', ')})`);
    check(devices, 'state arrives over wss (the phone sees 2 devices)');
    check(await tlsPhone.evaluate(() => window.isSecureContext), 'the https page is a secure context (sensor APIs allowed)');
    await tap(tlsPhone, '.r-tab[data-tab=align]');
    await tap(tlsPhone, 'button::-p-text(Looks right)').catch(() => null);
    check(!!(await tlsPhone.waitForSelector('.step::-p-text(Sensors)', { timeout: 5000 }).catch(() => null)), 'Sensors step available over HTTPS without ?fakeSensors');
    await shot(tlsPhone, '09-https-sensors-step');
    const card = await tlsDesk.$eval('.panel-body', (e) => e.textContent ?? '');
    check(/HTTPS is on/.test(card) && /https:\/\//.test(card) && /Show Details/.test(card), 'desktop Phone remote card shows the https URL and the certificate-warning help');
    const cardEl = await tlsDesk.$('.section:has(.phone-remote), .section:has(.https-help)');
    if (cardEl) await cardEl.scrollIntoView();
    await shot(tlsDesk, '10-https-desktop-phone-remote');
    results.https = { wsUrls };

    results.consoleErrors = consoleErrors;
    results.externalRequests = external;
    check(external.length === 0, `no external network requests (${external.slice(0, 3).join(', ')})`);
    // the https browsers log the self-signed certificate; anything else is an error
    const realErrors = consoleErrors.filter((e) => !/ERR_CERT|net::ERR_|certificate/i.test(e));
    check(realErrors.length === 0, `no browser console errors (${realErrors.slice(0, 3).join(' | ')})`);
  } catch (e) {
    for (const b of browsers) {
      if (!b.connected) continue;
      const pg = (await b.pages())[0];
      if (pg) await pg.screenshot({ path: path.join(OUT, `zz-sensors-failure-${browsers.indexOf(b)}.png`) }).catch(() => {});
    }
    throw e;
  } finally {
    for (const b of browsers) if (b.connected) await b.close().catch(() => {});
    fs.writeFileSync(path.join(OUT, 'e2e-sensors-results.json'), JSON.stringify(results, null, 2));
  }
  console.log(JSON.stringify(results, null, 2));
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else log('all checks passed');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(cleanup);
