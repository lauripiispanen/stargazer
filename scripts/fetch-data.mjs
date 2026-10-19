#!/usr/bin/env node
// Downloads public catalogs and converts them into the offline data files in data/
// (formats in ARCHITECTURE.md). Raw downloads are cached in data/raw (gitignored).
// Usage: node scripts/fetch-data.mjs [--force]   (--force re-downloads raw files)
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const RAW = join(DATA, 'raw');
const FORCE = process.argv.includes('--force');

// Upstream repos are pinned to exact commits so every checkout builds identical data.
// GeoNames has no versioned URL; it only feeds the offline city picker, so drift there is harmless.
const HYG = 'https://raw.githubusercontent.com/astronexus/HYG-Database/c7f7f883fe678cc7680169a50ccd7dcc49b060ce';
const OPENNGC = 'https://raw.githubusercontent.com/mattiaverga/OpenNGC/be3cd6c5498806a2fbb2f7e0452ef802dbb02be0';
const D3C = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/7e720a3de062059d4c5400a379146a601d9010e0';
const SOURCES = {
  hyg: `${HYG}/hyg/CURRENT/hygdata_v41.csv`,
  ngc: `${OPENNGC}/database_files/NGC.csv`,
  ngcAddendum: `${OPENNGC}/database_files/addendum.csv`,
  conLines: `${D3C}/data/constellations.lines.json`,
  conNames: `${D3C}/data/constellations.json`,
  milkyWay: `${D3C}/data/mw.json`,
  cities: 'https://download.geonames.org/export/dump/cities15000.zip',
};

/** Proper motion is applied from J2000.0 to this epoch (positions stay in the J2000 equinox/frame). */
const STAR_EPOCH = 2026.0;
const STAR_MAG_LIMIT = 8.0;
/** NGC/IC objects that are neither Messier nor Caldwell are kept down to this magnitude (V, else B). */
const NGC_MAG_LIMIT = 10.0;
const CITY_COUNT = 500;
/**
 * V magnitudes for notable objects that OpenNGC lists without one
 * (globulars: Harris 2010 catalogue V_t; clusters: SEDS / common catalogue values).
 */
const MAG_OVERRIDES = {
  M22: 5.1, M35: 5.3, M62: 6.5, M69: 7.6, M70: 7.9, M71: 8.2, M107: 7.9,
  C14: 3.7, C41: 0.5, 'NGC 1851': 7.1, 'NGC 2362': 4.1, 'NGC 3201': 6.8, 'NGC 4755': 4.2, 'NGC 4833': 6.9,
  'NGC 5286': 7.3, 'NGC 5694': 10.2, 'NGC 6101': 9.2, 'NGC 6193': 5.2, 'NGC 6352': 8.0, 'NGC 6541': 6.3,
  'NGC 6934': 8.8, 'IC 2602': 1.9,
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function download(key) {
  const url = SOURCES[key];
  const file = join(RAW, url.split('/').pop());
  if (!FORCE && existsSync(file) && statSync(file).size > 0) return file;
  process.stdout.write(`downloading ${url} ... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
  return file;
}

/** Minimal RFC 4180 CSV line parser (handles quoted fields). */
function parseCsvLine(line, sep = ',') {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function readTable(file, sep) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.length);
  const header = parseCsvLine(lines[0], sep);
  return lines.slice(1).map((l) => {
    const cols = parseCsvLine(l, sep);
    return Object.fromEntries(header.map((h, i) => [h, cols[i] ?? '']));
  });
}

/** Extract the single (or named) file from a zip archive using the central directory. */
function unzipEntry(buf, wanted) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('zip: no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (!wanted || name === wanted) {
      const lnlen = buf.readUInt16LE(local + 26);
      const lelen = buf.readUInt16LE(local + 28);
      const data = buf.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error(`zip: ${wanted} not found`);
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const ra360 = (lon) => round(((lon % 360) + 360) % 360, 4);
const num = (s) => (s === undefined || s === '' ? null : Number(s));

function writeJson(name, value, pretty = false) {
  const file = join(DATA, name);
  const text = pretty ? JSON.stringify(value, null, 1) : JSON.stringify(value);
  writeFileSync(file, text + '\n');
  console.log(`wrote data/${name}: ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`);
}

// ---------------------------------------------------------------------------
// stars (HYG v4.1)
// ---------------------------------------------------------------------------
const GREEK = {
  Alp: 'α', Bet: 'β', Gam: 'γ', Del: 'δ', Eps: 'ε', Zet: 'ζ', Eta: 'η', The: 'θ', Iot: 'ι', Kap: 'κ', Lam: 'λ', Mu: 'μ',
  Nu: 'ν', Xi: 'ξ', Omi: 'ο', Pi: 'π', Rho: 'ρ', Sig: 'σ', Tau: 'τ', Ups: 'υ', Phi: 'φ', Chi: 'χ', Psi: 'ψ', Ome: 'ω',
};
const SUP = { 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

function bayerLabel(bayer, con) {
  if (!bayer || !con) return undefined;
  const [g, n] = bayer.split('-');
  const letter = GREEK[g] ?? g; // a few Bayer designations are Latin letters
  return `${letter}${n ? (SUP[n] ?? n) : ''} ${con}`;
}

function buildStars(file) {
  const rows = [];
  const names = {};
  const dt = STAR_EPOCH - 2000;
  for (const r of readTable(file, ',')) {
    if (r.id === '0') continue; // the Sun
    const mag = Number(r.mag);
    if (!(mag <= STAR_MAG_LIMIT)) continue;
    const hip = r.hip ? Number(r.hip) : 0;
    let ra = Number(r.ra) * 15;
    let dec = Number(r.dec);
    // Proper motion (mas/yr; pmra already includes cos(dec)).
    const pmra = Number(r.pmra) || 0;
    const pmdec = Number(r.pmdec) || 0;
    const cd = Math.cos((dec * Math.PI) / 180);
    if (Math.abs(cd) > 1e-6) ra += (pmra * dt) / 3.6e6 / cd;
    dec += (pmdec * dt) / 3.6e6;
    const bv = r.ci === '' ? 0.6 : Number(r.ci);
    rows.push([ra360(ra), round(dec, 4), round(mag, 2), round(bv, 2), hip]);
    if (hip) {
      const entry = {};
      if (r.proper) entry.name = r.proper;
      const b = bayerLabel(r.bayer, r.con);
      if (b) entry.bayer = b;
      if (entry.name || entry.bayer) names[hip] = entry;
    }
  }
  rows.sort((a, b) => a[2] - b[2]);
  return { stars: { fields: ['ra', 'dec', 'mag', 'bv', 'hip'], rows }, names };
}

// ---------------------------------------------------------------------------
// deep-sky objects (OpenNGC)
// ---------------------------------------------------------------------------
const TYPE_MAP = {
  G: 'galaxy', GPair: 'galaxy', GTrpl: 'galaxy', GGroup: 'galaxy',
  OCl: 'open-cluster', '*Ass': 'open-cluster', GCl: 'globular-cluster',
  PN: 'planetary-nebula', SNR: 'supernova-remnant',
  HII: 'nebula', EmN: 'nebula', Neb: 'nebula', RfN: 'nebula', 'Cl+N': 'nebula', DrkN: 'nebula',
  '**': 'double-star', '*': 'other', Other: 'other',
};
/** Types worth listing as bright NGC/IC objects (not single/double stars or "other"). */
const NGC_TYPES = new Set(['galaxy', 'open-cluster', 'globular-cluster', 'planetary-nebula', 'supernova-remnant', 'nebula']);

const sexa = (s, hours) => {
  const neg = s.trim().startsWith('-');
  const [d, m, x] = s.replace(/^[+-]/, '').split(':').map(Number);
  const v = (d + (m || 0) / 60 + (x || 0) / 3600) * (neg ? -1 : 1);
  return hours ? v * 15 : v;
};
/** "NGC0224" -> "NGC 224", "IC0434" -> "IC 434", "NGC5194A" -> "NGC 5194A" */
const catName = (n) => {
  const m = /^(NGC|IC)0*(\d+)(.*)$/.exec(n);
  return m ? `${m[1]} ${m[2]}${m[3]}` : n;
};

function buildDso(ngcFile, addFile) {
  const rows = [...readTable(ngcFile, ';'), ...readTable(addFile, ';')];
  const byName = new Map(rows.map((r) => [r.Name, r]));
  // Duplicates carrying a Messier number pass it to their master entry.
  for (const r of rows) {
    if (r.Type !== 'Dup' || !r.M) continue;
    const master = r.NGC ? byName.get(`NGC${r.NGC.padStart(4, '0')}`) : r.IC ? byName.get(`IC${r.IC.padStart(4, '0')}`) : null;
    if (master && !master.M) master.M = r.M;
  }
  // M102 is ambiguous (OpenNGC marks it a duplicate of M101); most lists use NGC 5866.
  if (!rows.some((r) => r.Type !== 'Dup' && Number(r.M) === 102)) {
    const n5866 = byName.get('NGC5866');
    if (n5866 && !n5866.M) n5866.M = '102';
  }

  const out = [];
  for (const r of rows) {
    if (['Dup', 'NonEx', 'Nova', ''].includes(r.Type)) continue;
    const type = TYPE_MAP[r.Type] ?? 'other';
    const messier = r.M ? Number(r.M) : null;
    const caldwellIds = (r.Identifiers.match(/(?:^|,)C (\d{3})(?=,|$)/g) ?? []).map((s) => Number(s.replace(/\D/g, '')));
    const addendumC = /^C(\d{3})$/.exec(r.Name);
    if (addendumC) caldwellIds.push(Number(addendumC[1]));
    const isNgcIc = /^(NGC|IC)\d/.test(r.Name);
    const vmag = num(r['V-Mag']);
    const bmag = num(r['B-Mag']);
    const mag = vmag ?? bmag;
    const keep = messier !== null || caldwellIds.length > 0 || (isNgcIc && NGC_TYPES.has(type) && mag !== null && mag <= NGC_MAG_LIMIT);
    if (!keep) continue;

    const common = r['Common names'] ? r['Common names'].split(',').map((s) => s.trim()).filter(Boolean) : [];
    const id = messier !== null ? `M${messier}` : isNgcIc ? catName(r.Name) : addendumC ? `C${caldwellIds[0]}` : r.Name;
    const alt = [];
    if (isNgcIc && id !== catName(r.Name)) alt.push(catName(r.Name));
    if (r.NGC && !isNgcIc) alt.push(`NGC ${Number(r.NGC.split(',')[0]) || r.NGC}`);
    for (const c of caldwellIds) if (`C${c}` !== id) alt.push(`C${c}`);
    if (!isNgcIc && !addendumC && !/^M\d+$/.test(r.Name)) alt.push(r.Name.replace(/^([A-Za-z]+)0*(\d+)$/, '$1 $2')); // Mel022 -> Mel 22
    alt.push(...common.slice(1));

    const e = { id };
    if (common[0]) e.name = common[0];
    e.type = type;
    e.ra = round(sexa(r.RA, true), 4);
    e.dec = round(sexa(r.Dec, false), 4);
    const magOut = mag ?? MAG_OVERRIDES[id] ?? null;
    if (magOut !== null) e.mag = round(magOut, 1);
    const maj = num(r.MajAx);
    const min = num(r.MinAx);
    if (maj) e.sizeArcmin = [round(maj, 1), round(min ?? maj, 1)];
    if (r.Const) e.con = r.Const;
    if (alt.length) e.alt = [...new Set(alt)];
    out.push(e);
  }
  const rank = (e) => {
    const m = /^M(\d+)$/.exec(e.id);
    if (m) return [0, Number(m[1])];
    const c = /^C(\d+)$/.exec(e.id);
    if (c) return [1, Number(c[1])];
    const n = /^(NGC|IC) (\d+)/.exec(e.id);
    if (n) return [n[1] === 'NGC' ? 2 : 3, Number(n[2])];
    return [4, 0];
  };
  out.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || a.id.localeCompare(b.id);
  });
  return out;
}

// ---------------------------------------------------------------------------
// constellations and Milky Way (d3-celestial)
// ---------------------------------------------------------------------------
function buildConstellations(linesFile, namesFile) {
  // Serpens appears as two features (Caput and Cauda) with the same id: merge them.
  const lines = [];
  for (const f of JSON.parse(readFileSync(linesFile, 'utf8')).features) {
    const prev = lines.find((g) => g.id === f.id);
    if (prev) prev.geometry = { ...prev.geometry, coordinates: [...prev.geometry.coordinates, ...f.geometry.coordinates] };
    else lines.push(f);
  }
  const names = new Map(JSON.parse(readFileSync(namesFile, 'utf8')).features.map((f) => [f.id, f]));
  return lines.map((f) => {
    const n = names.get(f.id);
    return {
      id: f.id,
      name: n?.properties.name ?? f.id,
      lines: f.geometry.coordinates.map((line) => line.map(([lon, lat]) => [ra360(lon), round(lat, 4)])),
      label: n ? [ra360(n.geometry.coordinates[0]), round(n.geometry.coordinates[1], 2)] : null,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** Douglas-Peucker polyline simplification (planar, degrees). */
function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [x1, y1] = points[a];
    const [x2, y2] = points[b];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      // Distance to the chord (or to the endpoint when the chord is degenerate, as in closed rings).
      const d = len < 1e-9
        ? Math.hypot(points[i][0] - x1, points[i][1] - y1)
        : Math.abs(dy * points[i][0] - dx * points[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > maxD) [maxD, idx] = [d, i];
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function buildMilkyWay(file, tol = 0.1) {
  const polys = [];
  for (const f of JSON.parse(readFileSync(file, 'utf8')).features) {
    const multi = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of multi) {
      for (const ring of poly) {
        const s = simplify(ring, tol);
        if (s.length >= 4) polys.push(s.map(([lon, lat]) => [round(((lon % 360) + 360) % 360, 2), round(lat, 2)]));
      }
    }
  }
  return polys;
}

// ---------------------------------------------------------------------------
// cities (GeoNames cities15000)
// ---------------------------------------------------------------------------
function buildCities(zipFile) {
  const text = unzipEntry(readFileSync(zipFile), 'cities15000.txt').toString('utf8');
  const all = text.split('\n').filter(Boolean).map((l) => {
    const c = l.split('\t');
    return { name: c[1], ascii: c[2], lat: Number(c[4]), lon: Number(c[5]), code: c[7], country: c[8], pop: Number(c[14]) };
  });
  all.sort((a, b) => b.pop - a.pop);
  const capitals = all.filter((c) => c.code === 'PPLC');
  const chosen = new Map();
  const add = (c) => {
    const key = `${c.name}|${c.country}`;
    if (!chosen.has(key)) chosen.set(key, c);
  };
  capitals.forEach(add); // every national capital, so each country has at least one entry
  for (const c of all) {
    if (chosen.size >= CITY_COUNT) break;
    add(c);
  }
  return [...chosen.values()]
    .sort((a, b) => b.pop - a.pop)
    .map((c) => ({ name: c.name, country: c.country, lat: round(c.lat, 2), lon: round(c.lon, 2) }));
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------
function validate({ stars, names, dso, constellations, milkyway, cities }) {
  const fail = [];
  const check = (cond, msg) => { if (!cond) fail.push(msg); };
  check(stars.rows.length > 30000 && stars.rows.length < 60000, `star count ${stars.rows.length}`);
  check(stars.rows.every((r, i) => i === 0 || r[2] >= stars.rows[i - 1][2]), 'stars sorted by mag');
  const byName = (n) => Object.entries(names).find(([, v]) => v.name === n);
  for (const [n, hip, ra, dec] of [['Vega', 91262, 279.23, 38.78], ['Polaris', 11767, 37.95, 89.26], ['Sirius', 32349, 101.29, -16.72]]) {
    const e = byName(n);
    check(e && Number(e[0]) === hip, `${n} named with HIP ${hip}`);
    const row = stars.rows.find((r) => r[4] === hip);
    check(row && Math.abs(row[0] - ra) < 0.05 && Math.abs(row[1] - dec) < 0.05, `${n} position ${row}`);
  }
  check(names['91262']?.bayer === 'α Lyr', `Vega bayer ${names['91262']?.bayer}`);
  const m31 = dso.find((d) => d.id === 'M31');
  check(m31 && Math.abs(m31.ra - 10.68) < 0.02 && Math.abs(m31.dec - 41.27) < 0.02 && m31.name === 'Andromeda Galaxy' && m31.alt?.includes('NGC 224'), `M31 ${JSON.stringify(m31)}`);
  const messier = new Set(dso.filter((d) => /^M\d+$/.test(d.id)).map((d) => d.id));
  check(messier.size === 110, `Messier count ${messier.size}`);
  const caldwell = new Set(dso.flatMap((d) => [d.id, ...(d.alt ?? [])]).filter((s) => /^C\d+$/.test(s)));
  check(caldwell.size === 109, `Caldwell count ${caldwell.size}`);
  check(new Set(dso.map((d) => d.id)).size === dso.length, 'unique DSO ids');
  const ori = constellations.find((c) => c.id === 'Ori');
  check(ori && ori.name === 'Orion' && ori.lines.length >= 3 && ori.label, 'Orion lines');
  check(constellations.length === 88, `constellation count ${constellations.length}`);
  check(constellations.every((c) => c.lines.every((l) => l.every(([ra]) => ra >= 0 && ra < 360))), 'constellation ra in 0..360');
  check(milkyway.length > 5, 'milky way polygons');
  check(cities.length >= 450 && cities.some((c) => c.name === 'Helsinki' && c.country === 'FI'), `cities ${cities.length}`);
  if (fail.length) {
    console.error('VALIDATION FAILED:\n  ' + fail.join('\n  '));
    process.exit(1);
  }
  console.log(`validation OK: ${stars.rows.length} stars, ${Object.keys(names).length} named/designated, ${dso.length} DSOs (${messier.size} Messier, ${caldwell.size} Caldwell), ${constellations.length} constellations, ${milkyway.length} Milky Way polygons, ${cities.length} cities`);
}

// ---------------------------------------------------------------------------
async function main() {
  mkdirSync(RAW, { recursive: true });
  const files = {};
  for (const k of Object.keys(SOURCES)) files[k] = await download(k);

  const { stars, names } = buildStars(files.hyg);
  const dso = buildDso(files.ngc, files.ngcAddendum);
  const constellations = buildConstellations(files.conLines, files.conNames);
  const milkyway = buildMilkyWay(files.milkyWay);
  const cities = buildCities(files.cities);
  validate({ stars, names, dso, constellations, milkyway, cities });

  writeJson('stars.json', stars);
  writeJson('star-names.json', names);
  writeJson('dso.json', dso);
  writeJson('constellations.json', constellations);
  writeJson('milkyway.json', milkyway);
  writeJson('cities.json', cities);

  const counts = {
    stars: stars.rows.length, names: Object.keys(names).length, dso: dso.length,
    constellations: constellations.length, milkyway: milkyway.length, cities: cities.length,
  };
  writeFileSync(join(DATA, 'SOURCES.md'), sourcesMd(counts));
  console.log('wrote data/SOURCES.md');
}

function sourcesMd(c) {
  const today = new Date().toISOString().slice(0, 10);
  return `# Offline data sources

Generated by \`npm run fetch-data\` (scripts/fetch-data.mjs) on ${today}. All coordinates are J2000 degrees (RA 0..360).
Raw downloads are cached in \`data/raw/\` (gitignored).

| File | Contents | Source | License |
|---|---|---|---|
| \`stars.json\` | ${c.stars} stars, V ≤ ${STAR_MAG_LIMIT}, \`[ra, dec, mag, bv, hip]\`, sorted by magnitude | [HYG Database v4.1](https://github.com/astronexus/HYG-Database) (\`hyg/CURRENT/hygdata_v41.csv\`), David Nash / astronexus | CC BY-SA 4.0 |
| \`star-names.json\` | ${c.names} HIP → proper name / Bayer designation | HYG Database v4.1 (IAU WGSN proper names, Bayer from the Yale BSC) | CC BY-SA 4.0 |
| \`dso.json\` | ${c.dso} deep-sky objects: all 110 Messier, all 109 Caldwell, NGC/IC with mag ≤ ${NGC_MAG_LIMIT} | [OpenNGC](https://github.com/mattiaverga/OpenNGC) (\`NGC.csv\` + \`addendum.csv\`), Mattia Verga | CC BY-SA 4.0 |
| \`constellations.json\` | ${c.constellations} constellations: stick-figure lines, names, label positions (Serpens Caput/Cauda merged) | [d3-celestial](https://github.com/ofrohn/d3-celestial) (\`constellations.lines.json\`, \`constellations.json\`), Olaf Frohn; based on IAU constellation charts | BSD 3-Clause |
| \`milkyway.json\` | ${c.milkyway} Milky Way outline polygons (5 brightness levels flattened), Douglas-Peucker simplified to 0.1° | d3-celestial \`mw.json\`, from the Milky Way Outline Catalog by Jose R. Vieira | BSD 3-Clause (d3-celestial) |
| \`cities.json\` | ${c.cities} cities: every national capital plus the most populous cities | [GeoNames](https://www.geonames.org/) \`cities15000.zip\` | CC BY 4.0 |

## Processing notes
- Stars: proper motion applied from J2000.0 to epoch ${STAR_EPOCH} (frame/equinox stay J2000); the Sun is removed; a missing B-V index is set to 0.6.
- Bayer designations are written as Greek letter + optional superscript + constellation, e.g. \`α Lyr\`, \`γ¹ And\`.
- DSOs: \`mag\` is V when known, otherwise B. Messier numbers on OpenNGC duplicate entries are moved to the master entry
  (e.g. M45 = Mel 22, M40 from the addendum). M102 is assigned to NGC 5866, the usual convention.
  Caldwell objects that exist only in the OpenNGC addendum use ids like \`C14\` (Double Cluster); other Caldwell numbers appear in \`alt\`.
- Object types map OpenNGC codes: G/GPair/GTrpl/GGroup → galaxy, OCl/*Ass → open-cluster, GCl → globular-cluster, PN → planetary-nebula,
  SNR → supernova-remnant, HII/EmN/Neb/RfN/Cl+N/DrkN → nebula, ** → double-star, others → other.

## Attribution
- HYG Database: © David Nash (astronexus.com), CC BY-SA 4.0. https://github.com/astronexus/HYG-Database
- OpenNGC: © Mattia Verga, CC BY-SA 4.0. https://github.com/mattiaverga/OpenNGC
- d3-celestial: © 2015 Olaf Frohn, BSD 3-Clause. https://github.com/ofrohn/d3-celestial
- GeoNames: CC BY 4.0. https://www.geonames.org/

Derived files from CC BY-SA sources (stars.json, star-names.json, dso.json) are distributed under CC BY-SA 4.0.
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
