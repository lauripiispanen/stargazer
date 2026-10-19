// Manual slew controller: merges on-screen pad, keyboard and gamepad into per-axis motion and sends
// move/stopAxis. Dead-man (SAFETY.md §2.4): while an axis moves, the same `move` is re-sent every 200 ms;
// the server stops the axis after 600 ms of silence. Any loss of focus/visibility/link stops immediately.
import { useStore } from './store.ts';
import { HEARTBEAT_MS } from '../lib/safety.ts';
import { diffMotion, isMoving, keyAction, mergeMotion, motionFromDirs, readGamepad, STILL, type Dir, type Motion } from '../lib/slewInput.ts';
import type { Axis, ClientMessage } from '@stargazer/shared/api.ts';

const padHeld = new Set<Dir>();
const keysHeld = new Set<Dir>();
let gpMotion: Motion = STILL;
let sent: Motion = STILL;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let started = false;
let listeners: (() => void)[] = [];
const subs = new Set<() => void>();

function send(m: ClientMessage) { useStore.getState().transport?.send(m); }

function canMove(): boolean {
  const st = useStore.getState();
  return st.link === 'open' && st.mount?.connection === 'connected';
}

function update() {
  const rate = useStore.getState().slewRate;
  let next = mergeMotion(motionFromDirs([...padHeld, ...keysHeld], rate), gpMotion);
  if (!canMove()) next = STILL;
  const cmds = diffMotion(sent, next);
  for (const c of cmds) send(c);
  if (cmds.length) useStore.setState({ lastCommandAt: Date.now() });
  sent = next;
  if (isMoving(sent) && !heartbeat) {
    heartbeat = setInterval(() => {
      for (const axis of ['az', 'alt'] as Axis[]) {
        const m = sent[axis];
        if (m) send({ type: 'move', axis, direction: m.direction, rate: m.rate });
      }
    }, HEARTBEAT_MS);
  } else if (!isMoving(sent) && heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  subs.forEach((f) => f());
}

/** Release every held input and stop moving axes immediately. */
export function releaseAll() {
  const wasMoving = isMoving(sent);
  padHeld.clear(); keysHeld.clear(); gpMotion = STILL;
  for (const axis of ['az', 'alt'] as Axis[]) if (sent[axis]) send({ type: 'stopAxis', axis });
  sent = STILL;
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  if (wasMoving) subs.forEach((f) => f());
}

export function padPress(d: Dir) { padHeld.add(d); useStore.setState({ lastSlewPress: Date.now() }); update(); }
export function padRelease(d: Dir) { padHeld.delete(d); update(); }
export function heldDirs(): Set<Dir> { return new Set([...padHeld, ...keysHeld]); }
export function currentMotion(): Motion { return sent; }
export function subscribeMotion(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export function startSlewController() {
  if (started) return;
  started = true;
  const onKeyDown = (e: KeyboardEvent) => {
    const a = keyAction(e.code);
    if (!a) return;
    if (a.kind === 'stop') {
      // Esc always stops; Space stops unless the user is typing text
      if (e.code === 'Space' && isTyping(e)) return;
      e.preventDefault();
      releaseAll();
      if (!e.repeat) useStore.getState().stopAll();
      return;
    }
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.modal-backdrop')) return;
    e.preventDefault();
    if (a.kind === 'rate') { useStore.getState().setSlewRate(a.rate); return; }
    if (e.repeat) return;
    keysHeld.add(a.dir); useStore.setState({ lastSlewPress: Date.now() }); update();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const a = keyAction(e.code);
    if (a?.kind === 'move' && keysHeld.delete(a.dir)) update();
  };
  const onBlur = () => releaseAll();
  const onVis = () => { if (document.visibilityState !== 'visible') releaseAll(); };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pagehide', onBlur);
  document.addEventListener('visibilitychange', onVis);
  // rate change while held -> resend; link/telescope loss -> release
  const unsub = useStore.subscribe((s, p) => {
    if (s.slewRate !== p.slewRate && isMoving(sent)) update();
    if ((s.link !== 'open' && p.link === 'open') || (s.mount?.connection !== 'connected' && p.mount?.connection === 'connected')) releaseAll();
  });

  // ---- gamepad ----
  let raf = 0;
  let prevButtons = { stop: false, rateUp: false, rateDown: false };
  const poll = () => {
    raf = requestAnimationFrame(poll);
    const pads = navigator.getGamepads?.() ?? [];
    const gp = [...pads].find((p): p is Gamepad => !!p && p.connected);
    if (!gp) { if (isMoving(gpMotion)) { gpMotion = STILL; update(); } return; }
    if (!document.hasFocus()) return;
    const st = useStore.getState();
    const r = readGamepad(gp, st.slewRate);
    if (r.stop && !prevButtons.stop) { releaseAll(); st.stopAll(); }
    if (r.rateUp && !prevButtons.rateUp) st.setSlewRate(st.slewRate + 1);
    if (r.rateDown && !prevButtons.rateDown) st.setSlewRate(st.slewRate - 1);
    prevButtons = { stop: r.stop, rateUp: r.rateUp, rateDown: r.rateDown };
    const m = r.stop ? STILL : r.motion;
    if (JSON.stringify(m) !== JSON.stringify(gpMotion)) { gpMotion = m; if (isMoving(m)) useStore.setState({ lastSlewPress: Date.now() }); update(); }
  };
  const onGpConnect = (e: GamepadEvent) => { useStore.getState().toast('info', `Gamepad connected: ${e.gamepad.id.slice(0, 40)}`); if (!raf) raf = requestAnimationFrame(poll); };
  const onGpDisconnect = () => { gpMotion = STILL; update(); useStore.getState().toast('warn', 'Gamepad disconnected'); };
  window.addEventListener('gamepadconnected', onGpConnect);
  window.addEventListener('gamepaddisconnected', onGpDisconnect);
  if ([...(navigator.getGamepads?.() ?? [])].some(Boolean)) raf = requestAnimationFrame(poll);

  listeners = [
    () => window.removeEventListener('keydown', onKeyDown), () => window.removeEventListener('keyup', onKeyUp),
    () => window.removeEventListener('blur', onBlur), () => window.removeEventListener('pagehide', onBlur),
    () => document.removeEventListener('visibilitychange', onVis), unsub, () => cancelAnimationFrame(raf),
    () => window.removeEventListener('gamepadconnected', onGpConnect), () => window.removeEventListener('gamepaddisconnected', onGpDisconnect),
  ];
}

export function stopSlewController() { releaseAll(); listeners.forEach((f) => f()); listeners = []; started = false; }
