// World Magnetic Model evaluator (offline). Implements the WMM technical report's spherical-harmonic synthesis
// with the bundled WMM2025 coefficients (wmm2025.ts, public domain). Pure, no I/O.
//
// Declination D is the angle from true (geographic) north to magnetic north, positive EAST:
//   true azimuth = magnetic heading + D.
import { WMM2025, WMM2025_EPOCH, WMM2025_VALID_UNTIL } from './wmm2025.ts';

export interface MagneticField {
  /** Declination (deg, +E). */
  declinationDeg: number;
  /** Inclination / dip (deg, + down). */
  inclinationDeg: number;
  /** North, east, down components and horizontal / total intensity (nT). */
  x: number;
  y: number;
  z: number;
  h: number;
  f: number;
  /** Decimal year actually used. */
  year: number;
  /** False when the date is outside the model's 2025.0–2030.0 validity (the result is extrapolated). */
  inValidity: boolean;
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const N_MAX = 12;
const A_WGS84 = 6378.137; // km
const F_WGS84 = 1 / 298.257223563;
const E2 = F_WGS84 * (2 - F_WGS84);
const R_REF = 6371.2; // geomagnetic reference radius (km)

// coefficient tables indexed [n][m]
const G = Array.from({ length: N_MAX + 1 }, () => new Float64Array(N_MAX + 1));
const H = Array.from({ length: N_MAX + 1 }, () => new Float64Array(N_MAX + 1));
const GD = Array.from({ length: N_MAX + 1 }, () => new Float64Array(N_MAX + 1));
const HD = Array.from({ length: N_MAX + 1 }, () => new Float64Array(N_MAX + 1));
for (const [n, m, g, h, gd, hd] of WMM2025) {
  G[n]![m] = g;
  H[n]![m] = h;
  GD[n]![m] = gd;
  HD[n]![m] = hd;
}

/** Decimal year of a date (UTC), e.g. 2026-07-02 ≈ 2026.5. */
export function decimalYear(date: Date | number): number {
  const d = typeof date === 'number' ? new Date(date) : date;
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (d.getTime() - start) / (end - start);
}

/**
 * Magnetic field at a geodetic location. `altKm` is height above the WGS84 ellipsoid.
 * Dates outside 2025–2030 are clamped to a ±1 year margin and flagged (`inValidity: false`).
 */
export function magneticField(latDeg: number, lonDeg: number, date: Date | number, altKm = 0): MagneticField {
  const year0 = decimalYear(date);
  const inValidity = year0 >= WMM2025_EPOCH && year0 <= WMM2025_VALID_UNTIL;
  const year = Math.min(WMM2025_VALID_UNTIL + 1, Math.max(WMM2025_EPOCH - 1, year0));
  const dt = year - WMM2025_EPOCH;

  // geodetic -> geocentric spherical
  const lat = Math.max(-89.999999, Math.min(89.999999, latDeg)) * DEG;
  const lon = lonDeg * DEG;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const rc = A_WGS84 / Math.sqrt(1 - E2 * sinLat * sinLat);
  const p = (rc + altKm) * cosLat;
  const zc = (rc * (1 - E2) + altKm) * sinLat;
  const r = Math.hypot(p, zc);
  const latC = Math.asin(zc / r); // geocentric latitude φ'

  // Schmidt semi-normalised associated Legendre functions of sin φ' and their θ-derivatives (θ = colatitude)
  const x = Math.sin(latC); // cos θ
  const s = Math.cos(latC); // sin θ
  const P = Array.from({ length: N_MAX + 1 }, () => new Float64Array(N_MAX + 1));
  const dP = Array.from({ length: N_MAX + 1 }, () => new Float64Array(N_MAX + 1));
  P[0]![0] = 1;
  dP[0]![0] = 0;
  for (let n = 1; n <= N_MAX; n++) {
    // diagonal
    if (n === 1) {
      P[1]![1] = s;
      dP[1]![1] = x;
    } else {
      const k = Math.sqrt((2 * n - 1) / (2 * n));
      P[n]![n] = k * s * P[n - 1]![n - 1]!;
      dP[n]![n] = k * (x * P[n - 1]![n - 1]! + s * dP[n - 1]![n - 1]!);
    }
    for (let m = 0; m < n; m++) {
      const a = Math.sqrt(n * n - m * m);
      const b = n >= 2 ? Math.sqrt((n - 1) * (n - 1) - m * m) : 0;
      const p2 = n >= 2 ? P[n - 2]![m]! : 0;
      const dp2 = n >= 2 ? dP[n - 2]![m]! : 0;
      P[n]![m] = ((2 * n - 1) * x * P[n - 1]![m]! - b * p2) / a;
      dP[n]![m] = ((2 * n - 1) * (x * dP[n - 1]![m]! - s * P[n - 1]![m]!) - b * dp2) / a;
    }
  }

  // field in geocentric spherical components (X' north, Y' east, Z' down)
  let bx = 0, by = 0, bz = 0;
  const ratio = R_REF / r;
  let rn = ratio * ratio; // (a/r)^(n+2) starts at n = 1 -> ratio^3
  for (let n = 1; n <= N_MAX; n++) {
    rn *= ratio;
    for (let m = 0; m <= n; m++) {
      const g = G[n]![m]! + dt * GD[n]![m]!;
      const h = H[n]![m]! + dt * HD[n]![m]!;
      const cm = Math.cos(m * lon), sm = Math.sin(m * lon);
      const gc = g * cm + h * sm;
      bx += rn * gc * dP[n]![m]!; // -dP/dφ' = +dP/dθ
      by += rn * m * (g * sm - h * cm) * P[n]![m]!;
      bz -= (n + 1) * rn * gc * P[n]![m]!;
    }
  }
  by = s > 1e-10 ? by / s : by; // poles: Y' is ill-defined; latitude is clamped above

  // rotate to geodetic
  const psi = latC - lat;
  const X = bx * Math.cos(psi) - bz * Math.sin(psi);
  const Y = by;
  const Z = bx * Math.sin(psi) + bz * Math.cos(psi);
  const Hh = Math.hypot(X, Y);
  return {
    declinationDeg: Math.atan2(Y, X) * RAD,
    inclinationDeg: Math.atan2(Z, Hh) * RAD,
    x: X, y: Y, z: Z, h: Hh, f: Math.hypot(Hh, Z),
    year,
    inValidity,
  };
}

/** Magnetic declination (deg, +E) at a location and time. */
export function magneticDeclination(latDeg: number, lonDeg: number, date: Date | number, altKm = 0): number {
  return magneticField(latDeg, lonDeg, date, altKm).declinationDeg;
}
