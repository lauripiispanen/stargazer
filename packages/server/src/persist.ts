// Persisted server state (~/.stargazer/state.json): location, alignment, last encoder snapshot, observing list.
import fs from 'node:fs';
import path from 'node:path';
import type { GeoLocation, ObservingListEntry } from '@stargazer/shared/api.ts';
import type { AlignmentSnapshot } from './alignment.ts';

export interface PersistedState {
  version: 1;
  savedAt: number;
  location: GeoLocation | null;
  alignment: AlignmentSnapshot | null;
  /** Last known (logical) encoder position and when it was read. */
  encoder: { az: number; alt: number } | null;
  encoderTime: number | null;
  /** Unwrapped azimuth (cable-wrap frame) at encoderTime. */
  unwrappedAz?: number | null;
  /** Shared observing list (absent in files written before it existed). */
  observingList?: ObservingListEntry[];
}

export type PersistedData = Omit<PersistedState, 'version' | 'savedAt'>;

export class StateStore {
  constructor(readonly file: string) {}

  load(): PersistedState | null {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PersistedState;
      return s.version === 1 ? s : null;
    } catch {
      return null;
    }
  }

  /** Atomic write: temp file in the same directory, then rename. */
  save(data: PersistedData, now = Date.now()): void {
    const state: PersistedState = { version: 1, savedAt: now, ...data };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
