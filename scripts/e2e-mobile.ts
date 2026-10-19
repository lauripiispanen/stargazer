// Mobile end-to-end smoke test: the phone remote and the laptop UI on one server, driven through two headless
// Chrome instances (two "devices"): an iPhone-sized touch browser and a desktop browser.
//
//   npm run e2e:mobile
//
// Covers: auto layout selection (no ?remote), the phone never downloading three.js, device count, connect +
// Home from the phone, touch slewing with the dead-man heartbeat, add-to-list on the phone showing up on the
// laptop, GoTo + STOP from the phone, the layout toggle, and per-client disconnect: the phone is killed
// mid-move while the laptop also moves another axis; only the phone's axis must stop.
// Screenshots of every phone tab (light + night) go to E2E_SHOTS (default <E2E_OUT>/mobile).
//
// Env: CHROME, E2E_OUT (default e2e-output/), E2E_SHOTS, E2E_NO_BUILD=1, E2E_HEADFUL=1 (see scripts/e2e.ts).
// Uses ports 2000/2001/8080: stop `npm run dev` / `npm start` first.
import { type ChildProcess, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { GeoLocation, MountState, ObservingListEntry, ServerMessage, Target } from '../packages/shared/src/api.ts';
import { sunAltitude, targetAltAz } from '../packages/shared/src/astro.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.E2E_OUT || path.join(ROOT, 'e2e-output'));
const SHOTS = path.resolve(process.env.E2E_SHOTS || path.join(OUT, 'mobile'));
const SERVER = 'http://127.0.0.1:8080';
const SIM = 'http://127.0.0.1:2001';

type SimStatus = { az: { velocity: number; slewing: boolean }; alt: { velocity: number; slewing: boolean } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(`[e2e-mobile ${new Date().toLocaleTimeString()}]`, ...a);

// ---------------------------------------------------------------- processes

const children: ChildProcess[] = [];
function startProc(name: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const p = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(path.join(OUT, `mobile-${name}.log`));
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
const simStatus = async () => (await (await fetch(`${SIM}/status`)).json()) as SimStatus;
const simPost = (p: string, body: unknown) => fetch(SIM + p, { method: 'POST', body: JSON.stringify(body) });

/** A plain WebSocket client mirroring the server (a third "device" that only watches). */
class Observer {
  state: MountState | null = null;
  list: ObservingListEntry[] = [];
  errors: string[] = [];
  private ws!: WebSocket;
  async open() {
    this.ws = new WebSocket(SERVER.replace('http', 'ws') + '/ws');
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.type === 'state') this.state = m.state;
      else if (m.type === 'list') this.list = m.entries;
      else if (m.type === 'error') this.errors.push(m.message);
    };
    await new Promise((r, j) => {
      this.ws.onopen = r;
      this.ws.onerror = j;
    });
  }
  send(m: unknown) {
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
    if (sunAltitude(loc, now) < -15 && sunAltitude(loc, now + 3600e3) < -15) return loc;
  }
  throw new Error('no dark location found');
}

/** A bright star 25–60° up (for a GoTo that is allowed and takes a while). */
function pickStar(loc: GeoLocation): { name: string; target: Target } {
  const stars: [string, number, number][] = [
    ['Vega', 279.2347, 38.7837], ['Capella', 79.1723, 45.998], ['Arcturus', 213.9153, 19.1824], ['Altair', 297.6958, 8.8683],
    ['Deneb', 310.358, 45.2803], ['Aldebaran', 68.98, 16.5093], ['Betelgeuse', 88.7929, 7.4071], ['Procyon', 114.8255, 5.225],
    ['Pollux', 116.329, 28.0262], ['Regulus', 152.093, 11.9672], ['Spica', 201.2983, -11.1613], ['Dubhe', 165.932, 61.751],
    ['Mirfak', 51.0807, 49.8612], ['Alpheratz', 2.0969, 29.0904], ['Hamal', 31.7934, 23.4624], ['Fomalhaut', 344.4127, -29.6222],
  ];
  let best: { name: string; target: Target; score: number } | null = null;
  for (const [name, ra, dec] of stars) {
    const target: Target = { kind: 'radec', ra, dec, name };
    const aa = targetAltAz(target, loc, Date.now());
    if (aa.alt < 25 || aa.alt > 60) continue;
    // far from north/level (where Home leaves the tube) so the GoTo is still running when we press STOP
    const score = Math.abs(((aa.az + 180) % 360) - 180) + aa.alt;
    if (!best || score > best.score) best = { name, target, score };
  }
  if (!best) throw new Error('no GoTo star available');
  return best;
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

/** Press and hold an element with a real touch (touchstart ... touchend), returning a release function. */
async function touchHold(page: Page, selector: string): Promise<() => Promise<void>> {
  const el = await page.waitForSelector(selector, { visible: true });
  await el!.scrollIntoView();
  const box = (await el!.boundingBox())!;
  await page.touchscreen.touchStart(box.x + box.width / 2, box.y + box.height / 2);
  return () => page.touchscreen.touchEnd();
}

async function shot(page: Page, name: string, dir = SHOTS) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file });
  log(`screenshot ${file}`);
}

/** Layout problems a reviewer would flag: horizontal overflow, tiny tap targets, STOP hidden. */
async function layoutAudit(page: Page, label: string): Promise<string[]> {
  return page.evaluate((label) => {
    const issues: string[] = [];
    const vw = document.documentElement.clientWidth;
    const main = document.querySelector('.r-main');
    if (main && main.scrollWidth > main.clientWidth + 1) issues.push(`${label}: content overflows horizontally (${main.scrollWidth} > ${main.clientWidth})`);
    // (no helper functions in here: tsx would wrap them in a __name() call that doesn't exist in the page)
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.r-app button, .r-app input'))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.closest('.modal') || el.offsetParent === null) continue;
      let scroller = false; // inside a horizontally scrollable strip (e.g. filter chips): overflow is intended
      for (let p = el.parentElement; p && p !== main; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) { scroller = true; break; }
      }
      if (scroller) continue;
      if (r.right > vw + 1) issues.push(`${label}: "${(el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30)}" sticks out of the screen`);
      const small = Math.min(r.width, r.height) < 34;
      if (small && !el.closest('.toggle')) issues.push(`${label}: small tap target "${(el.getAttribute('aria-label') || el.textContent || el.className).trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    const stop = document.querySelector('.r-stop');
    if (stop) {
      const r = stop.getBoundingClientRect();
      if (r.bottom > window.innerHeight || r.top < 0 || r.height < 44) issues.push(`${label}: STOP not fully visible`);
    }
    return issues;
  }, label);
}

const PHONE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const failures: string[] = [];
  const checks: string[] = [];
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
  const stateDir = fs.mkdtempSync(path.join(OUT, 'mobile-state-'));
  startProc('simulator', ['packages/simulator/src/main.ts']);
  await waitHttp(`${SIM}/config`);
  startProc('server', ['packages/server/src/main.ts'], { TELESCOPE_HOST: '127.0.0.1', STARGAZER_STATE_FILE: path.join(stateDir, 'state.json'), STARGAZER_PACKET_LOG: 'none' });
  await waitHttp(SERVER);

  const loc = darkLocation(Date.now());
  await simPost('/config', { location: { lat: loc.lat, lon: loc.lon } });
  const obs = new Observer();
  await obs.open();
  obs.send({ type: 'setLocation', location: loc });
  await obs.until((s) => s.location?.lat === loc.lat, 'server location');

  const chrome =
    process.env.CHROME ||
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('Chrome not found: set CHROME=/path/to/chrome');
  const launch = async (args: string[]) => {
    const b = await puppeteer.launch({ executablePath: chrome, headless: !process.env.E2E_HEADFUL, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', ...args], defaultViewport: null });
    browsers.push(b);
    return b;
  };
  // Two separate browsers = two devices (independent focus, like a laptop and a phone).
  const desktopBrowser = await launch(['--window-size=1400,900']);
  const phoneBrowser = await launch(['--window-size=390,844']);
  const desk = (await desktopBrowser.pages())[0] ?? (await desktopBrowser.newPage());
  await desk.setViewport({ width: 1400, height: 900 });
  const phone = (await phoneBrowser.pages())[0] ?? (await phoneBrowser.newPage());
  await phone.setUserAgent(PHONE_UA);
  await phone.setViewport(PHONE_VIEWPORT);

  const consoleErrors: string[] = [];
  const external: string[] = [];
  const phoneAssets: string[] = [];
  for (const [name, page] of [['desktop', desk], ['phone', phone]] as const) {
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${name}: ${m.text()}`));
    page.on('pageerror', (e) => consoleErrors.push(`${name}: ${String(e)}`));
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) external.push(r.url());
      if (name === 'phone' && u.pathname.startsWith('/assets/')) phoneAssets.push(u.pathname);
    });
  }

  const results: Record<string, unknown> = { checks };
  let phoneAlive = true;
  try {
    // ---- 1. both devices open the same URL; the phone gets the remote by itself
    await desk.goto(`${SERVER}/?panel=status`, { waitUntil: 'networkidle0' });
    await desk.waitForFunction(() => !document.querySelector('.loading'), { timeout: 20_000 });
    await phone.goto(`${SERVER}/`, { waitUntil: 'networkidle0' });
    check(!!(await phone.$('.r-app')), 'phone-sized touch browser gets the remote layout without ?remote');
    check(!!(await desk.$('.topbar')), 'desktop browser gets the full layout');
    await phone.waitForSelector('.r-devices', { visible: true, timeout: 5000 }).catch(() => null);
    const devicesText = await phone.$eval('.r-devices', (e) => e.textContent ?? '').catch(() => '');
    check(/3 devices/.test(devicesText), `phone shows the connected-devices count ("${devicesText.trim()}": laptop, phone, test observer)`);
    check(!!(await desk.$('.devices')), 'desktop shows the connected-devices count');
    const phoneRemoteCard = await desk.$eval('.panel-body', (e) => e.textContent ?? '');
    check(/Phone remote/.test(phoneRemoteCard) && /start:lan/.test(phoneRemoteCard), 'desktop status pane explains how to enable the phone remote (server on 127.0.0.1)');

    // ---- 2. connect and Home from the phone
    await tap(phone, '.r-preset::-p-text(Simulator)');
    await tap(phone, 'button::-p-text(Connect)');
    await obs.until((s) => s.connection === 'connected', 'telescope connection', 15_000);
    await phone.waitForSelector('.r-stop', { visible: true, timeout: 5000 });
    check(true, 'STOP appears on the phone once connected');
    await tap(phone, '.r-tab[data-tab=align]');
    await tap(phone, 'button::-p-text(Looks right)');
    // the Sensors step comes first where the page can read sensors (localhost is a secure context): go manual
    const manual = await phone.waitForSelector('button::-p-text(by hand instead)', { visible: true, timeout: 3000 }).catch(() => null);
    check(!!manual, 'phone offers the Sensors step first, with a manual alternative');
    if (manual) await tap(phone, 'button::-p-text(by hand instead)');
    await tap(phone, 'button::-p-text(Home: level)');
    await tap(phone, 'button::-p-text(Yes, set Home)');
    await obs.until((s) => s.alignment.quality === 'rough', 'Home from the phone');
    check(true, 'Home set from the phone alignment wizard');

    // ---- 3. touch slew (press and hold) with haptics-capable pad
    await tap(phone, '.r-tab[data-tab=control]');
    await tap(phone, '.r-rate-preset::-p-text(Find)');
    const az0 = obs.state!.encoder!.az;
    let release = await touchHold(phone, '.r-pad-key[data-dir=right]');
    let moving = false;
    for (let i = 0; i < 30 && !moving; i++) { moving = Math.abs((await simStatus()).az.velocity) > 0.1; await sleep(100); }
    check(moving && obs.state!.slew === 'manual', 'touch-and-hold on the phone pad slews the mount');
    await sleep(2000); // > 3 dead-man windows: the heartbeat keeps it going
    check(Math.abs((await simStatus()).az.velocity) > 0.1, 'held touch keeps moving past the dead-man window (heartbeats)');
    await release();
    const tRel = Date.now();
    let stoppedAfter = NaN;
    while (Date.now() - tRel < 3000) { if (Math.abs((await simStatus()).az.velocity) < 0.01) { stoppedAfter = Date.now() - tRel; break; } await sleep(25); }
    check(stoppedAfter < 1500, `lifting the finger stops the axis (${stoppedAfter} ms)`);
    const moved = Math.abs((((obs.state!.encoder!.az - az0) % 360) + 540) % 360 - 180);
    check(moved > 0.3, `azimuth changed by ${moved.toFixed(2)}°`);

    // ---- 4. add to the observing list from the phone; it appears on the laptop
    await tap(phone, '.r-tab[data-tab=search]');
    await phone.type('.r-search input', 'M13');
    await phone.waitForSelector('.r-result', { visible: true });
    await tap(phone, '.r-result .add-list');
    await obs.until(() => obs.list.length === 1, 'list entry', 5000).catch(() => null);
    const listName = obs.list[0]?.name ?? '';
    check(/Hercules|M13|M 13/i.test(listName + (obs.list[0]?.target.kind === 'radec' ? obs.list[0]?.target.id ?? '' : '')), `phone added "${listName}" to the shared list`);
    await desk.click('.tab::-p-text(List)');
    const deskHas = await desk.waitForSelector(`.obs-item .obs-name::-p-text(${listName})`, { visible: true, timeout: 5000 }).catch(() => null);
    check(!!deskHas, 'the laptop shows the entry the phone added');
    // laptop adds one too (Tonight panel / info card path is covered by the desktop UI); the phone sees it
    obs.send({ type: 'listAdd', target: { kind: 'body', body: 'Jupiter', name: 'Jupiter' } });
    obs.send({ type: 'listAdd', target: { kind: 'radec', ra: 10.6847, dec: 41.2687, name: 'Andromeda Galaxy', id: 'M31' } });
    await tap(phone, '.r-tab[data-tab=list]');
    check(!!(await phone.waitForSelector('.obs-item .obs-name::-p-text(Andromeda)', { visible: true, timeout: 5000 }).catch(() => null)), 'the phone list updates live when another device adds entries');
    await tap(phone, `.obs-item[data-id="${obs.list[0]!.id}"] .obs-check`);
    await phone.waitForSelector('.obs-edit textarea', { visible: true });
    await phone.type('.obs-edit textarea', 'Resolved to the core at 120x');
    await tap(phone, 'button::-p-text(Save note)');
    await sleep(500);
    check(!!obs.list[0]?.observedAt && obs.list[0]?.note === 'Resolved to the core at 120x', 'mark observed with a note from the phone');

    // ---- 5. GoTo from phone search (keep-clear modal), then STOP from the phone
    const star = pickStar(loc);
    await tap(phone, '.r-tab[data-tab=search]');
    await phone.$eval('.r-search input', (e) => { (e as HTMLInputElement).value = ''; });
    await phone.click('.r-search input', { count: 3 });
    await phone.type('.r-search input', star.name);
    await phone.waitForSelector(`.r-result .r-res-name::-p-text(${star.name})`, { visible: true });
    const altShown = await phone.$eval('.r-result .vis', (e) => e.textContent ?? '');
    check(/\d+°/.test(altShown), `search result shows altitude and visibility ("${altShown.trim()}")`);
    await tap(phone, '.r-result .r-goto');
    await phone.waitForSelector('.modal', { visible: true, timeout: 3000 });
    await shot(phone, 'phone-goto-confirm');
    await tap(phone, '.modal button.primary');
    await obs.until((s) => s.slew === 'goto-fast' || s.slew === 'goto-slow', 'GoTo from the phone', 10_000);
    for (let i = 0; i < 30 && Math.max(Math.abs((await simStatus()).az.velocity), Math.abs((await simStatus()).alt.velocity)) < 0.5; i++) await sleep(100);
    await sleep(500);
    await tap(phone, '.r-tab[data-tab=control]');
    await shot(phone, 'phone-goto-moving');
    const tStop = Date.now();
    await tap(phone, '.r-stop');
    let stopMs = NaN;
    while (Date.now() - tStop < 5000) {
      const s = await simStatus();
      if (Math.abs(s.az.velocity) < 0.01 && Math.abs(s.alt.velocity) < 0.01) { stopMs = Date.now() - tStop; break; }
      await sleep(25);
    }
    await obs.until((s) => s.slew === 'idle', 'idle after phone STOP', 5000);
    check(stopMs < 3000, `STOP on the phone halts a GoTo (${stopMs} ms)`);
    results.phoneStopMs = stopMs;

    // ---- 6. screenshots of every tab, light and night, with a layout audit
    await phone.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    const audit: string[] = [];
    for (const night of [false, true]) {
      const isNight = await phone.evaluate(() => document.documentElement.classList.contains('night'));
      if (isNight !== night) await tap(phone, '.r-header .r-icon');
      const suffix = night ? 'night' : 'light';
      for (const tab of ['control', 'search', 'tonight', 'list', 'align', 'settings']) {
        await tap(phone, `.r-tab[data-tab=${tab}]`);
        if (tab === 'search') {
          await phone.click('.r-search input', { count: 3 });
          await phone.type('.r-search input', 'M');
          await phone.waitForSelector('.r-result', { visible: true });
          await phone.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
        }
        if (tab === 'tonight') await phone.waitForSelector('.tonight-item', { visible: true, timeout: 10_000 }).catch(() => null);
        if (tab === 'align') await phone.waitForSelector('.r-suggest li', { visible: true, timeout: 10_000 }).catch(() => null);
        await sleep(700);
        await shot(phone, `${tab}-${suffix}`);
        audit.push(...(await layoutAudit(phone, `${tab}/${suffix}`)));
        if (tab === 'control' || tab === 'tonight') {
          // the rest of the page, scrolled
          await phone.$eval('.r-main', (e) => e.scrollTo(0, e.scrollHeight));
          await sleep(400);
          await shot(phone, `${tab}-${suffix}-scrolled`);
          await phone.$eval('.r-main', (e) => e.scrollTo(0, 0));
        }
      }
    }
    if (await phone.evaluate(() => document.documentElement.classList.contains('night'))) await tap(phone, '.r-header .r-icon');
    results.layoutAudit = audit;
    check(audit.length === 0, `phone layout audit: no overflow, tiny targets or hidden STOP${audit.length ? ` (${audit.slice(0, 6).join(' | ')})` : ''}`);
    await shot(desk, 'desktop-list-panel', SHOTS);
    await desk.click('.tab::-p-text(Status)');
    await sleep(300);
    await shot(desk, 'desktop-status-phone-remote', SHOTS);

    // the phone must not have loaded the 3D sky map
    const heavy = phoneAssets.filter((a) => /\/(three|DesktopApp|SkyRenderer)[-.]/.test(a));
    results.phoneAssets = [...new Set(phoneAssets)];
    check(heavy.length === 0, `the phone did not download three.js / the desktop sky map (${heavy.join(', ') || 'none'})`);

    // ---- 7. layout toggle on the laptop: desktop -> remote -> desktop
    await desk.click('.layout-btn');
    await desk.waitForSelector('.r-app', { visible: true, timeout: 5000 });
    await desk.click('.r-tab[data-tab=settings]');
    await desk.click('button::-p-text(Use the full desktop layout)');
    check(!!(await desk.waitForSelector('.topbar', { visible: true, timeout: 10_000 }).catch(() => null)), 'layout toggle switches desktop -> remote -> desktop');
    await desk.waitForFunction(() => !document.querySelector('.loading'), { timeout: 20_000 });

    // ---- 8. phone dies mid-move while the laptop moves the other axis: only the phone's axis stops
    await desk.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await desk.keyboard.press('Digit6');
    await desk.keyboard.down('ArrowUp'); // laptop: altitude
    await tap(phone, '.r-tab[data-tab=control]');
    release = await touchHold(phone, '.r-pad-key[data-dir=left]'); // phone: azimuth
    let both = false;
    for (let i = 0; i < 40 && !both; i++) { const s = await simStatus(); both = Math.abs(s.az.velocity) > 0.1 && Math.abs(s.alt.velocity) > 0.1; await sleep(100); }
    check(both, 'laptop (alt, keyboard) and phone (az, touch) move different axes at the same time');
    await sleep(500);
    const tKill = Date.now();
    phoneBrowser.process()?.kill('SIGKILL');
    phoneAlive = false;
    let azStop = NaN;
    while (Date.now() - tKill < 4000) { if (Math.abs((await simStatus()).az.velocity) < 0.01) { azStop = Date.now() - tKill; break; } await sleep(25); }
    check(azStop < 1500, `the phone's axis (az) stops when the phone disappears (${azStop} ms)`);
    await sleep(1200);
    const after = await simStatus();
    check(Math.abs(after.alt.velocity) > 0.1, `the laptop's axis (alt) keeps moving (${after.alt.velocity.toFixed(2)}°/s)`);
    check(obs.state!.slew === 'manual', 'mount still in a manual move for the laptop');
    await desk.keyboard.up('ArrowUp');
    await obs.until((s) => s.slew === 'idle', 'laptop release', 3000);
    let altStopped = false;
    for (let i = 0; i < 40 && !altStopped; i++) { altStopped = Math.abs((await simStatus()).alt.velocity) < 0.01; await sleep(50); }
    check(altStopped, 'laptop key-up stops its axis');
    await obs.until((s) => s.clients === 2, 'client count after the phone left', 5000).catch(() => null);
    check(obs.state!.clients === 2, `device count drops when the phone leaves (${obs.state!.clients})`);
    results.disconnect = { azStopMs: azStop, altVelocityAfter: after.alt.velocity };

    results.consoleErrors = consoleErrors;
    results.externalRequests = external;
    check(external.length === 0, `no external network requests (${external.length})`);
    check(consoleErrors.length === 0, `no browser console errors (${consoleErrors.slice(0, 3).join(' | ')})`);
    obs.send({ type: 'stop' });
    obs.close();
  } catch (e) {
    if (phoneAlive) await shot(phone, 'zz-failure-phone', OUT).catch(() => {});
    await shot(desk, 'zz-failure-desktop', OUT).catch(() => {});
    throw e;
  } finally {
    for (const b of browsers) if (b.connected) await b.close().catch(() => {});
    fs.writeFileSync(path.join(OUT, 'e2e-mobile-results.json'), JSON.stringify(results, null, 2));
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
