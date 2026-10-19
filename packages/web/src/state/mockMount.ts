// In-browser fake mount for `?mock` demos (no server needed). Speaks the same ServerMessage protocol.
// Physics are simplified: the tube's true sky direction = encoder + a hidden constant offset; the
// "model" is IA/IE only (constant offsets), refined from alignment points with a bit of centring noise.
import type { AlignmentPoint, AlignmentState, ClientMessage, GeoLocation, MountState, ServerMessage, Target, Axis } from '@stargazer/shared/api.ts';
import { DEFAULT_TELESCOPE_HOST, DEFAULT_TELESCOPE_PORT } from '@stargazer/shared/api.ts';
import { altAzToRaDec, raDecToAltAz, separationAltAz, sunAltitude, targetAltAz } from '../lib/astroAdapter.ts';
import { DEFAULT_LIMITS, sunIsUp } from '../lib/safety.ts';

const RATE_DEG_S = [0, 0.004, 0.008, 0.017, 0.033, 0.067, 0.13, 0.5, 1.0, 3.0];
const GOTO_FAST = 3.0, GOTO_SLOW = 0.25;
const wrap360 = (x: number) => ((x % 360) + 360) % 360;
const dAz = (a: number, b: number) => ((a - b + 540) % 360) - 180;

export class MockMount {
  private emit: (m: ServerMessage) => void;
  private timer: ReturnType<typeof setInterval>;
  private lastEmit = 0;
  private dirty = true;
  private s: MountState;
  private hidden = { az: 3.7, alt: -1.9 }; // true sky = encoder + hidden (user's imperfect "north & level")
  private model: { az: number; alt: number } | null = null;
  private moves: Record<Axis, number> = { az: 0, alt: 0 }; // deg/s
  private gotoEnc: { az: number; alt: number } | null = null;
  private trackRaDec: { ra: number; dec: number } | null = null;
  private trackTarget: Target | null = null;
  private nextId = 1;
  private last = performance.now();
  private unwrapped = 0;
  private prevAz: number | null = null;
  private timeouts = 0;

  constructor(emit: (m: ServerMessage) => void) {
    this.emit = emit;
    let loc: GeoLocation | null = null;
    try { const raw = localStorage.getItem('stargazer.mock.location'); if (raw) loc = JSON.parse(raw); } catch { /* none */ }
    this.s = {
      connection: 'disconnected', host: DEFAULT_TELESCOPE_HOST, port: DEFAULT_TELESCOPE_PORT, encoder: null, pointing: null,
      slew: 'idle', target: null, tracking: false,
      alignment: { quality: 'none', points: [], params: null, rmsArcmin: null, solved: [] },
      location: loc, serverTime: Date.now(), simulator: true, limits: DEFAULT_LIMITS,
    };
    this.timer = setInterval(() => this.tick(), 50);
    this.log('info', 'Mock mount ready (in-browser fake, no server). Press Connect.');
  }

  dispose() { clearInterval(this.timer); }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string) {
    this.emit({ type: 'log', level, message, time: Date.now() });
  }
  private err(message: string, requestType?: ClientMessage['type']) {
    this.emit({ type: 'error', message, requestType }); this.log('error', message);
  }

  handle(m: ClientMessage) {
    const s = this.s;
    const needConn = m.type !== 'connect' && m.type !== 'setLocation' && m.type !== 'disconnect';
    if (needConn && s.connection !== 'connected') { this.err('Not connected to the telescope', m.type); return; }
    switch (m.type) {
      case 'connect':
        s.host = m.host ?? DEFAULT_TELESCOPE_HOST; s.port = m.port ?? DEFAULT_TELESCOPE_PORT; s.connection = 'connecting';
        this.log('info', `Connecting to ${s.host}:${s.port} (mock)…`);
        setTimeout(() => {
          if (s.connection !== 'connecting') return;
          s.connection = 'connected'; s.encoder = s.encoder ?? { az: 0, alt: 0 };
          s.firmware = { az: '7.11.5100', alt: '7.11.5100', wifi: '0.0.256 (mock)' };
          this.log('info', 'Connected. Motor controllers AZM/ALT firmware 7.11 (mock)'); this.dirty = true;
        }, 700);
        break;
      case 'disconnect':
        this.stopAll(); s.connection = 'disconnected'; this.log('info', 'Disconnected'); break;
      case 'move':
        this.gotoEnc = null;
        this.moves[m.axis] = m.direction * (RATE_DEG_S[Math.min(9, Math.max(0, m.rate | 0))] ?? 0);
        s.slew = this.moves.az || this.moves.alt ? 'manual' : 'idle';
        break;
      case 'stopAxis':
        this.moves[m.axis] = 0;
        if (!this.moves.az && !this.moves.alt && s.slew === 'manual') { s.slew = 'idle'; this.refreshTrackHold(); }
        break;
      case 'stop':
        this.stopAll(); this.log('warn', 'STOP: all motion and tracking stopped'); break;
      case 'goto': this.goto(m.target, !!m.force, m); break;
      case 'setTracking':
        if (m.enabled) { this.refreshTrackHold(); s.tracking = !!this.trackRaDec; if (!s.tracking) this.err('Cannot track without an alignment', m.type); }
        else { s.tracking = false; this.trackRaDec = null; }
        this.log('info', `Tracking ${s.tracking ? 'on' : 'off'}`); break;
      case 'setLocation':
        s.location = m.location;
        try { localStorage.setItem('stargazer.mock.location', JSON.stringify(m.location)); } catch { /* ignore */ }
        this.log('info', `Location set: ${m.location.lat.toFixed(3)}, ${m.location.lon.toFixed(3)} (${m.location.source})`); break;
      case 'alignHome': {
        const enc = s.encoder!;
        this.model = { az: (m.azDeg ?? 0) - enc.az, alt: (m.altDeg ?? 0) - enc.alt };
        s.alignment = { quality: 'rough', points: [], params: { IA: -this.model.az, IE: -this.model.alt, AN: 0, AW: 0, CA: 0, NPAE: 0 }, rmsArcmin: null, solved: [] };
        this.log('info', 'Home set: tube level, pointing north (rough model)'); break;
      }
      case 'alignAddPoint': {
        if (!s.location) { this.err('Set a location first', m.type); return; }
        const target = m.target;
        // like the server: wait for the mount to settle before recording the position
        setTimeout(() => {
          if (s.connection !== 'connected' || !s.location) return;
          // Mock has no eyepiece: pretend the user centred the star perfectly (true position) plus a little noise.
          const sky = targetAltAz(target, s.location, Date.now());
          const noise = () => (Math.random() - 0.5) * 0.08;
          const enc = { az: wrap360(sky.az - this.hidden.az + noise()), alt: sky.alt - this.hidden.alt + noise() };
          s.encoder = { ...enc };
          const pt: AlignmentPoint = { id: this.nextId++, target, encoder: enc, time: Date.now() };
          s.alignment = { ...s.alignment, points: [...s.alignment.points, pt] };
          this.refit(); this.log('info', `Alignment point added: ${target.name}`); this.dirty = true;
        }, DEFAULT_LIMITS.settleMs);
        break;
      }
      case 'alignRemovePoint':
        s.alignment = { ...s.alignment, points: s.alignment.points.filter((p) => p.id !== m.id) }; this.refit(); break;
      case 'alignClear':
        this.model = null; s.alignment = { quality: 'none', points: [], params: null, rmsArcmin: null, solved: [] }; this.log('info', 'Alignment cleared'); break;
      case 'sync': {
        if (!s.location) { this.err('Set a location first', m.type); return; }
        const sky = targetAltAz(m.target, s.location, Date.now()); const enc = s.encoder!;
        this.model = { az: dAz(sky.az, enc.az), alt: sky.alt - enc.alt };
        if (s.alignment.quality === 'none') s.alignment = { ...s.alignment, quality: 'rough' };
        this.log('info', `Synced on ${m.target.name}`); break;
      }
    }
    this.dirty = true;
  }

  private stopAll() {
    this.moves = { az: 0, alt: 0 }; this.gotoEnc = null; this.s.slew = 'idle'; this.s.tracking = false; this.trackRaDec = null;
  }

  private refit() {
    const s = this.s, loc = s.location;
    const pts = s.alignment.points;
    if (!pts.length || !loc) {
      s.alignment = { ...s.alignment, quality: this.model ? 'rough' : 'none', rmsArcmin: null, solved: [] };
      return;
    }
    const offs = pts.map((p) => { const sky = targetAltAz(p.target, loc, p.time); return { az: dAz(sky.az, p.encoder.az), alt: sky.alt - p.encoder.alt }; });
    const mAz = offs.reduce((a, o) => a + o.az, 0) / offs.length, mAlt = offs.reduce((a, o) => a + o.alt, 0) / offs.length;
    this.model = { az: mAz, alt: mAlt };
    const points = pts.map((p, i) => ({ ...p, residualArcmin: pts.length > 1 ? Math.hypot(offs[i].az - mAz, offs[i].alt - mAlt) * 60 : 0 }));
    const rms = Math.sqrt(points.reduce((a, p) => a + (p.residualArcmin ?? 0) ** 2, 0) / points.length);
    const solved = (['IA', 'IE', 'AN', 'AW', 'CA', 'NPAE'] as const).slice(0, pts.length === 1 ? 2 : pts.length === 2 ? 4 : pts.length === 3 ? 5 : 6);
    s.alignment = { quality: 'aligned', points, params: { IA: -mAz, IE: -mAlt, AN: 0, AW: 0, CA: 0, NPAE: 0 }, rmsArcmin: rms, solved: [...solved] } satisfies AlignmentState;
  }

  private skyToEnc(sky: { az: number; alt: number }) { return { az: wrap360(sky.az - this.model!.az), alt: sky.alt - this.model!.alt }; }

  private goto(t: Target, force: boolean, req: ClientMessage) {
    const s = this.s;
    // Same rules, in the same order, as Mount.goto() on the server.
    const lim = DEFAULT_LIMITS;
    if (!this.model) { this.err('Altitude reference unknown: do the Home step (tube level, pointing north) or align first', 'goto'); return; }
    if (!s.location) { this.err('Set your location before a GoTo', 'goto'); return; }
    const now = Date.now();
    if (s.alignment.quality !== 'aligned' && sunIsUp(sunAltitude(s.location, now), lim)) {
      this.err(`The Sun is up (above ${lim.sunUpAltDeg}°) and the alignment is only ${s.alignment.quality}: automatic motion is blocked.`, 'goto'); return;
    }
    const sky = targetAltAz(t, s.location, now);
    const sunSep = separationAltAz(sky, targetAltAz({ kind: 'body', body: 'Sun', name: 'Sun' }, s.location, now));
    if ((t.kind === 'body' && t.body === 'Sun') || sunSep < lim.sunDeg) {
      this.err(`${t.name} is ${sunSep.toFixed(1)}° from the Sun. Never look at the Sun without a full-aperture solar filter. GoTo refused.`, 'goto'); return;
    }
    if (sky.alt < lim.altDeg[0] || sky.alt > lim.altDeg[1]) {
      this.err(`${t.name} is outside the mechanical altitude limits (${lim.altDeg[0]}° … ${lim.altDeg[1]}°); GoTo refused.`, 'goto'); return;
    }
    if (!force && sky.alt < 0) {
      this.emit({ type: 'confirm', message: `${t.name} is below the horizon (alt ${sky.alt.toFixed(1)}°). Slew anyway?`, request: { ...req } }); return;
    }
    s.target = t; this.moves = { az: 0, alt: 0 };
    this.trackTarget = t;
    this.gotoEnc = this.skyToEnc({ az: sky.az, alt: sky.alt });
    s.slew = 'goto-fast'; s.tracking = false;
    this.log('info', `GoTo ${t.name}: az ${sky.az.toFixed(1)}° alt ${sky.alt.toFixed(1)}°`);
  }

  private refreshTrackHold() {
    const p = this.s.pointing;
    this.trackRaDec = p ? { ra: p.ra, dec: p.dec } : null;
  }

  private tick() {
    const now = performance.now();
    const dt = Math.min(0.2, (now - this.last) / 1000);
    this.last = now;
    const s = this.s;
    if (s.connection === 'connected' && s.encoder) {
      const enc = s.encoder;
      if (this.moves.az || this.moves.alt) {
        enc.az = wrap360(enc.az + this.moves.az * dt);
        enc.alt = Math.max(-5, Math.min(90, enc.alt + this.moves.alt * dt));
        this.dirty = true;
      }
      if (this.gotoEnc && s.location) {
        // re-aim at the moving target during the slow stage
        if (this.trackTarget && this.trackTarget.kind !== 'altaz') this.gotoEnc = this.skyToEnc(targetAltAz(this.trackTarget, s.location, Date.now()));
        const ea = dAz(this.gotoEnc.az, enc.az), ee = this.gotoEnc.alt - enc.alt;
        const dist = Math.hypot(ea, ee);
        const v = (dist > 1.5 ? GOTO_FAST : GOTO_SLOW) * dt;
        s.slew = dist > 1.5 ? 'goto-fast' : 'goto-slow';
        if (dist <= v || dist < 0.003) {
          enc.az = this.gotoEnc.az; enc.alt = this.gotoEnc.alt; this.gotoEnc = null; s.slew = 'idle';
          if (this.trackTarget && this.trackTarget.kind !== 'altaz') { s.tracking = true; }
          this.log('info', `GoTo complete${s.tracking ? ', tracking' : ''}`);
          this.updatePointing(); this.refreshTrackHold();
        } else {
          enc.az = wrap360(enc.az + (ea / dist) * v); enc.alt += (ee / dist) * v;
        }
        this.dirty = true;
      } else if (s.tracking && this.trackRaDec && s.location && this.model) {
        const want = this.skyToEnc(raDecToAltAz(this.trackRaDec, s.location, Date.now()));
        if (!this.moves.az) enc.az = want.az;
        if (!this.moves.alt) enc.alt = Math.max(-5, Math.min(90, want.alt));
      }
      this.updatePointing();
    } else if (s.connection !== 'connected') {
      s.pointing = null;
    }
    s.serverTime = Date.now();
    // fake health telemetry (SAFETY.md §5.3 shape); battery readout unsupported like a real Astro Fi
    if (s.encoder) { if (this.prevAz != null) this.unwrapped += dAz(s.encoder.az, this.prevAz); this.prevAz = s.encoder.az; }
    if (s.connection === 'connected') {
      if (Math.random() < 0.0005) this.timeouts++;
      const warnings: string[] = [];
      if (Math.abs(this.unwrapped) > 150) warnings.push(`Cable wrap ${this.unwrapped.toFixed(0)}° from neutral: unwind soon (mock)`);
      s.health = { battery: null, latencyMs: 18 + Math.random() * 10, timeouts: this.timeouts, slewSpeedRatio: 0.97, warnings, unwrappedAz: this.unwrapped };
    } else delete s.health;
    const period = s.connection === 'connected' ? 250 : 1000;
    if (this.dirty || now - this.lastEmit > period) {
      this.lastEmit = now; this.dirty = false;
      this.emit({ type: 'state', state: structuredClone(s) });
    }
  }

  private updatePointing() {
    const s = this.s;
    if (!this.model || !s.encoder || !s.location) { s.pointing = null; return; }
    const az = wrap360(s.encoder.az + this.model.az), alt = s.encoder.alt + this.model.alt;
    const rd = altAzToRaDec({ az, alt }, s.location, Date.now());
    s.pointing = { ra: rd.ra, dec: rd.dec, az, alt };
  }

  /** The hidden "truth" (where the tube really points), exposed for curiosity in mock mode. */
  truth() { const e = this.s.encoder; return e ? { az: wrap360(e.az + this.hidden.az), alt: e.alt + this.hidden.alt } : null; }
}
