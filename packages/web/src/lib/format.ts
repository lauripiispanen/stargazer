// Formatting helpers. Pure.
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** RA degrees -> "12h 34m 56s" */
export function fmtRa(deg: number): string {
  const h = ((((deg % 360) + 360) % 360) / 15);
  let hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = Math.round(((h - hh) * 60 - mm) * 60);
  if (ss === 60) { ss = 0; mm++; } if (mm === 60) { mm = 0; hh = (hh + 1) % 24; }
  return `${pad(hh)}h ${pad(mm)}m ${pad(ss)}s`;
}

/** Signed degrees -> "+12° 34′ 56″" */
export function fmtDms(deg: number, signed = true): string {
  const s = deg < 0 ? '−' : signed ? '+' : '';
  const a = Math.abs(deg);
  let d = Math.floor(a), m = Math.floor((a - d) * 60), sec = Math.round(((a - d) * 60 - m) * 60);
  if (sec === 60) { sec = 0; m++; } if (m === 60) { m = 0; d++; }
  return `${s}${d}° ${pad(m)}′ ${pad(sec)}″`;
}

export function fmtDeg(deg: number | null | undefined, digits = 1): string {
  return deg == null || !Number.isFinite(deg) ? '—' : `${deg.toFixed(digits)}°`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compassPoint(az: number): string {
  return COMPASS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
}

export function fmtTime(ms: number | null | undefined, withSeconds = false): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return withSeconds ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

export function fmtSize(size?: [number, number]): string {
  if (!size || !size[0]) return '—';
  const f = (x: number) => (x >= 60 ? `${(x / 60).toFixed(1)}°` : x >= 1 ? `${+x.toFixed(1)}′` : `${Math.round(x * 60)}″`);
  return size[1] && Math.abs(size[1] - size[0]) > 0.01 ? `${f(size[0])} × ${f(size[1])}` : f(size[0]);
}

export function fmtMag(m?: number | null): string { return m == null || !Number.isFinite(m) ? '—' : m.toFixed(1); }

/** For <input type="datetime-local"> */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
