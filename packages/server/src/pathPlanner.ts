// GoTo path planning (SAFETY.md §1.3, §3.3): split azimuth travel into ≤170° legs so the direction is
// deterministic, simulate both axes' trapezoidal motion, and choose a route that keeps clear of the Sun.
// Positions are logical encoder degrees with azimuth UNWRAPPED (cable-wrap frame).

export interface Pose {
  az: number; // unwrapped
  alt: number;
}

/** One GOTO command pair; an omitted axis stays put. */
export interface Step {
  az?: number;
  alt?: number;
}

export interface Kinematics {
  vmax: number; // deg/s
  accel: number; // deg/s²
}

export interface Plan {
  name: string;
  steps: Step[];
}

/** Duration of a rest-to-rest trapezoidal move over distance d. */
export function moveDuration(d: number, k: Kinematics): number {
  const dist = Math.abs(d);
  const tAcc = k.vmax / k.accel;
  const dAcc = k.vmax * tAcc; // accel + decel distance at full speed
  return dist >= dAcc ? dist / k.vmax + tAcc : 2 * Math.sqrt(dist / k.accel);
}

/** Displacement after t seconds of a trapezoidal move over d (signed). */
export function moveDisplacement(d: number, k: Kinematics, t: number): number {
  const dist = Math.abs(d);
  const T = moveDuration(d, k);
  if (t >= T) return d;
  const vPeak = Math.min(k.vmax, Math.sqrt(dist * k.accel));
  const tAcc = vPeak / k.accel;
  let s: number;
  if (t < tAcc) s = 0.5 * k.accel * t * t;
  else if (t < T - tAcc) s = 0.5 * k.accel * tAcc * tAcc + vPeak * (t - tAcc);
  else {
    const tr = T - t;
    s = dist - 0.5 * k.accel * tr * tr;
  }
  return Math.sign(d) * s;
}

/** Split steps so no single azimuth command travels more than maxLeg degrees. */
export function splitLegs(start: Pose, steps: Step[], maxLeg: number): Step[] {
  const out: Step[] = [];
  let az = start.az;
  for (const st of steps) {
    if (st.az === undefined) {
      out.push(st);
      continue;
    }
    const d = st.az - az;
    const n = Math.max(1, Math.ceil(Math.abs(d) / maxLeg - 1e-9));
    for (let i = 1; i <= n; i++) out.push({ az: az + (d * i) / n, ...(i === 1 && st.alt !== undefined ? { alt: st.alt } : {}) });
    az = st.az;
  }
  return out;
}

/** Sample the path every dt seconds. Returns poses (including the final one) and total duration. */
export function simulate(start: Pose, steps: Step[], k: Kinematics, dt = 0.1): { poses: Pose[]; duration: number; legDurations: number[] } {
  const poses: Pose[] = [{ ...start }];
  const legDurations: number[] = [];
  let cur = { ...start };
  let total = 0;
  for (const st of steps) {
    const dAz = st.az === undefined ? 0 : st.az - cur.az;
    const dAlt = st.alt === undefined ? 0 : st.alt - cur.alt;
    const T = Math.max(moveDuration(dAz, k), moveDuration(dAlt, k));
    for (let t = dt; t < T; t += dt) poses.push({ az: cur.az + moveDisplacement(dAz, k, t), alt: cur.alt + moveDisplacement(dAlt, k, t) });
    cur = { az: cur.az + dAz, alt: cur.alt + dAlt };
    poses.push({ ...cur });
    legDurations.push(T);
    total += T;
  }
  return { poses, duration: total, legDurations };
}

export interface PlanOptions {
  /** Allowed unwrapped azimuth range (soft cable wrap). */
  azRange: [number, number];
  /** Altitude used for the low-waypoint detour. */
  waypointAlt: number;
}

/**
 * Candidate routes from start to dest (dest.az given modulo 360), in SAFETY.md §3.3 order:
 * simultaneous, alt-first, az-first, the same three the other way round, then a low-altitude detour.
 * Destinations outside the wrap range are dropped.
 */
export function candidatePlans(start: Pose, dest: Pose, opts: PlanOptions): Plan[] {
  const d = ((((dest.az - start.az) % 360) + 540) % 360) - 180; // shortest
  const ways = [start.az + d, start.az + d - Math.sign(d || 1) * 360].filter((a) => a >= opts.azRange[0] && a <= opts.azRange[1]);
  const plans: Plan[] = [];
  ways.forEach((az, i) => {
    const tag = i === 0 ? '' : ' (other way)';
    plans.push({ name: `simultaneous${tag}`, steps: [{ az, alt: dest.alt }] });
    plans.push({ name: `alt-first${tag}`, steps: [{ alt: dest.alt }, { az }] });
    plans.push({ name: `az-first${tag}`, steps: [{ az }, { alt: dest.alt }] });
  });
  ways.forEach((az, i) => {
    plans.push({ name: `low waypoint${i ? ' (other way)' : ''}`, steps: [{ alt: opts.waypointAlt }, { az }, { alt: dest.alt }] });
  });
  return plans;
}
