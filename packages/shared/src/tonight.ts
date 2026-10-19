// "What's up tonight" ranking for a 130 mm f/5 Newtonian (650 mm focal length).
// Isomorphic: no Node APIs, so it runs in the browser too.
import * as Astronomy from 'astronomy-engine';
import type { GeoLocation, SolarBody, Target } from './api.ts';
import {
  bodyOf, bodyRaDec, moonInfo, targetRaDec, nightEvents, norm180, observerOf, refractionDeg, separation, skyFrame,
  type MoonInfo, type RaDec,
} from './astro.ts';
import type { BrightStar, DsoEntry, DsoType, StarsFile } from './catalog.ts';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const HOUR = 3_600_000;
const SIDEREAL_DEG_PER_MS = 360.98564736629 / 86400000;
/** Altitude of a star's centre at rise/set (refraction at the horizon). */
const RISE_ALT = -0.5667;

// ---------------------------------------------------------------------------
// Observing conditions
// ---------------------------------------------------------------------------

export type DarknessLevel = 'astronomical' | 'nautical' | 'civil' | 'none';

export interface ObservingConditions {
  sunset: number | null;
  sunrise: number | null;
  /** Astronomical darkness (Sun below -18°); null if it does not get that dark. */
  darkStart: number | null;
  darkEnd: number | null;
  /** Deepest darkness reached tonight. */
  darkness: DarknessLevel;
  /** Planning window: the darkest available period of tonight, starting no earlier than `time`. */
  windowStart: number;
  windowEnd: number;
  moon: MoonInfo & {
    /** Fraction (0..1) of the planning window with the Moon above the horizon. */
    upFraction: number;
    /** 0 (no moonlight) .. 1 (full Moon up all window): rough sky-brightening factor. */
    interference: number;
  };
  summary: string;
}

const fmtTime = (t: number | null): string =>
  t === null ? '–' : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

function conditionsFor(loc: GeoLocation, time: number): Omit<ObservingConditions, 'moon' | 'summary'> {
  const astro = nightEvents(loc, time, -18);
  let darkness: DarknessLevel = 'none';
  let ws: number | null = null;
  let we: number | null = null;
  if (astro.dusk !== null || astro.dawn !== null) {
    darkness = 'astronomical';
    [ws, we] = [astro.dusk, astro.dawn];
  } else {
    for (const [level, alt] of [['nautical', -12], ['civil', -6]] as const) {
      const n = nightEvents(loc, time, alt);
      if (n.dusk !== null || n.dawn !== null) {
        darkness = level;
        [ws, we] = [n.dusk, n.dawn];
        break;
      }
    }
  }
  if (darkness === 'none') [ws, we] = [astro.sunset, astro.sunrise];
  // Fill open ends (polar night or polar day) with a 12 h window around `time`.
  const start = ws ?? (we !== null ? Math.min(time, we - HOUR) : time);
  const end = we ?? start + 12 * HOUR;
  return { sunset: astro.sunset, sunrise: astro.sunrise, darkStart: astro.dusk, darkEnd: astro.dawn, darkness, windowStart: Math.max(start, time), windowEnd: end };
}

/** Darkness window, Moon phase / up-times and a one-line summary for tonight. */
export function observingConditions(loc: GeoLocation, time: number): ObservingConditions {
  let c = conditionsFor(loc, time);
  if (c.windowEnd - c.windowStart < 10 * 60_000) {
    // Tonight's dark window is over (e.g. just before sunrise): plan for the next night.
    const next = conditionsFor(loc, Math.max(c.sunrise ?? c.windowEnd, c.windowEnd) + 30 * 60_000);
    if (next.windowEnd > next.windowStart) c = next;
  }
  const mid = (c.windowStart + c.windowEnd) / 2;
  const mi = moonInfo(loc, c.windowStart);
  let up = 0;
  let weighted = 0;
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = c.windowStart + ((c.windowEnd - c.windowStart) * i) / n;
    const alt = moonAltitude(loc, t);
    if (alt > 0) {
      up++;
      weighted += Math.min(1, alt / 30 + 0.3);
    }
  }
  const upFraction = up / (n + 1);
  const illum = Astronomy.Illumination(Astronomy.Body.Moon, new Date(mid)).phase_fraction;
  const interference = Math.min(1, (illum * weighted) / (n + 1));
  const moon = { ...mi, upFraction, interference };

  const dark =
    c.darkness === 'astronomical' ? `Dark ${fmtTime(c.darkStart)}–${fmtTime(c.darkEnd)}`
      : c.darkness === 'none' ? 'No real darkness tonight'
        : `Only ${c.darkness} twilight tonight (${fmtTime(c.windowStart)}–${fmtTime(c.windowEnd)})`;
  const pct = Math.round(mi.phase * 100);
  const moonTxt =
    upFraction === 0 ? `Moon ${pct}% (below horizon while dark)`
      : `Moon ${pct}% ${mi.phaseName.toLowerCase()}, ${mi.altAz.alt > 0 ? 'up' : `rises ${fmtTime(mi.rise)}`}${mi.set ? `, sets ${fmtTime(mi.set)}` : ''}`;
  const verdict =
    c.darkness !== 'astronomical' ? 'planets, Moon and bright clusters'
      : interference < 0.15 ? 'great for galaxies and nebulae'
        : interference < 0.45 ? 'fine for clusters, OK for brighter galaxies'
          : 'best for Moon, planets, doubles and clusters';
  return { ...c, moon, summary: `${dark} · ${moonTxt} · ${verdict}` };
}

function moonAltitude(loc: GeoLocation, t: number): number {
  const p = targetRaDec({ kind: 'body', body: 'Moon', name: 'Moon' }, loc, t);
  return skyFrame(loc, t).toAltAzGeometric(p).alt;
}

// ---------------------------------------------------------------------------
// Curated content
// ---------------------------------------------------------------------------

export type Difficulty = 'easy' | 'moderate' | 'challenging';

/**
 * Showpiece double stars. The primary is identified by Hipparcos number; position and magnitude
 * come from the star catalog at runtime (see resolveShowpieceDoubles). sep in arcsec.
 */
export interface DoubleStar { id: string; name: string; hip: number; con: string; sepArcsec: number; difficulty: Difficulty; note: string; alt: string[] }
/** A DoubleStar with catalog position and magnitude filled in. */
export type ResolvedDouble = DsoEntry & DoubleStar & { type: 'double-star' };

const dbl = (id: string, name: string, hip: number, con: string, sepArcsec: number, difficulty: Difficulty, note: string, alt: string[] = []): DoubleStar =>
  ({ id, name, hip, con, sepArcsec, difficulty, note, alt });

export const SHOWPIECE_DOUBLES: DoubleStar[] = [
  dbl('Albireo', 'Albireo (β Cyg)', 95947, 'Cyg', 34, 'easy', 'Gold and sapphire pair, the finest colour contrast in the sky', ['β Cyg']),
  dbl('Mizar', 'Mizar & Alcor (ζ UMa)', 65378, 'UMa', 14.4, 'easy', 'Mizar splits cleanly at low power, with Alcor 12′ away', ['ζ UMa']),
  dbl('Almach', 'Almach (γ And)', 9640, 'And', 9.6, 'easy', 'Orange primary with a blue companion', ['γ And']),
  dbl('Double Double', 'Double Double (ε Lyr)', 91919, 'Lyr', 2.3, 'moderate', 'Two wide pairs 3.5′ apart; each splits at ~150x in steady air', ['ε Lyr']),
  dbl('Castor', 'Castor (α Gem)', 36850, 'Gem', 5.5, 'easy', 'Bright white pair, splits at ~80x'),
  dbl('Rigel', 'Rigel (β Ori)', 24436, 'Ori', 9.5, 'moderate', 'Faint companion hugging a brilliant blue-white star'),
  dbl('Polaris', 'Polaris (α UMi)', 11767, 'UMi', 18, 'easy', 'Faint 9th-magnitude companion of the Pole Star'),
  dbl('Mesarthim', 'Mesarthim (γ Ari)', 8832, 'Ari', 7.5, 'easy', 'Matched pair of white stars, like a pair of eyes'),
  dbl('61 Cyg', '61 Cygni', 104214, 'Cyg', 31, 'easy', 'Wide orange dwarf pair, one of the nearest stars'),
  dbl('Achird', 'Achird (η Cas)', 3821, 'Cas', 13, 'easy', 'Yellow and reddish pair'),
  dbl('Algieba', 'Algieba (γ Leo)', 50583, 'Leo', 4.7, 'moderate', 'Tight golden pair, needs ~100x'),
  dbl('Trapezium', 'Trapezium (θ¹ Ori)', 26221, 'Ori', 13, 'easy', 'Four young stars at the heart of the Orion Nebula', ['θ1 Ori']),
  dbl('Beta Mon', 'β Monocerotis', 30867, 'Mon', 7, 'moderate', 'Striking triple star, three near-equal white suns'),
  dbl('Gamma Del', 'γ Delphini', 102532, 'Del', 9, 'easy', 'Golden and pale green pair'),
  dbl('Iota Cnc', 'ι Cancri', 43103, 'Cnc', 30, 'easy', 'Yellow and blue, a winter Albireo'),
  dbl('Delta Cep', 'δ Cephei', 110991, 'Cep', 41, 'easy', 'Wide pair; the primary is the prototype Cepheid variable'),
  dbl('Antares', 'Antares (α Sco)', 80763, 'Sco', 2.6, 'challenging', 'Green companion lost in the glare of the red supergiant'),
  dbl('Alpha Cen', 'α Centauri', 71683, 'Cen', 8, 'easy', 'Nearest star system: two yellow suns'),
  dbl('Acrux', 'Acrux (α Cru)', 60718, 'Cru', 4, 'easy', 'Brilliant blue-white pair in the Southern Cross'),
  dbl('Nu Dra', 'ν Draconis', 85819, 'Dra', 62, 'easy', 'Identical white “Dragon’s eyes”'),
  dbl('Izar', 'Izar (ε Boo)', 72105, 'Boo', 2.9, 'challenging', 'Orange and blue-green, needs steady air at high power'),
  dbl('Cor Caroli', 'Cor Caroli (α CVn)', 63125, 'CVn', 19, 'easy', 'Easy white and lilac pair'),
  dbl('Zeta Lyr', 'ζ Lyrae', 91971, 'Lyr', 44, 'easy', 'Wide pair next to Vega'),
  dbl('Porrima', 'Porrima (γ Vir)', 61941, 'Vir', 3.2, 'moderate', 'Twin yellow-white stars slowly widening'),
  dbl('Sigma Ori', 'σ Orionis', 26549, 'Ori', 13, 'easy', 'Multiple star system near the Horsehead region'),
  dbl('Rasalgethi', 'Rasalgethi (α Her)', 84345, 'Her', 4.6, 'moderate', 'Orange giant with a greenish companion'),
  dbl('Alya', 'Alya (θ Ser)', 92946, 'Ser', 22, 'easy', 'Equal white pair'),
];

/** Look up the doubles' primaries in the star catalog by HIP number; doubles missing from it are skipped. */
export function resolveShowpieceDoubles(stars: StarsFile | BrightStar[]): ResolvedDouble[] {
  const byHip = new Map<number, { ra: number; dec: number; mag: number }>();
  if (Array.isArray(stars)) {
    for (const s of stars) if (s.hip) byHip.set(s.hip, s);
  } else {
    for (const [ra, dec, mag, , hip] of stars.rows) if (hip) byHip.set(hip, { ra, dec, mag });
  }
  const out: ResolvedDouble[] = [];
  for (const d of SHOWPIECE_DOUBLES) {
    const s = byHip.get(d.hip);
    if (s) out.push({ ...d, type: 'double-star', ra: s.ra, dec: s.dec, mag: s.mag });
  }
  return out;
}

/** The very best doubles get an extra bonus. */
const TOP_DOUBLES = new Set(['Albireo', 'Mizar', 'Almach', 'Double Double', 'Castor', 'Trapezium', 'Alpha Cen', 'Acrux', 'Beta Mon', 'Gamma Del']);

/** Curated deep-sky highlights for a small Newtonian: id -> [bonus 0..3, note]. */
const SHOWPIECES: Record<string, [number, string]> = {
  M42: [3, 'The Orion Nebula: glowing gas around the Trapezium'],
  M31: [3, 'The Andromeda Galaxy with companions M32 and M110'],
  M45: [3, 'The Pleiades: best at lowest power'],
  M13: [3, 'Great globular in Hercules, resolves into stars at 100x'],
  C14: [3, 'The Double Cluster: two rich clusters in one low-power field'],
  M57: [2.5, 'The Ring Nebula: a tiny smoke ring'],
  M27: [2.5, 'The Dumbbell Nebula: large and bright planetary'],
  M8: [2.5, 'The Lagoon Nebula with its embedded cluster'],
  M11: [2.5, 'The Wild Duck Cluster: dense and rich'],
  M22: [2.5, 'Bright, large globular in Sagittarius'],
  M17: [2, 'The Omega (Swan) Nebula'],
  M44: [2, 'The Beehive Cluster: fills a low-power field'],
  M81: [2, "Bode's Galaxy, paired with M82 in one field"],
  M82: [2, 'The Cigar Galaxy, mottled edge-on starburst'],
  M51: [2, 'The Whirlpool Galaxy and its companion'],
  M3: [2, 'Rich globular cluster'],
  M5: [2, 'Rich globular cluster'],
  M92: [1.5, 'Bright globular, often overlooked next to M13'],
  M15: [1.5, 'Compact, bright globular in Pegasus'],
  M2: [1.2, 'Bright globular in Aquarius'],
  M4: [1.5, 'Loose globular near Antares'],
  M6: [1.5, 'The Butterfly Cluster'],
  M7: [1.5, "Ptolemy's Cluster: big and bright"],
  M20: [1.5, 'The Trifid Nebula'],
  M16: [1.2, 'The Eagle Nebula cluster'],
  M35: [1.5, 'Rich cluster with NGC 2158 nearby'],
  M36: [1.2, 'Bright open cluster in Auriga'],
  M37: [1.5, 'The richest of the Auriga clusters'],
  M38: [1.2, 'Open cluster in Auriga'],
  M33: [1, 'The Triangulum Galaxy: big but faint, needs dark skies'],
  M1: [1, 'The Crab Nebula supernova remnant'],
  M64: [1, 'The Black Eye Galaxy'],
  M104: [1.5, 'The Sombrero Galaxy'],
  M97: [1, 'The Owl Nebula'],
  M101: [0.8, 'The Pinwheel Galaxy: large, low surface brightness'],
  M63: [1, 'The Sunflower Galaxy'],
  M94: [1, 'Bright compact galaxy'],
  M65: [1, 'Part of the Leo Triplet'],
  M66: [1, 'Part of the Leo Triplet'],
  M46: [1.2, 'Rich cluster with a planetary nebula in front'],
  M47: [1.2, 'Bright, coarse open cluster'],
  M41: [1.2, 'Bright cluster below Sirius'],
  M39: [1, 'Large loose cluster in Cygnus'],
  M52: [1, 'Rich cluster in Cassiopeia'],
  M103: [1, 'Small arrowhead cluster in Cassiopeia'],
  M10: [1.2, 'Globular in Ophiuchus'],
  M12: [1.2, 'Globular in Ophiuchus'],
  M53: [1, 'Globular in Coma Berenices'],
  M55: [1, 'Large loose globular'],
  M48: [1, 'Large open cluster in Hydra'],
  M50: [1, 'Heart-shaped open cluster'],
  M67: [1.2, 'Old, rich open cluster'],
  M93: [1, 'Bright cluster in Puppis'],
  M83: [1.2, 'Southern Pinwheel Galaxy'],
  M106: [1, 'Bright spiral in Canes Venatici'],
  'NGC 457': [1.5, 'The Owl (E.T.) Cluster'],
  'NGC 7662': [1.5, 'The Blue Snowball planetary nebula'],
  'NGC 6543': [1.5, "The Cat's Eye Nebula"],
  'NGC 3242': [1.5, 'The Ghost of Jupiter'],
  'NGC 6826': [1.2, 'The Blinking Planetary'],
  'NGC 7009': [1.5, 'The Saturn Nebula'],
  'NGC 2392': [1.2, 'The Eskimo Nebula'],
  'NGC 7293': [1, 'The Helix Nebula: large and faint, use low power'],
  'NGC 253': [2, 'The Sculptor Galaxy: big and bright'],
  'NGC 5139': [3, 'Omega Centauri: the greatest globular cluster'],
  'NGC 104': [3, '47 Tucanae: superb southern globular'],
  'NGC 2070': [2.5, 'The Tarantula Nebula in the LMC'],
  'NGC 3372': [3, 'The Eta Carinae Nebula'],
  'NGC 4755': [2, 'The Jewel Box cluster'],
  'NGC 6231': [1.5, 'Bright cluster in Scorpius'],
  'NGC 2516': [1.5, 'Southern Beehive cluster'],
  'NGC 3532': [2, 'Wishing Well Cluster: superb in binoculars and small scopes'],
  'NGC 6752': [2, 'Bright southern globular'],
  'NGC 6397': [2, 'One of the nearest globulars'],
  'NGC 663': [1, 'Rich cluster in Cassiopeia'],
  'NGC 2244': [1, 'Cluster at the heart of the Rosette Nebula'],
  'NGC 4565': [1, 'The Needle Galaxy, edge-on'],
  'NGC 6992': [1, 'Eastern Veil Nebula: needs dark skies (filter helps)'],
  'NGC 6960': [0.8, "Western Veil (Witch's Broom)"],
  'NGC 7789': [1, "Caroline's Rose: rich faint cluster"],
  'NGC 752': [1, 'Large, scattered cluster in Andromeda'],
  'NGC 2362': [1, 'Compact cluster around τ CMa'],
  'NGC 6210': [1, 'Bright small planetary in Hercules'],
  'NGC 6572': [1, 'Vivid green small planetary'],
  'NGC 2403': [0.8, 'Bright spiral in Camelopardalis'],
  'NGC 4631': [0.8, 'The Whale Galaxy'],
  'NGC 7331': [0.8, 'Bright spiral in Pegasus'],
  'NGC 55': [1, 'Large edge-on southern galaxy'],
  'NGC 869': [1.5, 'h Persei, half of the Double Cluster'],
  'NGC 884': [1.5, 'χ Persei, half of the Double Cluster'],
  'NGC 1981': [0.5, 'Open cluster north of the Orion Nebula'],
  'NGC 2264': [0.8, 'Christmas Tree Cluster'],
  'IC 2602': [2, 'The Southern Pleiades'],
  'NGC 6633': [0.8, 'Bright open cluster in Ophiuchus'],
  'NGC 2158': [0.5, 'Distant rich cluster next to M35'],
};

const PLANET_NOTES: Record<string, [number, string]> = {
  Jupiter: [100, 'Cloud belts and the four Galilean moons'],
  Saturn: [100, 'The rings and Titan'],
  Mars: [75, 'Small disc; polar cap and dark markings near opposition'],
  Venus: [70, 'Brilliant phases like a little Moon'],
  Mercury: [45, 'Tiny phase, low in twilight'],
  Uranus: [45, 'Small blue-green disc'],
  Neptune: [35, 'Tiny blue disc, star-like'],
};

const TYPE_LABEL: Record<DsoType, string> = {
  galaxy: 'Galaxy',
  'open-cluster': 'Open cluster',
  'globular-cluster': 'Globular cluster',
  nebula: 'Nebula',
  'planetary-nebula': 'Planetary nebula',
  'supernova-remnant': 'Supernova remnant',
  'double-star': 'Double star',
  other: 'Object',
};

export const CONSTELLATION_NAMES: Record<string, string> = {
  And: 'Andromeda', Ant: 'Antlia', Aps: 'Apus', Aqr: 'Aquarius', Aql: 'Aquila', Ara: 'Ara', Ari: 'Aries', Aur: 'Auriga',
  Boo: 'Boötes', Cae: 'Caelum', Cam: 'Camelopardalis', Cnc: 'Cancer', CVn: 'Canes Venatici', CMa: 'Canis Major',
  CMi: 'Canis Minor', Cap: 'Capricornus', Car: 'Carina', Cas: 'Cassiopeia', Cen: 'Centaurus', Cep: 'Cepheus', Cet: 'Cetus',
  Cha: 'Chamaeleon', Cir: 'Circinus', Col: 'Columba', Com: 'Coma Berenices', CrA: 'Corona Australis', CrB: 'Corona Borealis',
  Crv: 'Corvus', Crt: 'Crater', Cru: 'Crux', Cyg: 'Cygnus', Del: 'Delphinus', Dor: 'Dorado', Dra: 'Draco', Equ: 'Equuleus',
  Eri: 'Eridanus', For: 'Fornax', Gem: 'Gemini', Gru: 'Grus', Her: 'Hercules', Hor: 'Horologium', Hya: 'Hydra', Hyi: 'Hydrus',
  Ind: 'Indus', Lac: 'Lacerta', Leo: 'Leo', LMi: 'Leo Minor', Lep: 'Lepus', Lib: 'Libra', Lup: 'Lupus', Lyn: 'Lynx', Lyr: 'Lyra',
  Men: 'Mensa', Mic: 'Microscopium', Mon: 'Monoceros', Mus: 'Musca', Nor: 'Norma', Oct: 'Octans', Oph: 'Ophiuchus', Ori: 'Orion',
  Pav: 'Pavo', Peg: 'Pegasus', Per: 'Perseus', Phe: 'Phoenix', Pic: 'Pictor', Psc: 'Pisces', PsA: 'Piscis Austrinus', Pup: 'Puppis',
  Pyx: 'Pyxis', Ret: 'Reticulum', Sge: 'Sagitta', Sgr: 'Sagittarius', Sco: 'Scorpius', Scl: 'Sculptor', Sct: 'Scutum', Se1: 'Serpens',
  Se2: 'Serpens', Ser: 'Serpens', Sex: 'Sextans', Tau: 'Taurus', Tel: 'Telescopium', Tri: 'Triangulum', TrA: 'Triangulum Australe',
  Tuc: 'Tucana', UMa: 'Ursa Major', UMi: 'Ursa Minor', Vel: 'Vela', Vir: 'Virgo', Vol: 'Volans', Vul: 'Vulpecula',
};

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export type TonightCategory = 'moon' | 'planet' | 'dso' | 'double-star' | 'star';

export interface TonightItem {
  id: string;
  name: string;
  category: TonightCategory;
  /** DsoType for deep-sky objects, otherwise 'moon' | 'planet' | 'double-star' | 'star'. */
  type: string;
  target: Target;
  mag: number | null;
  sizeArcmin?: [number, number];
  con?: string;
  /** 0..100, higher is better tonight. */
  score: number;
  /** When to look: highest point during the planning window. */
  bestTime: number;
  /** Highest apparent altitude during the window (deg). */
  maxAlt: number;
  altNow: number;
  /** Rise/transit/set around tonight (rise before and set after the transit nearest the window centre). */
  rise: number | null;
  transit: number | null;
  set: number | null;
  /** Always above the horizon. */
  circumpolar: boolean;
  description: string;
  difficulty: Difficulty;
  /** Angular distance to the Moon at bestTime (deg); null for the Moon itself. */
  moonSepDeg: number | null;
}

export interface TonightCatalog {
  dso: DsoEntry[];
  brightStars?: BrightStar[];
  /** Full star catalog (data/stars.json); showpiece doubles are resolved from it, else from brightStars. */
  stars?: StarsFile;
}

export interface TonightOptions {
  /** Max items returned (default 40). */
  limit?: number;
  /** Minimum useful altitude (default 15°). */
  minAlt?: number;
  /** Restrict to some categories (default all). */
  categories?: TonightCategory[];
  /** Include the curated SHOWPIECE_DOUBLES that can be resolved from the catalog (default true). */
  includeDoubles?: boolean;
  /** Bright named stars brighter than this are listed (default 1.0; set -Infinity to skip). */
  starMagLimit?: number;
}

// Optical limits for a 130 mm reflector under a dark sky.
const STELLAR_LIMIT = 12.8; // limiting stellar magnitude
const SB_LIMIT = 14.6; // mag/arcmin² at which extended objects become very hard

interface Track {
  maxAlt: number;
  bestTime: number;
  rise: number | null;
  transit: number | null;
  set: number | null;
  circumpolar: boolean;
}

/**
 * Analytic visibility of a fixed apparent-of-date RA/Dec over [ws, we].
 * lstAt(t) gives local sidereal time; altitude is monotonic in |hour angle|.
 */
function fixedTrack(app: RaDec, lat: number, lstMid: number, tMid: number, ws: number, we: number): Track {
  const phi = lat * DEG;
  const d = app.dec * DEG;
  const altAtH = (hDeg: number) => Math.asin(Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(hDeg * DEG)) * RAD;
  const haAt = (t: number) => norm180(lstMid + (t - tMid) * SIDEREAL_DEG_PER_MS - app.ra);
  const transit = tMid - haAt(tMid) / SIDEREAL_DEG_PER_MS;
  // Max within the window: at a transit inside it, else at the higher endpoint.
  const transits = [transit - 86164091, transit, transit + 86164091].filter((t) => t >= ws && t <= we);
  let maxAlt: number;
  let bestTime: number;
  if (transits.length) {
    bestTime = transits[0];
    maxAlt = altAtH(0);
  } else {
    const [a, b] = [altAtH(haAt(ws)), altAtH(haAt(we))];
    [maxAlt, bestTime] = a >= b ? [a, ws] : [b, we];
  }
  const cosH0 = (Math.sin(RISE_ALT * DEG) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d));
  let rise: number | null = null;
  let set: number | null = null;
  const circumpolar = cosH0 < -1;
  if (cosH0 >= -1 && cosH0 <= 1) {
    const h0 = (Math.acos(cosH0) * RAD) / SIDEREAL_DEG_PER_MS;
    rise = transit - h0;
    set = transit + h0;
  }
  return { maxAlt: maxAlt + refractionDeg(maxAlt), bestTime, rise, transit: cosH0 > 1 ? null : transit, set, circumpolar };
}

/** Sampled visibility for a moving body plus astronomy-engine rise/transit/set searches. */
function bodyTrack(body: SolarBody, loc: GeoLocation, ws: number, we: number): Track {
  const n = Math.max(8, Math.ceil((we - ws) / (20 * 60_000)));
  let maxAlt = -90;
  let bestTime = ws;
  for (let i = 0; i <= n; i++) {
    const t = ws + ((we - ws) * i) / n;
    const alt = skyFrame(loc, t).toAltAz(targetRaDec({ kind: 'body', body, name: body }, loc, t)).alt;
    if (alt > maxAlt) [maxAlt, bestTime] = [alt, t];
  }
  const obs = observerOf(loc);
  const mid = (ws + we) / 2;
  const b = bodyOf(body);
  const tr = Astronomy.SearchHourAngle(b, obs, 0, new Date(mid - 12 * HOUR), +1);
  const transit = tr.time.date.getTime();
  const rise = Astronomy.SearchRiseSet(b, obs, +1, new Date(transit), -1);
  const set = Astronomy.SearchRiseSet(b, obs, -1, new Date(transit), 1);
  const circumpolar = !rise && !set && tr.hor.altitude > 0;
  return { maxAlt, bestTime, rise: rise?.date.getTime() ?? null, transit: tr.hor.altitude > -1 || rise ? transit : null, set: set?.date.getTime() ?? null, circumpolar };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** 0..1 credit for altitude: nothing below minAlt, full credit 30° above it. */
const altitudeFactor = (maxAlt: number, minAlt: number) => (maxAlt < minAlt ? 0 : 0.35 + 0.65 * clamp01((maxAlt - minAlt) / 30));

function fmtMag(m: number | undefined | null): string {
  return m === undefined || m === null || !Number.isFinite(m) ? '' : `mag ${m.toFixed(1)}`;
}
function fmtSize(s?: [number, number]): string {
  if (!s || !s[0]) return '';
  const f = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1));
  return s[1] && Math.abs(s[1] - s[0]) > 0.05 * s[0] ? `${f(s[0])}′×${f(s[1])}′` : `${f(s[0])}′`;
}
const joinParts = (...parts: string[]) => parts.filter(Boolean).join(' · ');
const conName = (c?: string) => (c ? CONSTELLATION_NAMES[c] ?? c : '');

/**
 * Rank the best targets for tonight. `time` picks the night (see observingConditions):
 * during the day it plans for the coming night, at night for the rest of the current one.
 */
export function whatsUpTonight(loc: GeoLocation, time: number, catalog: TonightCatalog, options: TonightOptions = {}): TonightItem[] {
  const { limit = 40, minAlt = 15, categories, includeDoubles = true, starMagLimit = 1.0 } = options;
  const want = (c: TonightCategory) => !categories || categories.includes(c);
  const cond = observingConditions(loc, time);
  const ws = cond.windowStart;
  const we = cond.windowEnd;
  const tMid = (ws + we) / 2;
  const midFrame = skyFrame(loc, tMid);
  const nowFrame = skyFrame(loc, time);
  const moonPos = bodyRaDec('Moon', loc, tMid);
  const moonAppMid = midFrame.toApparentOfDate(moonPos);
  const moonIllum = cond.moon.phase;
  const twilightPenalty = cond.darkness === 'astronomical' ? 0 : cond.darkness === 'nautical' ? 1.2 : 2.5;
  const items: TonightItem[] = [];

  /** Magnitudes of sky brightening by the Moon near a given position. */
  const moonPenalty = (p: RaDec): { mag: number; sep: number } => {
    const sep = separation(p, moonAppMid);
    const proximity = 1 + 1.5 * clamp01((50 - sep) / 50);
    return { mag: Math.min(4, 2.2 * cond.moon.interference * proximity) + twilightPenalty, sep };
  };

  // --- Moon and planets ---
  const bodies: SolarBody[] = ['Moon', 'Jupiter', 'Saturn', 'Mars', 'Venus', 'Mercury', 'Uranus', 'Neptune'];
  for (const body of bodies) {
    const category: TonightCategory = body === 'Moon' ? 'moon' : 'planet';
    if (!want(category)) continue;
    // Bright bodies are fine in twilight (inner planets are only seen then): use sunset..sunrise.
    const bws = Math.min(ws, Math.max(time, cond.sunset ?? ws));
    const bwe = Math.max(we, cond.sunrise ?? we);
    const tr = bodyTrack(body, loc, bws, bwe);
    if (tr.maxAlt < (body === 'Mercury' || body === 'Venus' ? Math.min(minAlt, 8) : minAlt)) continue;
    const pos = bodyRaDec(body, loc, tr.bestTime);
    let interest: number;
    let description: string;
    let difficulty: Difficulty = 'easy';
    if (body === 'Moon') {
      if (moonIllum < 0.03) continue;
      interest = 95;
      description = `${cond.moon.phaseName}, ${Math.round(moonIllum * 100)}% lit · craters are sharpest along the terminator`;
    } else {
      const [base, note] = PLANET_NOTES[body];
      interest = base;
      if (body === 'Mars') interest = pos.mag < -1 ? 90 : pos.mag < 0.5 ? 70 : 45; // only worthwhile near opposition
      description = joinParts(fmtMag(pos.mag), note);
      if (body === 'Uranus') difficulty = 'moderate';
      if (body === 'Neptune') difficulty = 'challenging';
    }
    const score = interest * altitudeFactor(tr.maxAlt, body === 'Mercury' || body === 'Venus' ? 5 : minAlt);
    const altNow = nowFrame.toAltAz(bodyRaDec(body, loc, time)).alt;
    items.push({
      id: body, name: body, category, type: category, target: { kind: 'body', body, name: body },
      mag: Number.isFinite(pos.mag) ? pos.mag : null, score, ...tr, altNow, description, difficulty,
      moonSepDeg: body === 'Moon' ? null : separation(pos, moonPos),
    });
  }

  // --- Fixed objects: DSOs, doubles, bright stars ---
  type Fixed = { e: DsoEntry; category: TonightCategory; interest: number; note?: string; difficulty?: Difficulty };
  const fixed: Fixed[] = [];
  const starSource = catalog.stars ?? catalog.brightStars;
  const doubles = starSource ? resolveShowpieceDoubles(starSource) : [];
  const seen = new Set<string>();
  if (want('double-star') && includeDoubles) {
    for (const d of doubles) {
      const interest = 45 + (d.difficulty === 'easy' ? 8 : 0) + (TOP_DOUBLES.has(d.id) ? 15 : 0);
      fixed.push({ e: d, category: 'double-star', interest, note: `${d.note} (${d.sepArcsec}″)`, difficulty: d.difficulty });
      seen.add(d.id);
    }
  }
  if (want('dso')) {
    const hasDoubleCluster = catalog.dso.some((d) => d.id === 'C14');
    for (const e of catalog.dso) {
      if (seen.has(e.id)) continue;
      if (hasDoubleCluster && (e.id === 'NGC 869' || e.id === 'NGC 884')) continue; // shown as C14
      seen.add(e.id);
      const show = SHOWPIECES[e.id];
      const isM = /^M\d+$/.test(e.id);
      const isC = /^C\d+$/.test(e.id) || (e.alt ?? []).some((a) => /^C \d+$/.test(a));
      const base = e.type === 'double-star' || e.type === 'other' ? 25 : isM ? 50 : isC ? 42 : 32;
      fixed.push({ e, category: e.type === 'double-star' ? 'double-star' : 'dso', interest: base + (show ? show[0] * 15 : 0), note: show?.[1] });
    }
  }
  if (want('star') && catalog.brightStars) {
    for (const s of catalog.brightStars) {
      if (s.mag > starMagLimit || !s.name) continue;
      const id = `HIP ${s.hip ?? s.name}`;
      if (seen.has(id) || doubles.some((d) => separation(d, s) < 0.05)) continue;
      seen.add(id);
      const colour = s.bv === undefined ? '' : s.bv > 1.3 ? 'deep orange-red' : s.bv > 0.8 ? 'orange' : s.bv > 0.3 ? 'yellowish' : 'blue-white';
      fixed.push({ e: { id, name: s.name, type: 'other', ra: s.ra, dec: s.dec, mag: s.mag }, category: 'star', interest: 25, note: joinParts(s.bayer ?? '', colour && `${colour} star`) });
    }
  }

  for (const f of fixed) {
    const { e } = f;
    const app = midFrame.toApparentOfDate(e);
    const tr = fixedTrack(app, loc.lat, midFrame.lst, tMid, ws, we);
    const vis = altitudeFactor(tr.maxAlt, minAlt);
    if (vis === 0) continue;
    const mp = moonPenalty(app);
    const mag = e.mag ?? (f.category === 'dso' ? 10.5 : 6);
    let detect = 1;
    let margin = 5;
    if (f.category === 'dso') {
      // Surface brightness (mag/arcmin²) over the catalogued ellipse.
      const [a, b] = e.sizeArcmin ?? [1, 1];
      // Large galaxies and clusters have bright cores: judge them by their brightest ~40' rather
      // than the faint catalogued outer extent (otherwise M31 would rank as hard as M101).
      const cap = e.type === 'galaxy' || e.type === 'open-cluster' || e.type === 'globular-cluster' ? 40 : Infinity;
      const area = Math.max((Math.PI / 4) * Math.min(Math.max(a, 0.3), cap) * Math.min(Math.max(b || a, 0.3), cap), 0.5);
      const sb = mag + 2.5 * Math.log10(area);
      // Clusters are made of stars: judge them more by total light than diffuse glow.
      const isCluster = e.type === 'open-cluster' || e.type === 'globular-cluster';
      const sbSlack = isCluster ? 1.5 : 0;
      margin = Math.min(STELLAR_LIMIT - 1 - mp.mag - mag, SB_LIMIT + sbSlack - mp.mag - sb);
      detect = clamp01(margin / 3);
      if (detect <= 0.05) continue;
      // Objects much bigger than a low-power field (~1.9°) lose some appeal.
      if (a > 150) detect *= 0.85;
    } else if (f.category === 'double-star') {
      margin = STELLAR_LIMIT - mp.mag - mag;
    }
    const lowAltPenalty = tr.maxAlt < 25 ? 1 : 0;
    const difficulty: Difficulty = f.difficulty
      ?? (margin - lowAltPenalty > 2.5 ? 'easy' : margin - lowAltPenalty > 1.2 ? 'moderate' : 'challenging');
    const moonFactor = f.category === 'dso' ? 0.3 + 0.7 * detect : 1;
    const score = f.interest * vis * moonFactor;
    const label = f.category === 'dso' ? TYPE_LABEL[e.type] : f.category === 'double-star' ? 'Double star' : 'Star';
    const description = joinParts(
      f.note ?? '',
      `${label}${e.con ? ` in ${conName(e.con)}` : ''}`,
      fmtMag(e.mag),
      f.category === 'dso' ? fmtSize(e.sizeArcmin) : '',
    );
    items.push({
      id: e.id,
      name: e.name ? (e.name === e.id ? e.id : f.category === 'dso' ? `${e.id} ${e.name}` : e.name) : e.id,
      category: f.category,
      type: f.category === 'dso' ? e.type : f.category,
      target: { kind: 'radec', ra: e.ra, dec: e.dec, name: e.name ?? e.id, id: e.id },
      mag: e.mag ?? null,
      sizeArcmin: e.sizeArcmin,
      con: e.con,
      score,
      ...tr,
      altNow: nowFrame.toAltAz(e).alt,
      description,
      difficulty,
      moonSepDeg: mp.sep,
    });
  }

  items.sort((a, b) => b.score - a.score);
  return items.slice(0, limit).map((i) => ({ ...i, score: Math.round(Math.min(100, i.score) * 10) / 10 }));
}
