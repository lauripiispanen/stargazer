// Line geometry builders (unit vectors, pairs of points for LINE segments). Pure.
import { altAzToWorld, raDecToVec, slerp, angleBetween, type Vec3 } from './projection.ts';

/** Push a great-circle arc a->b subdivided into <= maxStepDeg pieces as segment pairs. */
export function pushArc(out: number[], a: Vec3, b: Vec3, maxStepDeg = 2) {
  const ang = angleBetween(a, b);
  const n = Math.max(1, Math.ceil(ang / maxStepDeg));
  let prev = a;
  for (let i = 1; i <= n; i++) {
    const p = i === n ? b : slerp(a, b, i / n);
    out.push(prev[0], prev[1], prev[2], p[0], p[1], p[2]);
    prev = p;
  }
}

/** Polylines of [ra,dec] (J2000) -> segment pairs of J2000 unit vectors. */
export function polylinesToSegments(lines: [number, number][][], maxStepDeg = 2, close = false): Float32Array {
  const out: number[] = [];
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) pushArc(out, raDecToVec(line[i][0], line[i][1]), raDecToVec(line[i + 1][0], line[i + 1][1]), maxStepDeg);
    if (close && line.length > 2) pushArc(out, raDecToVec(line[line.length - 1][0], line[line.length - 1][1]), raDecToVec(line[0][0], line[0][1]), maxStepDeg);
  }
  return new Float32Array(out);
}

/** Small circle at constant latitude `lat` in a frame given by toVec(lon, lat). */
function pushParallel(out: number[], lat: number, toVec: (lon: number, lat: number) => Vec3, step = 2) {
  for (let lon = 0; lon < 360; lon += step) {
    const a = toVec(lon, lat), b = toVec(lon + step, lat);
    out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
}
function pushMeridian(out: number[], lon: number, toVec: (lon: number, lat: number) => Vec3, from = -90, to = 90, step = 2) {
  for (let lat = from; lat < to; lat += step) {
    const a = toVec(lon, lat), b = toVec(lon, Math.min(to, lat + step));
    out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
}

/** Alt-az grid in WORLD coordinates: altitude circles every 10°, azimuth lines every 15°. */
export function altAzGrid(): Float32Array {
  const out: number[] = [];
  const toVec = (az: number, alt: number) => altAzToWorld(az, alt);
  for (let alt = 10; alt <= 80; alt += 10) pushParallel(out, alt, toVec);
  for (let az = 0; az < 360; az += 15) pushMeridian(out, az, toVec, 0, az % 90 === 0 ? 90 : 80);
  return new Float32Array(out);
}

export function horizonLine(): Float32Array {
  const out: number[] = [];
  pushParallel(out, 0, (az, alt) => altAzToWorld(az, alt), 1);
  return new Float32Array(out);
}

/** Equatorial (J2000) grid: dec circles every 10°, RA lines every 1h. */
export function equatorialGrid(): Float32Array {
  const out: number[] = [];
  const toVec = (ra: number, dec: number) => raDecToVec(ra, dec);
  for (let dec = -80; dec <= 80; dec += 10) if (dec !== 0) pushParallel(out, dec, toVec);
  for (let ra = 0; ra < 360; ra += 15) pushMeridian(out, ra, toVec, -80, 80);
  return new Float32Array(out);
}
export function celestialEquator(): Float32Array {
  const out: number[] = [];
  pushParallel(out, 0, (ra, dec) => raDecToVec(ra, dec), 1);
  return new Float32Array(out);
}
/** Ecliptic (J2000, obliquity 23.4393°). */
export function ecliptic(): Float32Array {
  const eps = 23.4393 * Math.PI / 180;
  const toVec = (lon: number): Vec3 => {
    const l = lon * Math.PI / 180;
    return [Math.cos(l), Math.sin(l) * Math.cos(eps), Math.sin(l) * Math.sin(eps)];
  };
  const out: number[] = [];
  for (let lon = 0; lon < 360; lon += 1) { const a = toVec(lon), b = toVec(lon + 1); out.push(a[0], a[1], a[2], b[0], b[1], b[2]); }
  return new Float32Array(out);
}

/** Circle of constant altitude in WORLD coordinates. */
export function altCircle(alt: number, step = 1): Float32Array {
  const out: number[] = [];
  pushParallel(out, alt, (az, a) => altAzToWorld(az, a), step);
  return new Float32Array(out);
}
