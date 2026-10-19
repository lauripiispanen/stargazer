// Small 2D sky view for the phone remote: a ~15–60° field around where the scope points, with stars, deep-sky
// objects, planets, the GoTo target and finder rings. Canvas 2D only (no three.js), redrawn ~2×/s.
// Reuses the renderer's pure projection math (sky/projection.ts) and J2000 -> horizon matrix.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoLocation, MountState, SolarBody } from '@stargazer/shared/api.ts';
import { useLocation, useStore } from '../state/store.ts';
import { useGotoBlock, useSun } from '../state/hooks.ts';
import { bodyRaDec, eqj2000ToWorldMatrix, objectToTarget, targetAltAz } from '../lib/astroAdapter.ts';
import { objectTitle, type Catalog, type SkyObject } from '../lib/catalog.ts';
import { compassPoint, fmtDeg } from '../lib/format.ts';
import { sunIsUp } from '../lib/safety.ts';
import { altAzToWorld, D2R, mulMat3, Projector, refractWorld, transpose3, unrefractWorld, type Mat3, type Vec3 } from '../sky/projection.ts';
import { AddToListButton } from '../panels/ListPanel.tsx';
import { Icon } from '../panels/ui.tsx';

const FOVS = [15, 30, 60];
const DSO_COLORS: Record<string, string> = {
  galaxy: '#ff9a8a', 'open-cluster': '#ffd36e', 'globular-cluster': '#ffd36e', nebula: '#7fe0c0', 'planetary-nebula': '#7fe0c0',
  'supernova-remnant': '#7fe0c0', 'double-star': '#a9c6ff', other: '#a9c6ff',
};

/** J2000 unit vectors of the catalog stars (computed once per catalog). */
function starVectors(c: Catalog): Float32Array {
  const n = c.stars.count, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = c.stars.ra[i]! * D2R, d = c.stars.dec[i]! * D2R, cd = Math.cos(d);
    out[i * 3] = cd * Math.cos(r); out[i * 3 + 1] = cd * Math.sin(r); out[i * 3 + 2] = Math.sin(d);
  }
  return out;
}

const raDecVec = (ra: number, dec: number): Vec3 => { const r = ra * D2R, d = dec * D2R, c = Math.cos(d); return [c * Math.cos(r), c * Math.sin(r), Math.sin(d)]; };

interface Pickable { x: number; y: number; o: SkyObject }

/** Where to centre: the scope's pointing, else the selected object/target, else south at 40°. */
function viewCentre(m: MountState | null, sel: SkyObject | null, loc: GeoLocation, now: number): { az: number; alt: number; scope: boolean } {
  if (m?.pointing && m.connection === 'connected') return { az: m.pointing.az, alt: m.pointing.alt, scope: true };
  try {
    if (sel) { const a = targetAltAz(objectToTarget(sel), loc, now); return { ...a, scope: false }; }
    if (m?.target) { const a = targetAltAz(m.target, loc, now); return { ...a, scope: false }; }
  } catch { /* fall through */ }
  return { az: 180, alt: 40, scope: false };
}

export function MiniSky() {
  const ref = useRef<HTMLCanvasElement>(null);
  const catalog = useStore((s) => s.catalog);
  const selected = useStore((s) => s.selected);
  const select = useStore((s) => s.select);
  const loc = useLocation();
  const [fov, setFov] = useState(30);
  const vectors = useMemo(() => (catalog ? starVectors(catalog) : null), [catalog]);
  const pickables = useRef<Pickable[]>([]);
  const cache = useRef<{ key: string; m: Mat3; at: number; bodies: { body: SolarBody; ra: number; dec: number; mag: number }[] } | null>(null);

  useEffect(() => {
    const cv = ref.current!;
    let raf = 0, last = 0, dirty = true;
    const draw = () => {
      raf = 0;
      if (document.visibilityState !== 'visible') return;
      const st = useStore.getState();
      const now = Date.now();
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const css = getComputedStyle(document.documentElement);
      const night = document.documentElement.classList.contains('night');
      const col = (v: string, d: string) => css.getPropertyValue(v).trim() || d;
      const accent = col('--accent', '#5ee0c0'), text = col('--text', '#dfe7f2'), dim = col('--text-dim', '#8a98ad'), bad = col('--bad', '#ff5d5d');
      ctx.fillStyle = night ? '#000' : '#050912';
      ctx.fillRect(0, 0, w, h);

      // J2000 -> world (horizon) matrix and planet positions, refreshed every 5 s
      const key = `${loc.lat},${loc.lon}`;
      if (!cache.current || cache.current.key !== key || now - cache.current.at > 5000) {
        const bodies: { body: SolarBody; ra: number; dec: number; mag: number }[] = [];
        for (const o of st.catalog?.bodies ?? []) {
          if (!o.body || o.body === 'Sun') continue;
          try { const p = bodyRaDec(o.body, loc, now); bodies.push({ body: o.body, ra: p.ra, dec: p.dec, mag: p.mag }); } catch { /* skip */ }
        }
        cache.current = { key, m: eqj2000ToWorldMatrix(loc, now), at: now, bodies };
      }
      const M = cache.current.m;
      const centre = viewCentre(st.mount, st.selected, loc, now);
      // vertical FOV = chosen FOV across the shorter side
      const vfov = h <= w ? fov : (fov * h) / w;
      const proj = new Projector();
      proj.update(w, h, centre.az, centre.alt, vfov);
      const ppd = proj.pxPerDeg();
      const pt: [number, number] = [0, 0];
      const toScreen = (v: Vec3): boolean => { const wv = mulMat3(M, v); refractWorld(wv); return proj.project(wv, pt); };
      // view centre as a J2000 vector, for cheap culling
      const cW = unrefractWorld(altAzToWorld(centre.az, centre.alt));
      const cJ = mulMat3(transpose3(M), cW);
      const radius = (Math.hypot(w, h) / 2 / ppd) * 1.1;
      const cosR = Math.cos(Math.min(89, radius) * D2R);
      const picks: Pickable[] = [];

      // stars
      const magLimit = fov <= 15 ? 8 : fov <= 30 ? 7 : 6;
      const cat = st.catalog;
      if (cat && vectors) {
        ctx.fillStyle = night ? '#ff4a30' : '#f4f7ff';
        const n = cat.stars.count, mags = cat.stars.mag, v: Vec3 = [0, 0, 0];
        for (let i = 0; i < n; i++) {
          const mag = mags[i]!;
          if (mag > magLimit) break; // sorted by magnitude
          v[0] = vectors[i * 3]!; v[1] = vectors[i * 3 + 1]!; v[2] = vectors[i * 3 + 2]!;
          if (v[0] * cJ[0] + v[1] * cJ[1] + v[2] * cJ[2] < cosR) continue;
          if (!toScreen(v) || !proj.inView(pt[0], pt[1], 4)) continue;
          const r = Math.max(0.55, Math.min(4.5, 0.5 + (magLimit - mag) * 0.55));
          ctx.globalAlpha = Math.min(1, 0.45 + (magLimit - mag) * 0.2);
          ctx.beginPath(); ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
        // star names (brightest named stars)
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = dim;
        for (const o of cat.namedStars) {
          if ((o.mag ?? 9) > (fov <= 15 ? 5 : 3.2)) continue;
          const sv = raDecVec(o.ra, o.dec);
          if (sv[0] * cJ[0] + sv[1] * cJ[1] + sv[2] * cJ[2] < cosR || !toScreen(sv) || !proj.inView(pt[0], pt[1])) continue;
          picks.push({ x: pt[0], y: pt[1], o });
          if (o.name && !/^HIP /.test(o.name)) ctx.fillText(o.name, pt[0] + 5, pt[1] - 4);
        }
        // deep-sky objects
        const dsoLimit = fov <= 15 ? 11 : fov <= 30 ? 9.5 : 8;
        ctx.lineWidth = 1.2;
        for (const o of cat.dsos) {
          if ((o.mag ?? 99) > dsoLimit && !(o.id ?? '').startsWith('M')) continue;
          const sv = raDecVec(o.ra, o.dec);
          if (sv[0] * cJ[0] + sv[1] * cJ[1] + sv[2] * cJ[2] < cosR || !toScreen(sv) || !proj.inView(pt[0], pt[1], 10)) continue;
          const c = night ? accent : DSO_COLORS[o.type ?? 'other'] ?? '#a9c6ff';
          const size = Math.max(3.5, Math.min(40, ((o.sizeArcmin?.[0] ?? 4) / 60) * ppd * 0.5));
          ctx.strokeStyle = c;
          ctx.beginPath(); ctx.ellipse(pt[0], pt[1], size, size * 0.7, 0, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = c;
          ctx.fillText(o.id ?? o.name, pt[0] + size + 3, pt[1] + 4);
          picks.push({ x: pt[0], y: pt[1], o });
        }
        // Moon and planets
        for (const b of cache.current.bodies) {
          if (!toScreen(raDecVec(b.ra, b.dec)) || !proj.inView(pt[0], pt[1], 10)) continue;
          const r = b.body === 'Moon' ? Math.max(6, 0.26 * ppd) : 4;
          ctx.fillStyle = night ? '#ff6a50' : b.body === 'Moon' ? '#e8e4d8' : '#ffe2a8';
          ctx.beginPath(); ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = text;
          ctx.fillText(b.body, pt[0] + r + 3, pt[1] + 4);
          const o = cat.bodies.find((x) => x.body === b.body);
          if (o) picks.push({ x: pt[0], y: pt[1], o: { ...o, ra: b.ra, dec: b.dec } });
        }
      }

      // ground: shade below the horizon line (screen "down" is towards the ground: the view is zenith-up)
      const hz: [number, number][] = [];
      const span = Math.min(180, radius * 2 + 10);
      for (let d = -span; d <= span; d += 1) if (proj.project(altAzToWorld(centre.az + d, 0), pt)) hz.push([pt[0], pt[1]]);
      if (hz.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(hz[0]![0], hz[0]![1]);
        for (const p of hz) ctx.lineTo(p[0], p[1]);
        ctx.lineTo(hz[hz.length - 1]![0], h + 400); ctx.lineTo(hz[0]![0], h + 400); ctx.closePath();
        ctx.fillStyle = night ? 'rgba(45,0,0,.6)' : 'rgba(22,34,24,.7)';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(hz[0]![0], hz[0]![1]);
        for (const p of hz) ctx.lineTo(p[0], p[1]);
        ctx.strokeStyle = night ? 'rgba(170,35,20,.8)' : 'rgba(130,175,130,.8)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
      }

      // selected object and GoTo target markers
      const mark = (ra: number, dec: number, label: string, color: string, dashed: boolean) => {
        if (!toScreen(raDecVec(ra, dec))) return;
        const inView = proj.inView(pt[0], pt[1], -8);
        ctx.save();
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
        if (dashed) ctx.setLineDash([4, 3]);
        if (inView) {
          ctx.beginPath(); ctx.arc(pt[0], pt[1], 11, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = '600 12px system-ui, sans-serif';
          ctx.fillText(label, pt[0] + 14, pt[1] - 10);
        } else {
          // off-screen: arrow at the edge pointing towards it
          const dx = pt[0] - w / 2, dy = pt[1] - h / 2, k = Math.min((w / 2 - 18) / Math.abs(dx || 1e-6), (h / 2 - 18) / Math.abs(dy || 1e-6));
          const x = w / 2 + dx * k, y = h / 2 + dy * k, a = Math.atan2(dy, dx);
          ctx.translate(x, y); ctx.rotate(a);
          ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-6, -7); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill();
          ctx.rotate(-a);
          ctx.font = '600 11px system-ui, sans-serif';
          const tw = ctx.measureText(label).width;
          ctx.fillText(label, Math.max(-x + 4, Math.min(w - x - tw - 4, -tw / 2)), dy > 0 ? -12 : 20);
        }
        ctx.restore();
      };
      const sel = st.selected;
      if (sel) {
        let p = { ra: sel.ra, dec: sel.dec };
        if (sel.body) { try { p = bodyRaDec(sel.body, loc, now); } catch { /* stale */ } }
        mark(p.ra, p.dec, sel.name, text, true);
      }
      const tgt = st.mount?.target;
      if (tgt && tgt.kind !== 'altaz' && (!sel || tgt.name !== sel.name)) {
        let p: { ra: number; dec: number } | null = tgt.kind === 'radec' ? tgt : null;
        if (tgt.kind === 'body') { try { p = bodyRaDec(tgt.body, loc, now); } catch { p = null; } }
        if (p) mark(p.ra, p.dec, tgt.name, accent, false);
      }

      // scope reticle (finder rings) at the centre, or a hint when the pointing is unknown
      if (centre.scope) {
        ctx.save();
        ctx.strokeStyle = bad; ctx.lineWidth = 1.5;
        for (const deg of [0.5, 2, 4]) { const r = deg * ppd; if (r > 4 && r < Math.max(w, h)) { ctx.beginPath(); ctx.arc(w / 2, h / 2, r, 0, Math.PI * 2); ctx.stroke(); } }
        ctx.beginPath();
        ctx.moveTo(w / 2 - 8, h / 2); ctx.lineTo(w / 2 + 8, h / 2); ctx.moveTo(w / 2, h / 2 - 8); ctx.lineTo(w / 2, h / 2 + 8);
        ctx.stroke();
        ctx.restore();
      }

      // scale & orientation
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = dim;
      ctx.fillText(`${fov}° · ${compassPoint(centre.az)} ${fmtDeg(centre.alt, 0)}`, 8, h - 8);
      if (!centre.scope) {
        ctx.fillStyle = text;
        ctx.font = '600 12px system-ui, sans-serif';
        const msg = st.mount?.connection === 'connected' ? 'Scope position unknown: do Home (Align tab)' : 'Telescope not connected';
        ctx.fillText(msg, 8, 18);
      }
      pickables.current = picks;
    };
    const request = () => { dirty = true; if (!raf) raf = requestAnimationFrame(() => { last = performance.now(); dirty = false; draw(); }); };
    // redraw on pointing/selection changes (throttled to ~4 Hz) and every 2 s for sky rotation
    const unsub = useStore.subscribe((s, p) => {
      if (s.mount?.pointing !== p.mount?.pointing || s.selected !== p.selected || s.night !== p.night || s.mount?.target !== p.mount?.target || s.catalog !== p.catalog) {
        if (performance.now() - last > 240) request(); else dirty = true;
      }
    });
    const timer = setInterval(() => { if (dirty || performance.now() - last > 2000) request(); }, 250);
    const ro = new ResizeObserver(request);
    ro.observe(cv);
    request();
    return () => { unsub(); clearInterval(timer); ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [fov, vectors, loc]);

  const onTap = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - b.left, y = e.clientY - b.top;
    let best: Pickable | null = null, bd = 28 * 28;
    for (const p of pickables.current) { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; best = p; } }
    select(best ? best.o : null);
  };

  return (
    <div className="r-minisky">
      <canvas ref={ref} className="r-minisky-canvas" onPointerUp={onTap} aria-label="Sky around the telescope" />
      <div className="r-fov" role="radiogroup" aria-label="Field of view">
        {FOVS.map((f) => <button key={f} role="radio" aria-checked={fov === f} className={`chip ${fov === f ? 'on' : ''}`} onClick={() => setFov(f)}>{f}°</button>)}
      </div>
      {selected && <SelectedStrip o={selected} onClose={() => select(null)} />}
    </div>
  );
}

function SelectedStrip({ o, onClose }: { o: SkyObject; onClose: () => void }) {
  const requestGoto = useStore((s) => s.requestGoto);
  const loc = useLocation();
  const sun = useSun();
  const block = useGotoBlock(o);
  let alt: number | null = null, az = 0;
  const target = objectToTarget(o);
  try { const a = targetAltAz(target, loc, Date.now()); alt = a.alt; az = a.az; } catch { /* unknown */ }
  return (
    <div className="r-selected">
      <div className="r-sel-main">
        <b>{objectTitle(o)}</b>
        <span className="dim small">{o.typeLabel}{alt != null ? ` · ${fmtDeg(alt, 0)} ${compassPoint(az)}` : ''}</span>
        {block && <span className="dim small block-reason">{block}</span>}
      </div>
      <AddToListButton target={target} small label={false} />
      <span className="btn-wrap" title={block ?? `GoTo ${o.name}`}>
        <button className="btn primary" disabled={!!block} onClick={() => requestGoto(target, { daytime: sunIsUp(sun.alt) })}><Icon name="target" /> GoTo</button>
      </span>
      <button className="icon-btn" onClick={onClose} aria-label="Clear selection"><Icon name="x" /></button>
    </div>
  );
}
