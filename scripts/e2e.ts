// End-to-end test: realistic simulator + server + built GUI, driven through headless Chrome (puppeteer-core).
//
//   npm run e2e
//
// Env: CHROME=<path to Chrome/Chromium> (default: the macOS app, else google-chrome/chromium on PATH),
//      E2E_OUT=<dir> for screenshots and results (default e2e-output/), E2E_NO_BUILD=1 to skip `npm run build`,
//      E2E_HEADFUL=1 to watch it run.
// Uses the default ports (simulator 2000/2001, server 8080) because the GUI's "Simulator" preset points there,
// so stop `npm run dev` / `npm start` first.
//
// The script plays the user: it reads the simulator's hidden truth (GET :2001/truth) to know where the tube
// really points, and uses the GUI's slew keys to level/north the tube and to centre alignment stars.
import { type ChildProcess, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type KeyInput, type Page } from 'puppeteer-core';
import type { GeoLocation, MountState, ServerMessage, Target } from '../packages/shared/src/api.ts';
import { type AltAz, separation, separationAltAz, sunAltitude, targetAltAz, targetRaDec } from '../packages/shared/src/astro.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.E2E_OUT || path.join(ROOT, 'e2e-output'));
const SERVER = 'http://127.0.0.1:8080';
const SIM = 'http://127.0.0.1:2001';
const SIM_RATES = [0, 0.008, 0.017, 0.033, 0.067, 0.133, 0.5, 1, 2, 3]; // deg/s per slew rate (simulator default)

type SimStatus = { az: { velocity: number; slewing: boolean }; alt: { velocity: number; slewing: boolean } };
type Truth = { encoder: { az: number; alt: number }; sky: { ra: number; dec: number; az: number; alt: number }; hidden: Record<string, number> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const log = (...a: unknown[]) => console.log(`[e2e ${new Date().toLocaleTimeString()}]`, ...a);
const fmt = (arcmin: number) => `${arcmin.toFixed(1)}′`;

// ---------------------------------------------------------------- processes

const children: ChildProcess[] = [];
function startProc(name: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const p = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(path.join(OUT, `${name}.log`));
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  children.push(p);
  return p;
}
function cleanup() {
  for (const p of children) if (p.exitCode === null) p.kill('SIGTERM');
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

async function portInUse(url: string): Promise<boolean> {
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
    if (await portInUse(url)) return;
    await sleep(200);
  }
  throw new Error(`${url} did not come up`);
}

// ---------------------------------------------------------------- simulator & server observers

const simGet = async <T>(p: string): Promise<T> => (await (await fetch(SIM + p)).json()) as T;
const simPost = (p: string, body: unknown) => fetch(SIM + p, { method: 'POST', body: JSON.stringify(body) });
const truth = () => simGet<Truth>('/truth');
const simStatus = () => simGet<SimStatus>('/status');
const simMoving = (s: SimStatus) => Math.abs(s.az.velocity) > 0.01 || Math.abs(s.alt.velocity) > 0.01;

/** A WebSocket client that mirrors the server state (like a second GUI tab). */
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
      else if (m.type === 'log') this.logs.push(`${m.level}: ${m.message}`);
    };
    await new Promise((r, j) => {
      this.ws.onopen = r;
      this.ws.onerror = j;
    });
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  async until(pred: (s: MountState) => boolean, what: string, ms = 30_000): Promise<MountState> {
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

// ---------------------------------------------------------------- scenario helpers

/** Somewhere it is properly dark right now (prefer Helsinki, the simulator default). */
function darkLocation(now: number): GeoLocation {
  const cands = [{ lat: 60.17, lon: 24.94 }, ...Array.from({ length: 24 }, (_, i) => ({ lat: 45, lon: -180 + i * 15 }))];
  for (const c of cands) {
    const loc: GeoLocation = { ...c, elevation: 0, source: 'manual', label: 'e2e' };
    if (sunAltitude(loc, now) < -15 && sunAltitude(loc, now + 3600e3) < -15) return loc;
  }
  throw new Error('no dark location found');
}

/** Pointing error (arcmin) between where the tube truly points and the target, now. */
async function pointingError(target: Target, loc: GeoLocation): Promise<number> {
  const t = await truth();
  return separation(t.sky, targetRaDec(target, loc, Date.now())) * 60;
}

async function shot(page: Page, name: string) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  log(`screenshot ${file}`);
}

async function click(page: Page, selector: string, timeout = 10_000) {
  const el = await page.waitForSelector(selector, { visible: true, timeout });
  if (!el) throw new Error(`not found: ${selector}`);
  const disabled = await el.evaluate((e) => (e as HTMLButtonElement).disabled === true);
  if (disabled) {
    const why = await el.evaluate((e) => e.closest('[title]')?.getAttribute('title') ?? '');
    throw new Error(`disabled: ${selector}${why ? ` (${why})` : ''}`);
  }
  await el.click();
}

/** Click GoTo/Slew, then confirm the keep-clear notice if it appears. */
async function confirmSlew(page: Page) {
  const modal = await page.waitForSelector('.modal', { visible: true, timeout: 1500 }).catch(() => null);
  if (!modal) return;
  const dontAsk = await page.$('.modal input[type=checkbox]');
  if (dontAsk) await dontAsk.click();
  await click(page, '.modal button.primary');
}

async function blurInputs(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
}

/**
 * Emulate the user at the eyepiece: press the GUI's slew keys until the tube truly points at `want` (from
 * /truth) within `tolArcmin`. Each press is timed from the remaining error and the slew rate. With `confirm`,
 * waits until the position holds (tracking re-anchors ~1.5 s after a manual move); without, returns right
 * after the last press, as a user would before pressing Centred.
 */
async function centreWithKeys(page: Page, want: () => AltAz, tolArcmin: number, maxRate: number, confirm = true): Promise<number> {
  await blurInputs(page);
  let rate = 0;
  for (let i = 0; i < 80; i++) {
    const t = await truth();
    const w = want();
    const err = separationAltAz(t.sky, w) * 60;
    if (err < tolArcmin) {
      if (!confirm) return err;
      await sleep(2000);
      const err2 = separationAltAz((await truth()).sky, want()) * 60;
      if (err2 < tolArcmin) return err2;
      continue;
    }
    const dAz = wrap180(w.az - t.sky.az);
    const dAlt = w.alt - t.sky.alt;
    const azAngular = Math.abs(dAz) * Math.cos((t.sky.alt * Math.PI) / 180);
    const [key, deg]: [KeyInput, number] = azAngular > Math.abs(dAlt) ? [dAz > 0 ? 'ArrowRight' : 'ArrowLeft', Math.abs(dAz)] : [dAlt > 0 ? 'ArrowUp' : 'ArrowDown', Math.abs(dAlt)];
    // fastest rate that still gives a press of at least ~0.7 s (timing jitter then matters little)
    let r = 1;
    for (let k = maxRate; k >= 1; k--) if (deg / SIM_RATES[k]! >= 0.7) { r = k; break; }
    if (r !== rate) {
      await page.keyboard.press(`Digit${r}` as KeyInput);
      rate = r;
    }
    const ms = Math.min(20_000, (deg / SIM_RATES[r]!) * 1000);
    await page.keyboard.down(key);
    await sleep(ms);
    await page.keyboard.up(key);
    await sleep(r >= 6 ? 700 : 400);
  }
  throw new Error('could not centre');
}

/** Pick a bright star that is comfortably placed and not one of `exclude` (for an extra GoTo test). */
function pickTestStar(loc: GeoLocation, exclude: string[], opts: { farFrom?: AltAz } = {}): { name: string; target: Target } | null {
  // name, RA, Dec (J2000)
  const stars: [string, number, number][] = [
    ['Vega', 279.2347, 38.7837], ['Capella', 79.1723, 45.998], ['Arcturus', 213.9153, 19.1824], ['Altair', 297.6958, 8.8683],
    ['Deneb', 310.358, 45.2803], ['Aldebaran', 68.98, 16.5093], ['Betelgeuse', 88.7929, 7.4071], ['Rigel', 78.6345, -8.2016],
    ['Procyon', 114.8255, 5.225], ['Pollux', 116.329, 28.0262], ['Regulus', 152.093, 11.9672], ['Spica', 201.2983, -11.1613],
    ['Antares', 247.3519, -26.432], ['Fomalhaut', 344.4127, -29.6222], ['Dubhe', 165.932, 61.751], ['Mirfak', 51.0807, 49.8612],
    ['Alpheratz', 2.0969, 29.0904], ['Hamal', 31.7934, 23.4624], ['Sirius', 101.2872, -16.7161], ['Kochab', 222.6764, 74.1555],
  ];
  const now = Date.now();
  let best: { name: string; target: Target; score: number } | null = null;
  for (const [name, ra, dec] of stars) {
    if (exclude.includes(name)) continue;
    const target: Target = { kind: 'radec', ra, dec, name };
    const aa = targetAltAz(target, loc, now);
    if (aa.alt < 25 || aa.alt > 60) continue;
    const score = opts.farFrom ? separationAltAz(aa, opts.farFrom) : -Math.abs(aa.alt - 45);
    if (!best || score > best.score) best = { name, target, score };
  }
  return best;
}

async function searchAndSelect(page: Page, name: string) {
  const input = await page.waitForSelector('.search input');
  await input!.click({ count: 3 });
  await input!.type(name);
  await page.waitForSelector('.search-results li', { visible: true });
  await page.keyboard.press('Enter');
  await page.waitForSelector(`.infocard h2::-p-text(${name})`, { visible: true });
}

/** Wait for a new GoTo (target other than `prev`) to start and finish; returns the state on arrival. */
async function waitGoto(obs: Observer, prev: string | undefined, ms = 150_000): Promise<MountState> {
  const started = await obs.until((s) => s.slew.startsWith('goto') && !!s.target && s.target.name !== prev, 'GoTo to start', 10_000);
  const name = started.target!.name;
  return obs.until((s) => s.slew === 'idle' && s.target?.name === name, `arrival at ${name}`, ms);
}

// ---------------------------------------------------------------- main

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const failures: string[] = [];
  const checks: string[] = [];
  const results: Record<string, unknown> = { checks };
  const check = (ok: boolean, what: string) => {
    log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
    checks.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };

  for (const url of [SERVER, SIM]) if (await portInUse(url)) throw new Error(`${url} is already in use: stop npm run dev / npm start first`);
  if (!process.env.E2E_NO_BUILD) {
    log('building the GUI');
    execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  }

  const stateDir = fs.mkdtempSync(path.join(OUT, 'state-'));
  startProc('simulator', ['packages/simulator/src/main.ts', '--realistic']);
  await waitHttp(`${SIM}/config`);
  startProc('server', ['packages/server/src/main.ts'], {
    TELESCOPE_HOST: '127.0.0.1',
    STARGAZER_STATE_FILE: path.join(stateDir, 'state.json'),
    STARGAZER_PACKET_LOG: 'none',
  });
  await waitHttp(SERVER);

  // Where and when: a dark sky, the same for the simulator's truth and the server.
  const loc = darkLocation(Date.now());
  await simPost('/config', { location: { lat: loc.lat, lon: loc.lon } });
  // --realistic randomised the mount errors and orientation; carry it out "roughly north and level" like a user
  // would (a random azimuth would take minutes at the capped pre-Home slew rate).
  const hidden0 = (await truth()).hidden;
  const IA = (((Math.random() * 40 - 20) % 360) + 360) % 360;
  const IE = Math.random() * 20 - 8;
  await simPost('/config', { hidden: { IA, IE } });
  results.location = { lat: loc.lat, lon: loc.lon };
  results.hiddenErrors = { ...hidden0, IA, IE };
  log(`location ${loc.lat}, ${loc.lon}; hidden mount errors ${JSON.stringify(results.hiddenErrors)}`);

  const obs = new Observer();
  await obs.open();
  obs.send({ type: 'setLocation', location: loc });
  await obs.until((s) => s.location?.lat === loc.lat, 'server location');

  const chrome =
    process.env.CHROME ||
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('Chrome not found: set CHROME=/path/to/chrome');
  const browser: Browser = await puppeteer.launch({
    executablePath: chrome,
    headless: !process.env.E2E_HEADFUL,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,900', '--no-first-run'],
    defaultViewport: { width: 1400, height: 900 },
  });
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  const offline: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) offline.push(r.url());
  });

  try {
    // 1. Connect to the simulator preset
    await page.goto(`${SERVER}/?panel=status`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !document.querySelector('.loading'), { timeout: 20_000 });
    await click(page, '.presets .chip::-p-text(Simulator)');
    await click(page, '.conn-row button::-p-text(Connect)');
    await obs.until((s) => s.connection === 'connected', 'telescope connection');
    await sleep(800);
    await shot(page, '01-connected');
    // GoTo must not be offered before Home: the info card explains why
    await searchAndSelect(page, 'Vega');
    const gotoBtn = await page.waitForSelector('.infocard button::-p-text(GoTo)');
    const reason = await page.$eval('.infocard .block-reason', (e) => e.textContent ?? '').catch(() => '');
    check((await gotoBtn!.evaluate((b) => (b as HTMLButtonElement).disabled)) && /Home/.test(reason), `no GoTo before Home ("${reason}")`);
    await shot(page, '01b-goto-blocked-before-home');
    await click(page, '.infocard .icon-btn[aria-label=Close]');

    // 2. Level and north with the slew keys, then Home in the alignment wizard
    await click(page, '.tab::-p-text(Align)');
    await click(page, 'button::-p-text(Looks right)');
    await page.waitForSelector('button::-p-text(Home: tube is level)');
    const homeErr = await centreWithKeys(page, () => ({ az: 0, alt: 0 }), 20, 6);
    log(`tube is ${fmt(homeErr)} from level/north`);
    await click(page, 'button::-p-text(Home: tube is level)');
    await click(page, 'button::-p-text(Yes, set Home)');
    await obs.until((s) => s.alignment.quality === 'rough', 'Home');
    await sleep(500);
    await shot(page, '02-home-done');

    // 3. Three alignment stars: GoTo, centre, Centred
    const gotoErr: number[] = [];
    const used: string[] = [];
    const residuals: (number | undefined)[][] = [];
    const settleMs: number[] = [];
    for (let k = 0; k < 3; k++) {
      await page.waitForSelector('.suggest li .sg-name', { visible: true });
      const name = await page.$eval('.suggest li .sg-name', (e) => e.textContent ?? '');
      await click(page, '.suggest li');
      await click(page, 'button::-p-text(Slew there)');
      await confirmSlew(page);
      if (k === 0) {
        await obs.until((s) => s.slew.startsWith('goto'), 'slew start', 10_000);
        await sleep(1000);
        await shot(page, '03-star1-slewing');
      }
      const arrived = await waitGoto(obs, used.at(-1) ?? undefined);
      const target = arrived.target!;
      await sleep(1500);
      gotoErr.push(await pointingError(target, loc));
      log(`star ${k + 1} ${name}: GoTo error ${fmt(gotoErr[k]!)} (model: ${arrived.alignment.quality}, ${arrived.alignment.points.length} star(s))`);
      used.push(name, target.name);
      const centred = await centreWithKeys(page, () => targetAltAz(target, loc, Date.now()), 1.5, 5, false);
      log(`  centred within ${fmt(centred)}`);
      const tCentred = Date.now();
      await click(page, 'button::-p-text(Centred)');
      const settling = await page.waitForSelector('.note.settling', { visible: true, timeout: 2000 }).catch(() => null);
      check(!!settling, `star ${k + 1}: "Settling…" shown while the server waits before capture`);
      if (k === 0 && settling) await shot(page, '04-settling');
      const st = await obs.until((s) => s.alignment.points.length === k + 1, `alignment point ${k + 1}`, 15_000);
      settleMs.push(Date.now() - tCentred);
      const trueErrAtCapture = (await pointingError(target, loc)).toFixed(1);
      log(`  captured ${settleMs.at(-1)} ms after Centred (tube ${trueErrAtCapture}′ from the star)`);
      residuals.push(st.alignment.points.map((p) => p.residualArcmin));
      log(`  point added; RMS ${st.alignment.rmsArcmin?.toFixed(2)}′, solved ${st.alignment.solved.join(',')}`);
      await page.waitForSelector('.note.settling', { hidden: true, timeout: 3000 });
    }
    await sleep(500);
    await shot(page, '05-aligned-3-stars');
    const aligned = obs.state!.alignment;
    results.alignment = { captureDelayMs: settleMs, rmsArcmin: aligned.rmsArcmin, solved: aligned.solved, residualsArcmin: residuals.at(-1), params: aligned.params };

    // 4. A fresh test target (search + info card GoTo)
    const test = pickTestStar(loc, used);
    if (!test) throw new Error('no test star available');
    await searchAndSelect(page, test.name);
    await click(page, '.infocard button::-p-text(GoTo)');
    await confirmSlew(page);
    const prevTarget = obs.state!.target?.name;
    await waitGoto(obs, prevTarget === test.name ? undefined : prevTarget);
    await sleep(1500);
    const testErr = await pointingError(test.target, loc);
    await shot(page, '06-test-target');
    log(`test target ${test.name}: GoTo error ${fmt(testErr)}`);
    results.gotoErrorArcmin = { star1_homeOnly: gotoErr[0], star2_after1: gotoErr[1], star3_after2: gotoErr[2], testTarget_after3: testErr, testTarget: test.name };
    check(testErr < gotoErr[0]!, `GoTo accuracy improves: ${fmt(gotoErr[0]!)} (Home only) -> ${fmt(testErr)} (3 stars)`);
    check(testErr < 10, `GoTo after a 3-star alignment lands within 10′ (${fmt(testErr)})`);
    await click(page, '.infocard .icon-btn[aria-label=Close]');

    // 5. GoTo a "Tonight" object and check tracking
    await click(page, '.tab::-p-text(Tonight)');
    await click(page, '.seg button::-p-text(Up now)');
    await page.waitForSelector('.tonight-item');
    const idx = await page.$$eval('.tonight-item', (items) =>
      items.findIndex((li) => {
        const m = /now (\d+)°/.exec(li.querySelector('.ti-meta')?.textContent ?? '');
        const btn = li.querySelector('button');
        return !!m && Number(m[1]) >= 25 && Number(m[1]) <= 60 && !!btn && !btn.disabled;
      }),
    );
    if (idx < 0) throw new Error('no Tonight object with an enabled GoTo between 25° and 60°');
    const items = await page.$$('.tonight-item');
    const tonightName = await items[idx]!.$eval('.ti-name', (e) => e.textContent ?? '');
    await (await items[idx]!.$('button'))!.click();
    await confirmSlew(page);
    const tonightTarget = (await waitGoto(obs, test.name)).target!;
    await sleep(1500);
    const t0 = await truth();
    const tonightErr = separation(t0.sky, targetRaDec(tonightTarget, loc, Date.now())) * 60;
    log(`Tonight object ${tonightName}: GoTo error ${fmt(tonightErr)}; checking tracking for 30 s`);
    await shot(page, '07-tonight-tracking');
    await sleep(30_000);
    const t1 = await truth();
    const drift = separation(t0.sky, t1.sky) * 60;
    const err30 = separation(t1.sky, targetRaDec(tonightTarget, loc, Date.now())) * 60;
    results.tracking = { object: tonightName, gotoErrorArcmin: tonightErr, driftArcminOver30s: drift, errorAfter30sArcmin: err30, tracking: obs.state!.tracking };
    log(`tracking: drift ${fmt(drift)} over 30 s, error ${fmt(tonightErr)} -> ${fmt(err30)}`);
    check(obs.state!.tracking, 'tracking is on after the GoTo');
    check(drift < 1, `tracking holds the object (drift ${fmt(drift)} < 1′ over 30 s)`);

    // 6. STOP during a GoTo
    const here = (await truth()).sky;
    const far = pickTestStar(loc, [...used, test.name], { farFrom: here });
    if (!far) throw new Error('no far target for the STOP test');
    await searchAndSelect(page, far.name);
    await click(page, '.infocard button::-p-text(GoTo)');
    await confirmSlew(page);
    await obs.until((s) => s.slew === 'goto-fast', 'fast slew', 10_000);
    for (let i = 0; i < 40 && !simMoving(await simStatus()); i++) await sleep(100);
    await sleep(1200);
    const before = await simStatus();
    await shot(page, '08-goto-before-stop');
    const tStop = Date.now();
    await click(page, '.stop-btn');
    let stopLatency = NaN;
    for (;;) {
      const s = await simStatus();
      if (!simMoving(s)) { stopLatency = Date.now() - tStop; break; }
      if (Date.now() - tStop > 10_000) break;
      await sleep(25);
    }
    const afterStop = await obs.until((s) => s.slew === 'idle', 'idle after STOP', 5000);
    await sleep(800);
    await shot(page, '09-after-stop');
    results.stop = { speedBeforeDegPerSec: Math.max(Math.abs(before.az.velocity), Math.abs(before.alt.velocity)), latencyMs: stopLatency, trackingAfter: afterStop.tracking };
    log(`STOP: mount at rest ${stopLatency} ms after the click (was moving at ${(results.stop as { speedBeforeDegPerSec: number }).speedBeforeDegPerSec.toFixed(2)}°/s)`);
    check(stopLatency < 3000, `STOP during GoTo halts the mount quickly (${stopLatency} ms)`);
    check(!afterStop.tracking, 'STOP also ends tracking');

    // 7. Dead-man: kill the browser in the middle of a manual move
    await blurInputs(page);
    await page.keyboard.press('Digit8');
    await page.keyboard.down('ArrowRight');
    for (let i = 0; i < 40 && Math.abs((await simStatus()).az.velocity) < 1; i++) await sleep(100);
    const moving = await simStatus();
    check(Math.abs(moving.az.velocity) >= 1, `manual slew via keyboard runs (${moving.az.velocity.toFixed(2)}°/s)`);
    const tKill = Date.now();
    browser.process()?.kill('SIGKILL');
    let deadman = NaN;
    for (;;) {
      if (!simMoving(await simStatus())) { deadman = Date.now() - tKill; break; }
      if (Date.now() - tKill > 5000) break;
      await sleep(25);
    }
    results.deadman = { latencyMs: deadman };
    log(`dead-man: mount at rest ${deadman} ms after the browser was killed`);
    check(deadman < 1500, `server stops a manual move when the browser dies (${deadman} ms)`);

    results.serverErrors = obs.errors;
    results.consoleErrors = consoleErrors;
    results.externalRequests = offline;
    check(offline.length === 0, `no external network requests (${offline.length})`);
    check(consoleErrors.length === 0, `no browser console errors (${consoleErrors.slice(0, 3).join(' | ')})`);
    obs.close();
  } catch (e) {
    await shot(page, 'zz-failure').catch(() => {});
    throw e;
  } finally {
    if (browser.connected) await browser.close().catch(() => {});
    fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify(results, null, 2));
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
