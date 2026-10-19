// 2D canvas overlay on top of the WebGL sky: DSO symbols, planets/Moon/Sun, labels (decluttered),
// cardinal points, grid labels, telescope reticle, GoTo target, slew line, selection and alignment hints.
import type { SolarBody } from '@stargazer/shared/api.ts';
import type { Catalog, DsoType, SkyObject } from '../lib/catalog.ts';
import { DSO_TYPE_LABEL } from '../lib/catalog.ts';
import { declutterLabels, dsoLabelMagLimit, starLabelMagLimit, type LabelCandidate, type PlacedLabel } from '../lib/declutter.ts';
import type { AppState } from '../state/store.ts';
import { mountLimits } from '../lib/safety.ts';
import type { FrameContext, BodyPos } from './SkyRenderer.ts';
import { altAzToWorld, raDecToVec, refractWorld, slerp, transpose3, mulMat3, unrefractWorld, vecToRaDec, type Vec3 } from './projection.ts';

const FONT = '500 11px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const FONT_SMALL = '500 10px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const FONT_CON = '600 10px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const FONT_CARD = '700 13px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export const DSO_COLOR: Record<DsoType, string> = {
  galaxy: '#ff9f80', 'open-cluster': '#ffd56e', 'globular-cluster': '#ffbf5e', nebula: '#72e0c0',
  'planetary-nebula': '#7cc8ff', 'supernova-remnant': '#c7a0ff', 'double-star': '#d9e2ec', other: '#b0b8c4',
};
const BODY_COLOR: Record<SolarBody, string> = {
  Sun: '#fff2c4', Moon: '#e8e6df', Mercury: '#c9b8a6', Venus: '#fff4d6', Mars: '#ff8a5c', Jupiter: '#f2d7b0',
  Saturn: '#e8d08f', Uranus: '#a6e4ef', Neptune: '#7aa4ff',
};

interface Palette {
  star: string; con: string; cardinal: string; cardinalN: string; grid: string; reticle: string; target: string;
  select: string; align: string; halo: string; dso(t: DsoType): string; body(b: SolarBody): string;
}
const DAY: Palette = {
  star: '#dfe9f5', con: 'rgba(150,180,225,0.55)', cardinal: '#c8d6e5', cardinalN: '#ff6b6b', grid: 'rgba(130,190,230,0.75)',
  reticle: '#5ef2c2', target: '#ffcf5c', select: '#ffffff', align: '#ffd36e', halo: 'rgba(2,4,10,0.85)',
  dso: (t) => DSO_COLOR[t], body: (b) => BODY_COLOR[b],
};
const NIGHT: Palette = {
  star: '#d23a2a', con: 'rgba(170,30,20,0.6)', cardinal: '#b8301f', cardinalN: '#ff4a32', grid: 'rgba(170,40,25,0.8)',
  reticle: '#ff3b25', target: '#ff6a3a', select: '#ff5a40', align: '#ff6a3a', halo: 'rgba(0,0,0,0.9)',
  dso: () => '#c43424', body: () => '#e0442e',
};

/** Precomputed per-catalog data for the overlay. */
export class OverlayCache {
  catalog: Catalog | null = null;
  dsoVec: Float32Array = new Float32Array(0);
  namedVec: Float32Array = new Float32Array(0);
  starVec: Float32Array = new Float32Array(0);
  private widths = new Map<string, number>();

  setCatalog(c: Catalog) {
    this.catalog = c;
    const fill = (objs: { ra: number; dec: number }[]) => {
      const a = new Float32Array(objs.length * 3); const v: Vec3 = [0, 0, 0];
      objs.forEach((o, i) => { raDecToVec(o.ra, o.dec, v); a.set(v, i * 3); });
      return a;
    };
    this.dsoVec = fill(c.dsos);
    this.namedVec = fill(c.namedStars);
    const n = c.stars.count; this.starVec = new Float32Array(n * 3); const v: Vec3 = [0, 0, 0];
    for (let i = 0; i < n; i++) { raDecToVec(c.stars.ra[i], c.stars.dec[i], v); this.starVec.set(v, i * 3); }
  }

  textWidth(ctx: CanvasRenderingContext2D, font: string, text: string): number {
    const k = font + '|' + text;
    let w = this.widths.get(k);
    if (w === undefined) { ctx.font = font; w = ctx.measureText(text).width; this.widths.set(k, w); if (this.widths.size > 6000) this.widths.clear(); }
    return w;
  }
}

const tmpV: Vec3 = [0, 0, 0];
const tmpS: [number, number] = [0, 0];

/** J2000 unit vector from a packed array -> apparent world (into tmpV-like out). */
function worldFromPacked(fc: FrameContext, arr: Float32Array, i: number, out: Vec3): Vec3 {
  const m = fc.M, x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
  out[0] = m[0] * x + m[1] * y + m[2] * z; out[1] = m[3] * x + m[4] * y + m[5] * z; out[2] = m[6] * x + m[7] * y + m[8] * z;
  return refractWorld(out);
}

interface DrawLabel { cand: LabelCandidate; text: string; font: string; color: string }

export function drawOverlay(ctx: CanvasRenderingContext2D, fc: FrameContext, st: AppState, cache: OverlayCache) {
  const cat = cache.catalog!;
  const altLimitDeg = mountLimits(st.mount).altDeg[1];
  const P = st.night ? NIGHT : DAY;
  const proj = fc.proj;
  const L = st.layers;
  const fov = proj.fov;
  const groundOn = L.ground;
  const labels: DrawLabel[] = [];
  const obstacles: PlacedLabel[] = [];
  const s: [number, number] = [0, 0];
  const visible = (w: Vec3) => (!groundOn || w[1] > -0.004) && proj.project(w, s) && proj.inView(s[0], s[1], 40);
  const addLabel = (id: string, text: string, x: number, y: number, priority: number, color: string, font = FONT, r = 4, offsets?: [number, number][]) => {
    const w = cache.textWidth(ctx, font, text) + 2, h = font === FONT ? 13 : 12;
    labels.push({ cand: { id, x, y, w, h, priority, offsets: offsets ?? [[r + 3, -h / 2], [-w - r - 3, -h / 2], [-w / 2, -h - r - 2], [-w / 2, r + 2]] }, text, font, color });
  };

  // ---- grid labels ----
  if (L.altAzGrid) {
    ctx.font = FONT_SMALL; ctx.fillStyle = P.grid; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let alt = 10; alt <= 80; alt += 10) {
      if (proj.project(altAzToWorld(proj.az, alt, tmpV), s) && proj.inView(s[0], s[1])) ctx.fillText(`${alt}°`, s[0] + 3, s[1] - 6);
    }
    for (let az = 0; az < 360; az += 15) {
      if (az % 45 === 0) continue;
      if (proj.project(altAzToWorld(az, 0, tmpV), s) && proj.inView(s[0], s[1])) { ctx.textAlign = 'center'; ctx.fillText(`${az}°`, s[0], s[1] + 26); }
    }
  }
  if (L.eqGrid) {
    ctx.font = FONT_SMALL; ctx.fillStyle = st.night ? P.grid : 'rgba(140,165,230,0.85)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let ra = 0; ra < 360; ra += 15) {
      const w = fc.toWorld(ra, 0, tmpV);
      if (visible(w)) ctx.fillText(`${ra / 15}h`, s[0], s[1] - 8);
    }
    // dec labels along the RA of the view centre
    const c = unrefractWorld(proj.unproject(proj.w / 2, proj.h / 2));
    const eq = vecToRaDec(mulMat3(transpose3(fc.M), c));
    const raC = Math.round(eq.ra / 15) * 15;
    for (let dec = -80; dec <= 80; dec += 10) {
      if (dec === 0) continue;
      const w = fc.toWorld(raC, dec, tmpV);
      if (visible(w)) ctx.fillText(`${dec > 0 ? '+' : '−'}${Math.abs(dec)}°`, s[0] + 16, s[1] - 7);
    }
  }

  // ---- constellation names ----
  if (L.constellationNames && fov > 8) {
    for (const k of cat.constellations) {
      const w = fc.toWorld(k.label[0], k.label[1], tmpV);
      if (!visible(w)) continue;
      const text = (fov > 70 ? k.name : k.name).toUpperCase();
      const tw = cache.textWidth(ctx, FONT_CON, text);
      addLabel(`con:${k.id}`, text, s[0], s[1], 100, P.con, FONT_CON, 0, [[-tw / 2, -6]]);
    }
  }

  // ---- DSOs ----
  const sel = st.selected;
  if (L.dsos) {
    const labelLim = dsoLabelMagLimit(fov);
    const symLim = labelLim + 1.5;
    const ppd = proj.pxPerDeg();
    for (let i = 0; i < cat.dsos.length; i++) {
      const o = cat.dsos[i];
      const mag = o.mag ?? 11;
      const isM = !!o.id && /^M\d+$/.test(o.id);
      const big = (o.sizeArcmin?.[0] ?? 0) / 60 * ppd > 30;
      if (mag > symLim && !isM && !big && sel?.key !== o.key) continue;
      const w = worldFromPacked(fc, cache.dsoVec, i, tmpV);
      if (!visible(w)) continue;
      const x = s[0], y = s[1];
      const type = o.type ?? 'other';
      const color = P.dso(type);
      const rx = Math.max(5, Math.min(proj.w, ((o.sizeArcmin?.[0] ?? 0) / 120) * ppd));
      const ry = Math.max(type === 'galaxy' ? 3 : 5, Math.min(proj.w, ((o.sizeArcmin?.[1] ?? o.sizeArcmin?.[0] ?? 0) / 120) * ppd));
      const alpha = mag <= labelLim || isM ? 0.95 : 0.55;
      drawDsoSymbol(ctx, type, x, y, rx, ry, color, alpha);
      if ((mag <= labelLim || (isM && fov < 100) || big) && sel?.key !== o.key) {
        const pr = (isM ? 600 : 420) - mag * 12 + (big ? 50 : 0);
        const text = fov < 15 && o.name !== o.id ? `${o.id} ${o.name}` : (o.id ?? o.name);
        addLabel(o.key, text, x, y, pr, color, FONT, Math.max(rx, ry) * 0.7);
      }
    }
  }

  // ---- named stars ----
  if (L.starNames) {
    const lim = Math.min(starLabelMagLimit(fov), fc.magLimit - 0.5);
    for (let i = 0; i < cat.namedStars.length; i++) {
      const o = cat.namedStars[i];
      if ((o.mag ?? 9) > lim) break; // sorted by mag
      const w = fc.toWorld(o.ra, o.dec, tmpV);
      if (!visible(w)) continue;
      if (sel?.key === o.key) continue;
      const proper = cat.starNames[String(o.hip)]?.name;
      if (!proper && fov > 30) continue;
      addLabel(o.key, o.name, s[0], s[1], 700 - (o.mag ?? 6) * 25 + (proper ? 40 : 0), P.star, FONT, 4 + Math.max(0, 3 - (o.mag ?? 3)));
    }
  }

  // ---- solar system ----
  if (L.planets) {
    const ppd = proj.pxPerDeg();
    for (const b of fc.bodies) {
      if (!visible(b.world)) continue;
      const r = drawBody(ctx, b, s[0], s[1], ppd, fc, P, st.night);
      if (sel?.key !== `body:${b.body}`) addLabel(`body:${b.body}`, b.body, s[0], s[1], 900 - (b.body === 'Sun' || b.body === 'Moon' ? 0 : 10), P.body(b.body), FONT, r + 2);
      obstacles.push({ id: `o:${b.body}`, x: s[0] - r, y: s[1] - r, w: 2 * r, h: 2 * r });
    }
  }

  // ---- Sun keep-out (SAFETY.md §3): 20° circle, drawn whenever the Sun is anywhere near the view ----
  {
    const sunB = fc.bodies[0];
    if (sunB) drawSunKeepOut(ctx, sunB.world, fc, st.night, mountLimits(st.mount).sunDeg);
  }
  // ---- alt limit label ----
  {
    const lim = altLimitDeg;
    if (lim < 90 && proj.project(altAzToWorld(proj.az, lim, tmpV), s) && proj.inView(s[0], s[1])) {
      ctx.font = FONT_SMALL; ctx.fillStyle = st.night ? '#b8301f' : 'rgba(255,120,105,0.85)'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(`mount alt limit ${lim}° · no-go above`, s[0], s[1] - 4);
    }
  }

  // ---- alignment suggestions ----
  if (st.panel === 'align' && st.alignSuggestions.length) {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
    st.alignSuggestions.forEach((a, i) => {
      const w = fc.toWorld(a.ra, a.dec, tmpV);
      if (!visible(w)) return;
      ctx.strokeStyle = P.align; ctx.globalAlpha = 0.55 + 0.45 * pulse; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s[0], s[1], 11 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.font = FONT_SMALL; ctx.fillStyle = P.align; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), s[0] + 12, s[1] - 12);
      addLabel(`align:${a.name}`, a.name, s[0], s[1], 850, P.align, FONT, 16);
    });
  }

  // ---- cardinal points (fixed, used as obstacles) ----
  const CARD: [string, number][] = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]];
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [name, az] of CARD) {
    if (!proj.project(altAzToWorld(az, 0, tmpV), s) || !proj.inView(s[0], s[1], 20)) continue;
    const major = name.length === 1;
    ctx.font = major ? FONT_CARD : FONT;
    const y = Math.min(proj.h - 12, s[1] + 14);
    ctx.fillStyle = name === 'N' ? P.cardinalN : P.cardinal;
    ctx.globalAlpha = major ? 1 : 0.75;
    ctx.fillText(name, s[0], y);
    ctx.globalAlpha = 1;
    obstacles.push({ id: `card:${name}`, x: s[0] - 12, y: y - 8, w: 24, h: 16 });
  }

  // ---- selection ----
  if (sel) {
    const w = selectedWorld(sel, fc);
    if (w && proj.project(w, s) && proj.inView(s[0], s[1], 30)) {
      const t = performance.now() / 1000;
      const r = 13 + Math.sin(t * 3) * 1.5;
      ctx.strokeStyle = P.select; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.95;
      for (let k = 0; k < 4; k++) {
        const a0 = (k * Math.PI) / 2 + Math.PI / 4 - 0.45 + t * 0.4;
        ctx.beginPath(); ctx.arc(s[0], s[1], r, a0, a0 + 0.9); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      addLabel(`sel:${sel.key}`, sel.kind === 'dso' && sel.id ? `${sel.id}${sel.name !== sel.id ? ' ' + sel.name : ''}` : sel.name, s[0], s[1], 1000, P.select, FONT, r);
    }
  }

  // ---- GoTo target + slew line + reticle ----
  const mount = st.mount;
  const retW = mount?.pointing ? fc.toWorld(mount.pointing.ra, mount.pointing.dec, [0, 0, 0]) : null;
  let tgtW: Vec3 | null = null;
  if (mount?.target) {
    const t = mount.target;
    if (t.kind === 'radec') tgtW = fc.toWorld(t.ra, t.dec, [0, 0, 0]);
    else if (t.kind === 'body') tgtW = fc.bodies.find((b) => b.body === t.body)?.world ?? null;
    else tgtW = altAzToWorld(t.az, t.alt, [0, 0, 0]);
  }
  if (retW && tgtW && mount && mount.slew.startsWith('goto')) {
    ctx.strokeStyle = P.target; ctx.lineWidth = 1.4; ctx.setLineDash([6, 5]); ctx.globalAlpha = 0.85;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i <= 48; i++) {
      const p = slerp(retW, tgtW, i / 48);
      if (proj.project(p, s)) { if (pen) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); pen = true; } else pen = false;
    }
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  if (tgtW && proj.project(tgtW, s) && proj.inView(s[0], s[1], 20)) {
    const r = 10;
    ctx.strokeStyle = P.target; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(s[0], s[1] - r); ctx.lineTo(s[0] + r, s[1]); ctx.lineTo(s[0], s[1] + r); ctx.lineTo(s[0] - r, s[1]); ctx.closePath(); ctx.stroke();
    addLabel('target', `▸ ${mount!.target!.name}`, s[0], s[1], 950, P.target, FONT, r + 3);
  }
  if (retW) {
    const onScreen = proj.project(retW, s) && proj.inView(s[0], s[1], 10);
    if (onScreen) drawReticle(ctx, s[0], s[1], proj.pxPerDeg(), P.reticle, mount?.slew !== 'idle');
    else drawOffscreenArrow(ctx, retW, fc, P.reticle);
  }

  // ---- labels ----
  const placed = declutterLabels(labels.map((l) => l.cand), proj.w, proj.h, { obstacles });
  const byId = new Map(labels.map((l) => [l.cand.id, l]));
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
  for (const p of placed) {
    const l = byId.get(p.id)!;
    ctx.font = l.font;
    ctx.lineWidth = 3; ctx.strokeStyle = P.halo; ctx.strokeText(l.text, p.x + 1, p.y + 1);
    ctx.fillStyle = l.color; ctx.fillText(l.text, p.x + 1, p.y + 1);
  }
}

function drawSunKeepOut(ctx: CanvasRenderingContext2D, sun: Vec3, fc: FrameContext, night: boolean, keepOutDeg: number) {
  const proj = fc.proj;
  // orthonormal basis around the sun direction
  const a: Vec3 = Math.abs(sun[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u: Vec3 = [sun[1] * a[2] - sun[2] * a[1], sun[2] * a[0] - sun[0] * a[2], sun[0] * a[1] - sun[1] * a[0]];
  const un = Math.hypot(u[0], u[1], u[2]); u[0] /= un; u[1] /= un; u[2] /= un;
  const v: Vec3 = [sun[1] * u[2] - sun[2] * u[1], sun[2] * u[0] - sun[0] * u[2], sun[0] * u[1] - sun[1] * u[0]];
  const r = keepOutDeg * Math.PI / 180, cr = Math.cos(r), sr = Math.sin(r);
  const s: [number, number] = [0, 0];
  const pts: [number, number][] = [];
  let anyIn = false, allFront = true;
  for (let i = 0; i <= 96; i++) {
    const t = (i / 96) * Math.PI * 2, c = Math.cos(t) * sr, d = Math.sin(t) * sr;
    const p: Vec3 = [sun[0] * cr + u[0] * c + v[0] * d, sun[1] * cr + u[1] * c + v[1] * d, sun[2] * cr + u[2] * c + v[2] * d];
    if (proj.project(p, s)) { pts.push([s[0], s[1]]); if (proj.inView(s[0], s[1])) anyIn = true; } else { pts.push([NaN, NaN]); allFront = false; }
  }
  const sunOn = proj.project(sun, s) && proj.inView(s[0], s[1]);
  if (!anyIn && !sunOn) return;
  ctx.save();
  const col = night ? '#ff3b25' : '#ff4d3d';
  ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.setLineDash([8, 5]);
  ctx.beginPath();
  let pen = false;
  for (const [x, y] of pts) { if (Number.isNaN(x)) { pen = false; continue; } if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y); pen = true; }
  ctx.stroke();
  if (allFront) { ctx.fillStyle = night ? 'rgba(255,40,20,0.06)' : 'rgba(255,60,40,0.08)'; ctx.fill(); }
  ctx.setLineDash([]);
  // label at the top of the circle
  const top = pts.filter((p) => !Number.isNaN(p[0]) && proj.inView(p[0], p[1])).sort((p, q) => p[1] - q[1])[0];
  if (top) { ctx.font = FONT_SMALL; ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(`☀ ${keepOutDeg}° keep-out: no GoTo`, top[0], top[1] - 3); }
  ctx.restore();
}

function selectedWorld(o: SkyObject, fc: FrameContext): Vec3 | null {
  if (o.kind === 'body' && o.body) return fc.bodies.find((b) => b.body === o.body)?.world ?? null;
  return fc.toWorld(o.ra, o.dec, [0, 0, 0]);
}

function drawDsoSymbol(ctx: CanvasRenderingContext2D, type: DsoType, x: number, y: number, rx: number, ry: number, color: string, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 1.2;
  ctx.beginPath();
  const r = Math.max(rx, ry);
  switch (type) {
    case 'galaxy':
      ctx.ellipse(x, y, rx, Math.max(2.5, ry), -0.35, 0, Math.PI * 2); ctx.stroke(); break;
    case 'open-cluster':
      ctx.setLineDash([2.5, 2.5]); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); break;
    case 'globular-cluster':
      ctx.arc(x, y, r, 0, Math.PI * 2); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke(); break;
    case 'nebula': {
      const w = rx, h = ry, k = Math.min(w, h) * 0.45;
      ctx.roundRect(x - w, y - h, 2 * w, 2 * h, k); ctx.stroke(); break;
    }
    case 'planetary-nebula':
      ctx.arc(x, y, r * 0.75, 0, Math.PI * 2);
      for (let i = 0; i < 4; i++) { const a = (i * Math.PI) / 2; ctx.moveTo(x + Math.cos(a) * r * 0.75, y + Math.sin(a) * r * 0.75); ctx.lineTo(x + Math.cos(a) * r * 1.3, y + Math.sin(a) * r * 1.3); }
      ctx.stroke(); break;
    case 'supernova-remnant':
      ctx.setLineDash([4, 3]); ctx.roundRect(x - rx, y - ry, 2 * rx, 2 * ry, 2); ctx.stroke(); break;
    case 'double-star':
      ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.moveTo(x - 8, y); ctx.lineTo(x - 5, y); ctx.moveTo(x + 5, y); ctx.lineTo(x + 8, y); ctx.stroke(); break;
    default:
      ctx.rect(x - 4, y - 4, 8, 8); ctx.stroke();
  }
  ctx.restore();
}

function drawBody(ctx: CanvasRenderingContext2D, b: BodyPos, x: number, y: number, ppd: number, fc: FrameContext, P: Palette, night: boolean): number {
  const color = P.body(b.body);
  if (b.body === 'Sun' || b.body === 'Moon') {
    const r = Math.max(b.body === 'Sun' ? 9 : 8, 0.266 * ppd);
    if (b.body === 'Sun') {
      const g = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 4);
      g.addColorStop(0, night ? 'rgba(220,60,40,0.5)' : 'rgba(255,240,200,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      return r;
    }
    // Moon with phase: bright limb toward the Sun on screen
    const sun = fc.bodies[0];
    const toward = slerp(b.world, sun.world, 0.02);
    const s2: [number, number] = [0, 0];
    let ang = 0;
    if (fc.proj.project(toward, s2)) ang = Math.atan2(s2[1] - y, s2[0] - x);
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = night ? 'rgba(60,8,4,0.9)' : 'rgba(40,44,52,0.92)';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    const k = b.phase; // illuminated fraction
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false); // lit half toward +x (sun side)
    const ex = r * Math.abs(1 - 2 * k);
    ctx.ellipse(0, 0, ex, r, 0, Math.PI / 2, -Math.PI / 2, k < 0.5);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = night ? 'rgba(200,50,30,0.5)' : 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    return r;
  }
  const r = Math.max(2.5, Math.min(7, 4.6 - b.mag * 0.55));
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.6);
  g.addColorStop(0, color); g.addColorStop(0.35, color); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, Math.PI * 2); ctx.fill();
  if (b.body === 'Saturn') {
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(x, y, r * 2.1, r * 0.7, -0.4, 0, Math.PI * 2); ctx.stroke();
  }
  return r;
}

function drawReticle(ctx: CanvasRenderingContext2D, x: number, y: number, ppd: number, color: string, moving: boolean) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 1.6;
  ctx.shadowColor = color; ctx.shadowBlur = 6;
  const r = 14;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - r - 10, y); ctx.lineTo(x - r + 4, y); ctx.moveTo(x + r - 4, y); ctx.lineTo(x + r + 10, y);
  ctx.moveTo(x, y - r - 10); ctx.lineTo(x, y - r + 4); ctx.moveTo(x, y + r - 4); ctx.lineTo(x, y + r + 10);
  ctx.stroke();
  ctx.shadowBlur = 0;
  // Telrad-style sky rings (0.5°, 2°, 4°) when they are a useful size
  ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
  for (const deg of [0.5, 2, 4]) {
    const rr = deg * ppd;
    if (rr > r + 6 && rr < 2000) { ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke(); }
  }
  if (moving) { ctx.globalAlpha = 0.6 + 0.4 * Math.sin(performance.now() / 120); ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
  ctx.restore();
}

function drawOffscreenArrow(ctx: CanvasRenderingContext2D, w: Vec3, fc: FrameContext, color: string) {
  const p = fc.proj;
  // direction in camera plane
  const x = w[0] * p.right[0] + w[1] * p.right[1] + w[2] * p.right[2];
  const y = w[0] * p.up[0] + w[1] * p.up[1] + w[2] * p.up[2];
  const a = Math.atan2(-y, x);
  const cx = p.w / 2, cy = p.h / 2;
  const R = Math.min(cx, cy) - 28;
  const ax = cx + Math.cos(a) * R, ay = cy + Math.sin(a) * R;
  ctx.save(); ctx.translate(ax, ay); ctx.rotate(a);
  ctx.fillStyle = color; ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-6, -8); ctx.lineTo(-2, 0); ctx.lineTo(-6, 8); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.font = FONT_SMALL; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('scope', ax - Math.cos(a) * 22, ay - Math.sin(a) * 22);
}

// ---------------------------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------------------------
export function pickAt(x: number, y: number, fc: FrameContext, st: AppState, cache: OverlayCache): SkyObject | null {
  const cat = cache.catalog!;
  const proj = fc.proj;
  const groundOn = st.layers.ground;
  let best: SkyObject | null = null;
  let bestScore = 18; // px
  const consider = (o: SkyObject, w: Vec3, bonus: number, radius = 0) => {
    if (groundOn && w[1] < -0.004) return;
    if (!proj.project(w, tmpS)) return;
    const d = Math.hypot(tmpS[0] - x, tmpS[1] - y);
    const eff = Math.max(0, d - radius) - bonus;
    if (d < 18 + radius && eff < bestScore) { bestScore = eff; best = o; }
  };
  const w: Vec3 = [0, 0, 0];
  if (st.layers.planets) for (const b of fc.bodies) { const o = cat.bodies.find((k) => k.body === b.body)!; consider({ ...o, ra: b.ra, dec: b.dec, mag: b.mag }, b.world, 6); }
  const ppd = proj.pxPerDeg();
  if (st.layers.dsos) {
    const lim = dsoLabelMagLimit(proj.fov) + 1.5;
    cat.dsos.forEach((o, i) => {
      if ((o.mag ?? 11) > lim && !/^M\d+$/.test(o.id ?? '')) return;
      const r = Math.min(40, ((o.sizeArcmin?.[0] ?? 0) / 120) * ppd);
      consider(o, fc.toWorld(o.ra, o.dec, w), 3, r * 0.6);
    });
  }
  for (const o of cat.namedStars) {
    if ((o.mag ?? 9) > fc.magLimit) break;
    consider(o, fc.toWorld(o.ra, o.dec, w), 4 - (o.mag ?? 3) * 0.5);
  }
  // anonymous stars: only if nothing named is close
  if (!best || bestScore > 6) {
    const s = cat.stars;
    let bi = -1, bd = 12;
    for (let i = 0; i < s.count; i++) {
      if (s.mag[i] > fc.magLimit) break;
      const v = worldFromPacked(fc, cache.starVec, i, w);
      if (groundOn && v[1] < -0.004) continue;
      if (!proj.project(v, tmpS)) continue;
      const d = Math.hypot(tmpS[0] - x, tmpS[1] - y) - (6 - s.mag[i]) * 0.4;
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi >= 0 && bd < bestScore) {
      const hip = s.hip[bi];
      const named = hip ? cat.namedStars.find((n) => n.hip === hip) : undefined;
      best = named ?? {
        key: `star:i${bi}`, kind: 'star', name: hip ? `HIP ${hip}` : `Star (mag ${s.mag[bi].toFixed(1)})`, id: hip ? `HIP ${hip}` : undefined,
        aliases: [], ra: s.ra[bi], dec: s.dec[bi], mag: s.mag[bi], bv: s.bv[bi], typeLabel: 'Star', hip: hip || undefined, starIndex: bi,
      };
    }
  }
  return best;
}

export { DSO_TYPE_LABEL };
