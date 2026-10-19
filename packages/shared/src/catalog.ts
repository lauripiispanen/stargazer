// Types for the offline data files in data/ (see ARCHITECTURE.md) plus small helpers.
// All coordinates are J2000 degrees.

/** data/stars.json */
export interface StarsFile { fields: ['ra', 'dec', 'mag', 'bv', 'hip']; rows: [number, number, number, number, number][] }
/** data/star-names.json, keyed by HIP number. */
export type StarNamesFile = Record<string, { name?: string; bayer?: string }>;

export type DsoType = 'galaxy' | 'open-cluster' | 'globular-cluster' | 'nebula' | 'planetary-nebula' | 'supernova-remnant' | 'double-star' | 'other';

/** One entry of data/dso.json. */
export interface DsoEntry {
  id: string; // "M31", "NGC 869", "IC 434", "C14" (Caldwell-only objects from the OpenNGC addendum)
  name?: string; // common name
  type: DsoType;
  ra: number;
  dec: number;
  mag?: number; // V (or B when V unknown)
  sizeArcmin?: [number, number];
  con?: string;
  alt?: string[]; // other designations: "NGC 224", "C 14", ...
}

/** One entry of data/constellations.json. */
export interface ConstellationEntry { id: string; name: string; lines: [number, number][][]; label: [number, number] }
/** data/milkyway.json */
export type MilkyWayFile = [number, number][][];
/** One entry of data/cities.json. */
export interface CityEntry { name: string; country: string; lat: number; lon: number }

/** A star with optional identification, as used for alignment suggestions and the tonight list. */
export interface BrightStar { ra: number; dec: number; mag: number; hip?: number; name?: string; bayer?: string; bv?: number }

/** Join stars.json and star-names.json into named stars (brightest first), optionally limited by magnitude. */
export function namedStars(stars: StarsFile, names: StarNamesFile, maxMag = 99, requireName = true): BrightStar[] {
  const out: BrightStar[] = [];
  for (const [ra, dec, mag, bv, hip] of stars.rows) {
    if (mag > maxMag) break; // rows are sorted by magnitude
    const n = hip ? names[String(hip)] : undefined;
    if (requireName && !n?.name) continue;
    out.push({ ra, dec, mag, bv, hip: hip || undefined, name: n?.name, bayer: n?.bayer });
  }
  return out;
}

/** Display label for a star: proper name, else Bayer designation, else HIP number. */
export const starLabel = (s: BrightStar): string => s.name ?? s.bayer ?? (s.hip ? `HIP ${s.hip}` : `${s.ra.toFixed(2)} ${s.dec.toFixed(2)}`);
