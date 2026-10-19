// Star colour from B-V index. Pure.
/** B-V -> linear-ish RGB (0..1), based on Ballesteros' formula for temperature + a blackbody fit. */
export function bvToTemperature(bv: number): number {
  const b = Math.min(2.0, Math.max(-0.4, bv));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

export function temperatureToRgb(k: number): [number, number, number] {
  // Tanner Helland approximation, normalised to 0..1
  const t = k / 100;
  let r: number, g: number, b: number;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (x: number) => Math.min(1, Math.max(0, x / 255));
  return [c(r), c(g), c(b)];
}

/** Slightly desaturated so stars look natural rather than candy-coloured. */
export function bvToRgb(bv: number, saturation = 0.75): [number, number, number] {
  const [r, g, b] = temperatureToRgb(bvToTemperature(bv));
  const l = 0.3 * r + 0.59 * g + 0.11 * b;
  const mix = (x: number) => l + (x - l) * saturation;
  const m = Math.max(mix(r), mix(g), mix(b));
  return [mix(r) / m, mix(g) / m, mix(b) / m];
}
