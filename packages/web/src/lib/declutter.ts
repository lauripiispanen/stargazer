// Greedy label declutter: place labels in priority order, skipping any that overlap an already
// placed one. Uses a uniform grid hash so it stays O(n) for a few thousand candidates. Pure.

export interface LabelCandidate {
  id: string;
  x: number; y: number; // anchor (screen px)
  w: number; h: number; // label box size
  priority: number; // higher = placed first
  /** offsets to try relative to the anchor (top-left of box). Default: right, then left, above, below. */
  offsets?: [number, number][];
}
export interface PlacedLabel { id: string; x: number; y: number; w: number; h: number }

const DEFAULT_OFFSETS = (w: number, h: number): [number, number][] => [
  [6, -h / 2], [-w - 6, -h / 2], [-w / 2, -h - 6], [-w / 2, 6],
];

export function declutterLabels(cands: LabelCandidate[], viewW: number, viewH: number, opts: { cell?: number; padding?: number; obstacles?: PlacedLabel[] } = {}): PlacedLabel[] {
  const cell = opts.cell ?? 64, pad = opts.padding ?? 2;
  const cols = Math.max(1, Math.ceil(viewW / cell)), rows = Math.max(1, Math.ceil(viewH / cell));
  const grid: PlacedLabel[][] = Array.from({ length: cols * rows }, () => []);
  const cellsOf = (b: PlacedLabel) => {
    const out: number[] = [];
    const c0 = Math.max(0, Math.floor(b.x / cell)), c1 = Math.min(cols - 1, Math.floor((b.x + b.w) / cell));
    const r0 = Math.max(0, Math.floor(b.y / cell)), r1 = Math.min(rows - 1, Math.floor((b.y + b.h) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(r * cols + c);
    return out;
  };
  const hits = (b: PlacedLabel) => {
    for (const ci of cellsOf(b)) for (const o of grid[ci]) {
      if (b.x < o.x + o.w + pad && b.x + b.w + pad > o.x && b.y < o.y + o.h + pad && b.y + b.h + pad > o.y) return true;
    }
    return false;
  };
  const insert = (b: PlacedLabel) => { for (const ci of cellsOf(b)) grid[ci].push(b); };
  for (const o of opts.obstacles ?? []) insert(o);

  const placed: PlacedLabel[] = [];
  const sorted = [...cands].sort((a, b) => b.priority - a.priority);
  for (const c of sorted) {
    for (const [dx, dy] of c.offsets ?? DEFAULT_OFFSETS(c.w, c.h)) {
      const b = { id: c.id, x: c.x + dx, y: c.y + dy, w: c.w, h: c.h };
      if (b.x < 0 || b.y < 0 || b.x + b.w > viewW || b.y + b.h > viewH) continue;
      if (hits(b)) continue;
      insert(b); placed.push(b); break;
    }
  }
  return placed;
}

/** Faintest DSO magnitude to label at a given vertical FOV (deg). Wider view -> only bright ones. */
export function dsoLabelMagLimit(fovDeg: number): number {
  if (fovDeg >= 90) return 5.5;
  if (fovDeg <= 5) return 14;
  return 5.5 + (Math.log(90 / fovDeg) / Math.log(18)) * 8.5;
}

/** Faintest star magnitude to label by name at a given FOV. */
export function starLabelMagLimit(fovDeg: number): number {
  if (fovDeg >= 100) return 1.5;
  if (fovDeg <= 10) return 6.5;
  return 1.5 + (Math.log(100 / fovDeg) / Math.log(10)) * 5;
}

/** Faintest star magnitude rendered at a given FOV (naked-eye-ish wide, telescopic zoomed). */
export function starMagLimit(fovDeg: number): number {
  return Math.min(8.5, Math.max(5.2, 6.0 + 2.2 * Math.log10(60 / fovDeg)));
}
