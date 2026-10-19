// One simulated motor-controller axis: integer-ish encoder, slew/goto profile and superposed guide rate.
// Angles are degrees. `pos` is the physical (mechanical) angle; the encoder reads pos + offset, so
// SET_POSITION and power cycles change only the offset, never where the tube points.

export type AxisKind = 'az' | 'alt';

export interface MotorParams {
  slewRates: number[]; // deg/s for MOVE rates 0..9
  maxRateDeg: number; // GOTO_FAST cruise speed
  slowRateDeg: number; // GOTO_SLOW cruise speed
  accelDeg: number; // deg/s²
  altLimits: [number, number]; // encoder degrees, ALT only
  gotoCancelsGuide: boolean;
}

type Mode =
  | { kind: 'idle' }
  | { kind: 'move'; velocity: number } // target velocity; 0 = decelerating to a stop
  | { kind: 'goto'; target: number; fast: boolean }; // physical target

/** Completion tolerance (~3 steps). */
const GOTO_TOL_DEG = 3 * (360 / 2 ** 24);

const mod360 = (d: number) => ((d % 360) + 360) % 360;
const wrap180 = (d: number) => mod360(d + 180) - 180;

export class MotorAxis {
  pos = 0;
  offset = 0;
  /** Slew component (deg/s). */
  velocity = 0;
  /** Guide-rate component (deg/s, signed). */
  guideRate = 0;
  mode: Mode = { kind: 'idle' };

  // Registers
  backlashPos = 0;
  backlashNeg = 0;
  approach = 0;
  cordwrapEnabled = false;
  cordwrapPosDeg = 180;
  maxRateReg: number;
  maxRateEnabled = false;
  autoguideRate = 128;

  constructor(
    readonly kind: AxisKind,
    private readonly params: () => MotorParams,
  ) {
    this.maxRateReg = Math.round(params().maxRateDeg * 1000);
  }

  /** Encoder degrees: az 0..360, alt -180..180. */
  get encoder(): number {
    const e = this.pos + this.offset;
    return this.kind === 'az' ? mod360(e) : wrap180(e);
  }

  setEncoder(deg: number): void {
    this.offset = deg - this.pos;
  }

  get slewing(): boolean {
    return this.mode.kind !== 'idle';
  }

  goto(encoderDeg: number, fast: boolean): void {
    let target: number;
    if (this.kind === 'az') {
      let delta = wrap180(encoderDeg - this.encoder);
      if (this.cordwrapEnabled && this.crossesCordwrap(delta)) delta -= Math.sign(delta) * 360;
      target = this.pos + delta;
    } else {
      const [lo, hi] = this.params().altLimits;
      target = Math.min(hi, Math.max(lo, encoderDeg)) - this.offset;
    }
    if (this.params().gotoCancelsGuide) this.guideRate = 0;
    this.mode = { kind: 'goto', target, fast };
  }

  /** MOVE_POS/NEG: dir ±1, rate 0..9 (0 = stop, also aborts a goto). */
  move(dir: 1 | -1, rate: number): void {
    const rates = this.params().slewRates;
    const speed = rates[Math.max(0, Math.min(rates.length - 1, rate))] ?? 0;
    if (speed === 0 && this.mode.kind === 'idle') return;
    if (this.params().gotoCancelsGuide && speed > 0) this.guideRate = 0;
    this.mode = { kind: 'move', velocity: dir * speed };
  }

  private crossesCordwrap(delta: number): boolean {
    const e0 = this.encoder;
    const dc = delta > 0 ? mod360(this.cordwrapPosDeg - e0) : mod360(e0 - this.cordwrapPosDeg);
    return dc > 0 && dc < Math.abs(delta);
  }

  private fastMax(): number {
    const p = this.params();
    return this.maxRateEnabled ? Math.min(p.maxRateDeg, this.maxRateReg / 1000) : p.maxRateDeg;
  }

  tick(dt: number): void {
    if (dt <= 0) return;
    const p = this.params();
    const a = p.accelDeg;
    const m = this.mode;
    let desired = 0;

    if (m.kind === 'move') {
      desired = m.velocity;
    } else if (m.kind === 'goto') {
      const d = m.target - this.pos;
      const vmax = m.fast ? this.fastMax() : p.slowRateDeg;
      const wouldReach = Math.sign(this.velocity) === Math.sign(d) && Math.abs(this.velocity * dt) >= Math.abs(d);
      if (Math.abs(d) <= GOTO_TOL_DEG || wouldReach) {
        this.pos = m.target;
        this.velocity = 0;
        this.mode = { kind: 'idle' };
        this.pos += this.guideRate * dt;
        this.clampAlt();
        return;
      }
      // Trapezoidal profile: never faster than what can still be braked within the remaining distance.
      desired = Math.sign(d) * Math.min(vmax, Math.max(Math.sqrt(2 * a * Math.abs(d)), 1e-3));
    }

    const dv = desired - this.velocity;
    this.velocity += Math.sign(dv) * Math.min(Math.abs(dv), a * dt);
    if (m.kind === 'move' && m.velocity === 0 && this.velocity === 0) this.mode = { kind: 'idle' };

    this.pos += (this.velocity + this.guideRate) * dt;
    this.clampAlt();
  }

  private clampAlt(): void {
    if (this.kind !== 'alt') return;
    const [lo, hi] = this.params().altLimits;
    const e = this.pos + this.offset;
    if (e < lo || e > hi) {
      this.pos = Math.min(hi, Math.max(lo, e)) - this.offset;
      this.velocity = 0;
      if (this.mode.kind === 'move') this.mode = { kind: 'idle' };
    }
  }

  /** Stop all motion immediately and reset registers (power cycle). */
  reset(): void {
    this.velocity = 0;
    this.guideRate = 0;
    this.mode = { kind: 'idle' };
    this.cordwrapEnabled = false;
    this.backlashPos = this.backlashNeg = 0;
  }
}
