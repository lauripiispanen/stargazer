// Sky geometry shared by the GPU renderer, the 2D overlay and picking. Pure math (no three.js).
// WORLD frame: x = East, y = Zenith, z = South (North = -z). Angles in degrees.
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export type Vec3 = [number, number, number];
/** Row-major 3x3 */
export type Mat3 = number[];

export function raDecToVec(ra: number, dec: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const r = ra * D2R, d = dec * D2R, c = Math.cos(d);
  out[0] = c * Math.cos(r); out[1] = c * Math.sin(r); out[2] = Math.sin(d);
  return out;
}
export function vecToRaDec(v: Vec3): { ra: number; dec: number } {
  const ra = Math.atan2(v[1], v[0]) * R2D;
  return { ra: (ra + 360) % 360, dec: Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D };
}
export function altAzToWorld(az: number, alt: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const a = az * D2R, h = alt * D2R, c = Math.cos(h);
  out[0] = Math.sin(a) * c; out[1] = Math.sin(h); out[2] = -Math.cos(a) * c;
  return out;
}
export function worldToAltAz(v: Vec3): { az: number; alt: number } {
  const az = Math.atan2(v[0], -v[2]) * R2D;
  return { az: (az + 360) % 360, alt: Math.asin(Math.max(-1, Math.min(1, v[1]))) * R2D };
}
export function mulMat3(m: Mat3, v: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = v[0], y = v[1], z = v[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[3] * x + m[4] * y + m[5] * z;
  out[2] = m[6] * x + m[7] * y + m[8] * z;
  return out;
}
export function transpose3(m: Mat3): Mat3 { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }

/** Saemundsson refraction in degrees for a true altitude (deg); 0 well below the horizon. Matches GLSL `refract`. */
export function refractionDeg(trueAlt: number): number {
  if (trueAlt < -1.5) return 0;
  return (1.02 / Math.tan((trueAlt + 10.3 / (trueAlt + 5.11)) * D2R)) / 60;
}
/** Apply refraction (raise apparent altitude) to a world unit vector in place. */
export function refractWorld(v: Vec3): Vec3 {
  const alt = Math.asin(Math.max(-1, Math.min(1, v[1]))) * R2D;
  const r = refractionDeg(alt);
  if (r === 0) return v;
  const na = (alt + r) * D2R, h = Math.hypot(v[0], v[2]);
  if (h < 1e-9) return v;
  const s = Math.cos(na) / h;
  v[0] *= s; v[2] *= s; v[1] = Math.sin(na);
  return v;
}
/** Inverse of refractWorld (apparent -> true), fixed-point iterations. */
export function unrefractWorld(v: Vec3): Vec3 {
  const app = Math.asin(Math.max(-1, Math.min(1, v[1]))) * R2D;
  let t = app;
  for (let i = 0; i < 8; i++) t = app - refractionDeg(t);
  const na = t * D2R, h = Math.hypot(v[0], v[2]);
  if (h < 1e-9) return v;
  const s = Math.cos(na) / h;
  v[0] *= s; v[2] *= s; v[1] = Math.sin(na);
  return v;
}

/** Camera basis + projection for the current view. Mirrors the three.js camera (Euler YXZ: yaw=-az, pitch=alt). */
export class Projector {
  w = 1; h = 1; fov = 60; az = 0; alt = 0;
  f = 1; // focal length in px (vertical)
  right: Vec3 = [1, 0, 0]; up: Vec3 = [0, 1, 0]; fwd: Vec3 = [0, 0, -1];

  update(w: number, h: number, az: number, alt: number, fov: number) {
    this.w = w; this.h = h; this.az = az; this.alt = alt; this.fov = fov;
    this.f = (h / 2) / Math.tan((fov * D2R) / 2);
    const a = az * D2R, p = alt * D2R;
    this.fwd = [Math.sin(a) * Math.cos(p), Math.sin(p), -Math.cos(a) * Math.cos(p)];
    this.right = [Math.cos(a), 0, Math.sin(a)];
    // up = right x fwd
    const r = this.right, f = this.fwd;
    this.up = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  }

  /** World unit vector -> screen px. Returns false if behind the camera. Writes into out[0..1]. */
  project(v: Vec3, out: [number, number]): boolean {
    const z = v[0] * this.fwd[0] + v[1] * this.fwd[1] + v[2] * this.fwd[2];
    if (z <= 1e-3) return false;
    const x = v[0] * this.right[0] + v[1] * this.right[1] + v[2] * this.right[2];
    const y = v[0] * this.up[0] + v[1] * this.up[1] + v[2] * this.up[2];
    out[0] = this.w / 2 + (x / z) * this.f;
    out[1] = this.h / 2 - (y / z) * this.f;
    return true;
  }

  /** Screen px -> world unit vector (apparent). */
  unproject(sx: number, sy: number): Vec3 {
    const x = (sx - this.w / 2) / this.f, y = -(sy - this.h / 2) / this.f;
    const v: Vec3 = [
      this.fwd[0] + x * this.right[0] + y * this.up[0],
      this.fwd[1] + x * this.right[1] + y * this.up[1],
      this.fwd[2] + x * this.right[2] + y * this.up[2],
    ];
    const n = Math.hypot(v[0], v[1], v[2]);
    v[0] /= n; v[1] /= n; v[2] /= n;
    return v;
  }

  /** Pixels per degree at the view centre. */
  pxPerDeg(): number { return this.f * D2R; }

  inView(sx: number, sy: number, margin = 0): boolean {
    return sx >= -margin && sy >= -margin && sx <= this.w + margin && sy <= this.h + margin;
  }
}

/** Great-circle interpolation between unit vectors. */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const om = Math.acos(dot);
  if (om < 1e-6) return [a[0], a[1], a[2]];
  const s = Math.sin(om), k0 = Math.sin((1 - t) * om) / s, k1 = Math.sin(t * om) / s;
  return [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1];
}
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * R2D;
}
