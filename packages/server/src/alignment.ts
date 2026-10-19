// Alignment session: alignment points, home guess, sync, and model refits via pointing.fitModel.
import type { AlignmentHome, AlignmentPoint, AlignmentState, GeoLocation, PointingModelParams, Target } from '@stargazer/shared/api.ts';
import { ZERO_PARAMS } from '@stargazer/shared/pointing.ts';
import type { AstroApi } from './astroApi.ts';

type Encoder = { az: number; alt: number };

export interface AlignmentSnapshot {
  quality: AlignmentState['quality'];
  points: AlignmentPoint[];
  params: PointingModelParams | null;
  home: PointingModelParams | null;
  rmsArcmin: number | null;
  solved: (keyof PointingModelParams)[];
  nextId: number;
  /** How Home was set (absent in files written before sensor Home existed). */
  homeInfo?: AlignmentHome | null;
}

/** Home details other than the encoder reading (az/alt default to 0/0 = level and north). */
export type HomeOptions = Partial<Omit<AlignmentHome, 'time'>> & { time?: number };

export class Alignment {
  private points: AlignmentPoint[] = [];
  private params: PointingModelParams | null = null;
  private home: PointingModelParams | null = null;
  private quality: AlignmentState['quality'] = 'none';
  private rmsArcmin: number | null = null;
  private solved: (keyof PointingModelParams)[] = [];
  private nextId = 1;
  private homeInfo: AlignmentHome | null = null;
  /** Warnings from the last fit (poor geometry, dropped params, ...). */
  fitWarnings: string[] = [];

  constructor(private readonly astro: AstroApi) {}

  get state(): AlignmentState {
    return {
      quality: this.quality,
      points: this.points.map((p) => ({ ...p })),
      params: this.params ? { ...this.params } : null,
      rmsArcmin: this.rmsArcmin,
      solved: [...this.solved],
      home: this.homeInfo ? { ...this.homeInfo } : null,
    };
  }

  get model(): PointingModelParams | null {
    return this.params;
  }

  /** The tube points at sky (az, alt) (default level & north): rough IA/IE so the current encoder maps there. Starts a new alignment. */
  setHome(enc: Encoder, opts: HomeOptions = {}): void {
    const az = opts.azDeg ?? 0;
    const alt = opts.altDeg ?? 0;
    this.home = this.astro.offsetsFromPoint({ az, alt }, enc, ZERO_PARAMS);
    this.homeInfo = { ...opts, source: opts.source ?? 'manual', azDeg: az, altDeg: alt, time: opts.time ?? Date.now() };
    this.fitWarnings = [];
    this.points = [];
    this.params = { ...this.home };
    this.quality = 'rough';
    this.rmsArcmin = null;
    this.solved = ['IA', 'IE'];
  }

  addPoint(target: Target, enc: Encoder, time: number, loc: GeoLocation): AlignmentPoint {
    const point: AlignmentPoint = { id: this.nextId++, target, encoder: { ...enc }, time };
    this.points.push(point);
    try {
      this.refit(loc);
    } catch (e) {
      this.points.pop();
      throw e;
    }
    return point;
  }

  removePoint(id: number, loc: GeoLocation | null): void {
    const before = this.points.length;
    this.points = this.points.filter((p) => p.id !== id);
    if (this.points.length === before) throw new Error(`no alignment point ${id}`);
    this.refit(loc);
  }

  clear(): void {
    this.points = [];
    this.params = null;
    this.home = null;
    this.homeInfo = null;
    this.quality = 'none';
    this.rmsArcmin = null;
    this.solved = [];
    this.fitWarnings = [];
  }

  /** Quick sync: shift IA/IE only so the current encoder position maps onto `target`. */
  sync(target: Target, enc: Encoder, time: number, loc: GeoLocation): void {
    const sky = this.astro.targetAltAz(target, loc, time);
    this.params = this.astro.offsetsFromPoint(sky, enc, this.params ?? ZERO_PARAMS);
    if (this.quality === 'none') {
      this.quality = 'rough';
      this.solved = ['IA', 'IE'];
    }
  }

  /** Recompute the model from the points (e.g. after a location change). */
  refit(loc: GeoLocation | null): void {
    if (!this.points.length) {
      this.params = this.home ? { ...this.home } : null;
      this.quality = this.home ? 'rough' : 'none';
      this.solved = this.home ? ['IA', 'IE'] : [];
      this.rmsArcmin = null;
      this.fitWarnings = [];
      return;
    }
    if (!loc) throw new Error('location is required to fit the alignment model');
    const obs = this.points.map((p) => ({ sky: this.astro.targetAltAz(p.target, loc, p.time), encoder: p.encoder }));
    const fit = this.astro.fitModel(obs, this.home ?? this.params ?? undefined);
    this.params = fit.params;
    this.solved = fit.solved;
    this.rmsArcmin = fit.rmsArcmin;
    this.quality = 'aligned';
    this.fitWarnings = fit.warnings ?? [];
    this.points.forEach((p, i) => (p.residualArcmin = fit.residualsArcmin[i]));
  }

  snapshot(): AlignmentSnapshot {
    return { ...this.state, home: this.home, homeInfo: this.homeInfo, nextId: this.nextId };
  }

  restore(s: AlignmentSnapshot | null | undefined): void {
    if (!s) return;
    this.points = s.points ?? [];
    this.params = s.params ?? null;
    this.home = s.home ?? null;
    this.homeInfo = s.homeInfo ?? (s.home ? { source: 'manual', azDeg: 0, altDeg: 0, time: 0 } : null);
    this.quality = s.quality ?? 'none';
    this.rmsArcmin = s.rmsArcmin ?? null;
    this.solved = s.solved ?? [];
    this.nextId = s.nextId ?? this.points.reduce((m, p) => Math.max(m, p.id + 1), 1);
  }
}
