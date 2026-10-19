// Catalog data model + loading/normalisation of data/*.json (formats in ARCHITECTURE.md). Pure except `loadCatalog`.
import type { SolarBody } from '@stargazer/shared/api.ts';

export type DsoType =
  | 'galaxy' | 'open-cluster' | 'globular-cluster' | 'nebula' | 'planetary-nebula' | 'supernova-remnant' | 'double-star' | 'other';

export const DSO_TYPE_LABEL: Record<DsoType, string> = {
  galaxy: 'Galaxy', 'open-cluster': 'Open cluster', 'globular-cluster': 'Globular cluster', nebula: 'Nebula',
  'planetary-nebula': 'Planetary nebula', 'supernova-remnant': 'Supernova remnant', 'double-star': 'Double star', other: 'Other',
};

export interface StarsFile { fields: string[]; rows: number[][] }
export type StarNamesFile = Record<string, { name?: string; bayer?: string }>;
export interface DsoRecord {
  id: string; name?: string; type: DsoType | string; ra: number; dec: number; mag?: number | null;
  sizeArcmin?: [number, number] | number[] | null; con?: string; alt?: string[];
}
export interface ConstellationRecord { id: string; name: string; lines: [number, number][][]; label: [number, number] }
export type MilkyWayFile = [number, number][][];
export interface City { name: string; country: string; lat: number; lon: number }

/** Columnar star catalog, ready for GPU upload. Sorted by mag ascending (brightest first). */
export interface StarCatalog {
  count: number;
  ra: Float32Array; dec: Float32Array; mag: Float32Array; bv: Float32Array; hip: Int32Array;
  /** index into the arrays by HIP number */
  byHip: Map<number, number>;
}

export type SkyObjectKind = 'star' | 'dso' | 'body' | 'constellation';

/** A selectable / searchable thing on the sky. */
export interface SkyObject {
  key: string; // unique, e.g. 'star:91262', 'dso:M31', 'body:Jupiter', 'con:Ori'
  kind: SkyObjectKind;
  name: string; // display name
  id?: string; // catalog id (M31, HIP 91262)
  aliases: string[]; // other names for search
  ra: number; dec: number; // J2000 deg (bodies: last computed)
  mag?: number;
  bv?: number;
  type?: DsoType;
  typeLabel: string;
  sizeArcmin?: [number, number];
  con?: string;
  hip?: number;
  body?: SolarBody;
  starIndex?: number;
}

export interface Catalog {
  stars: StarCatalog;
  starNames: StarNamesFile;
  namedStars: SkyObject[]; // stars with a proper name or bayer designation
  dsos: SkyObject[];
  dsoRecords: DsoRecord[];
  constellations: ConstellationRecord[];
  milkyWay: MilkyWayFile;
  cities: City[];
  bodies: SkyObject[];
  /** raw stars.json (needed by shared tonight/doubles helpers) */
  starsFile: StarsFile | null;
  /** data files that could not be loaded */
  missing: string[];
}

export const SOLAR_BODIES: SolarBody[] = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];

const DSO_TYPES = new Set(Object.keys(DSO_TYPE_LABEL));
export function normDsoType(t: string | undefined): DsoType {
  if (!t) return 'other';
  const s = t.toLowerCase().replace(/[\s_]+/g, '-');
  if (DSO_TYPES.has(s)) return s as DsoType;
  if (s.startsWith('gal')) return 'galaxy';
  if (s.includes('globular')) return 'globular-cluster';
  if (s.includes('open') || s === 'cluster') return 'open-cluster';
  if (s.includes('planetary')) return 'planetary-nebula';
  if (s.includes('supernova') || s === 'snr') return 'supernova-remnant';
  if (s.includes('neb')) return 'nebula';
  if (s.includes('double')) return 'double-star';
  return 'other';
}

export function parseStars(file: StarsFile): StarCatalog {
  const f = file.fields ?? ['ra', 'dec', 'mag', 'bv', 'hip'];
  const iRa = f.indexOf('ra'), iDec = f.indexOf('dec'), iMag = f.indexOf('mag'), iBv = f.indexOf('bv'), iHip = f.indexOf('hip');
  const rows = file.rows ?? [];
  const n = rows.length;
  const cat: StarCatalog = {
    count: n, ra: new Float32Array(n), dec: new Float32Array(n), mag: new Float32Array(n), bv: new Float32Array(n),
    hip: new Int32Array(n), byHip: new Map(),
  };
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    cat.ra[i] = r[iRa]; cat.dec[i] = r[iDec]; cat.mag[i] = r[iMag];
    cat.bv[i] = iBv >= 0 && r[iBv] != null && Number.isFinite(r[iBv]) ? r[iBv] : 0.6;
    const hip = iHip >= 0 ? r[iHip] | 0 : 0;
    cat.hip[i] = hip;
    if (hip) cat.byHip.set(hip, i);
  }
  return cat;
}

export function buildNamedStars(stars: StarCatalog, names: StarNamesFile): SkyObject[] {
  const out: SkyObject[] = [];
  for (const [hipStr, n] of Object.entries(names)) {
    const hip = Number(hipStr);
    const idx = stars.byHip.get(hip);
    if (idx === undefined) continue;
    const display = n.name || n.bayer || `HIP ${hip}`;
    const aliases = [n.name, n.bayer, `HIP ${hip}`].filter((s): s is string => !!s && s !== display);
    if (n.bayer) aliases.push(...bayerAliases(n.bayer));
    out.push({
      key: `star:${hip}`, kind: 'star', name: display, id: `HIP ${hip}`, aliases, ra: stars.ra[idx], dec: stars.dec[idx],
      mag: stars.mag[idx], bv: stars.bv[idx], typeLabel: 'Star', hip, starIndex: idx, con: n.bayer?.split(' ').pop(),
    });
  }
  out.sort((a, b) => (a.mag ?? 99) - (b.mag ?? 99));
  return out;
}

const GREEK: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ι: 'iota', κ: 'kappa',
  λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', ο: 'omicron', π: 'pi', ρ: 'rho', σ: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi',
  χ: 'chi', ψ: 'psi', ω: 'omega',
};
/** 'α Lyr' -> ['alpha Lyr'] so users can type Greek letter names. */
export function bayerAliases(bayer: string): string[] {
  const first = [...bayer][0];
  const g = GREEK[first];
  return g ? [g + bayer.slice(first.length)] : [];
}

export function buildDsos(records: DsoRecord[]): SkyObject[] {
  return records
    .filter((r) => Number.isFinite(r.ra) && Number.isFinite(r.dec) && r.id)
    .map((r) => {
      const type = normDsoType(r.type);
      const size = r.sizeArcmin && r.sizeArcmin.length ? [r.sizeArcmin[0] ?? 0, r.sizeArcmin[1] ?? r.sizeArcmin[0] ?? 0] as [number, number] : undefined;
      const name = r.name && r.name !== r.id ? `${r.name}` : r.id;
      return {
        key: `dso:${r.id}`, kind: 'dso' as const, name, id: r.id, aliases: [r.id, ...(r.alt ?? []), ...(r.name ? [r.name] : [])],
        ra: r.ra, dec: r.dec, mag: r.mag ?? undefined, type, typeLabel: DSO_TYPE_LABEL[type], sizeArcmin: size, con: r.con,
      };
    });
}

export function buildBodies(): SkyObject[] {
  return SOLAR_BODIES.map((b) => ({
    key: `body:${b}`, kind: 'body', name: b, id: b, aliases: [], ra: 0, dec: 0, body: b,
    typeLabel: b === 'Sun' ? 'Star (Sun)' : b === 'Moon' ? 'Moon' : 'Planet',
  }));
}

/** Short display label for a DSO on the map: "M31" or "NGC 7000". */
export function dsoShortLabel(o: SkyObject): string { return o.id ?? o.name; }
/** Full title: "M31 · Andromeda Galaxy". */
export function objectTitle(o: SkyObject): string {
  if (o.kind === 'dso' && o.id && o.name !== o.id) return `${o.id} · ${o.name}`;
  return o.name;
}

// ---------- loading (browser) ----------

async function fetchJson<T>(file: string): Promise<{ data: T } | null> {
  const tryUrl = async (url: string) => {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') ?? '';
      if (ct.includes('text/html')) return null; // SPA fallback page, not JSON
      return (await r.json()) as T;
    } catch { return null; }
  };
  const real = await tryUrl(`/data/${file}`);
  return real != null ? { data: real } : null;
}

export async function loadCatalog(opts: { extraDsos?: (stars: StarsFile) => DsoRecord[] } = {}): Promise<Catalog> {
  const [stars, names, dso, cons, mw, cities] = await Promise.all([
    fetchJson<StarsFile>('stars.json'),
    fetchJson<StarNamesFile>('star-names.json'),
    fetchJson<DsoRecord[]>('dso.json'),
    fetchJson<ConstellationRecord[]>('constellations.json'),
    fetchJson<MilkyWayFile>('milkyway.json'),
    fetchJson<City[]>('cities.json'),
  ]);
  const missing: string[] = [];
  const files = { stars, names, dso, cons, mw, cities };
  for (const [k, v] of Object.entries(files)) if (!v) missing.push(k);
  const starCat = parseStars(stars?.data ?? { fields: [], rows: [] });
  const starNames = names?.data ?? {};
  const base = Array.isArray(dso?.data) ? dso!.data : [];
  const ids = new Set(base.map((d) => d.id));
  let extra: DsoRecord[] = [];
  try { extra = stars && opts.extraDsos ? opts.extraDsos(stars.data) : []; } catch (e) { console.warn('extra DSOs failed', e); }
  const dsoRecords = [...base, ...extra.filter((d) => !ids.has(d.id))];
  return {
    stars: starCat,
    starNames,
    namedStars: buildNamedStars(starCat, starNames),
    dsoRecords,
    dsos: buildDsos(dsoRecords),
    constellations: Array.isArray(cons?.data) ? cons!.data : [],
    milkyWay: Array.isArray(mw?.data) ? mw!.data : [],
    cities: Array.isArray(cities?.data) ? cities!.data : [],
    bodies: buildBodies(),
    starsFile: stars?.data ?? null,
    missing,
  };
}
