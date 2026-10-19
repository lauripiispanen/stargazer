// Observing list: a pure reducer over the list ClientMessages, shared by the server and the GUI's mock mount,
// plus validation for entries loaded from disk. See api.ts (`listAdd` etc. and ServerMessage `list`).
import type { ClientMessage, ObservingListEntry, Target } from './api.ts';

export type ListMessage = Extract<ClientMessage, { type: 'listAdd' | 'listRemove' | 'listMove' | 'listMarkObserved' }>;

export const LIST_MAX_ENTRIES = 300;
export const LIST_NOTE_MAX = 500;

export function isListMessage(m: ClientMessage): m is ListMessage {
  return m.type === 'listAdd' || m.type === 'listRemove' || m.type === 'listMove' || m.type === 'listMarkObserved';
}

/** Same sky object? (catalog id, solar body, or same name and position within ~1′). */
export function sameTarget(a: Target, b: Target): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'body' && b.kind === 'body') return a.body === b.body;
  if (a.kind === 'radec' && b.kind === 'radec') {
    if (a.id && b.id) return a.id === b.id;
    return a.name === b.name && Math.abs(a.ra - b.ra) < 0.02 && Math.abs(a.dec - b.dec) < 0.02;
  }
  if (a.kind === 'altaz' && b.kind === 'altaz') return a.name === b.name && Math.abs(a.az - b.az) < 0.02 && Math.abs(a.alt - b.alt) < 0.02;
  return false;
}

export function findListEntry(entries: readonly ObservingListEntry[], t: Target): ObservingListEntry | undefined {
  return entries.find((e) => sameTarget(e.target, t));
}

export interface ListContext {
  now: number;
  /** Fresh unique id for a new entry. */
  newId: () => string;
}

/**
 * Apply a list message. Returns the new array (the input is never mutated). Throws an Error with a
 * user-facing message for invalid requests (unknown id, duplicate, full list).
 */
export function applyListMessage(entries: readonly ObservingListEntry[], m: ListMessage, ctx: ListContext): ObservingListEntry[] {
  const idx = (id: string) => {
    const i = entries.findIndex((e) => e.id === id);
    if (i < 0) throw new Error('That entry is no longer on the observing list');
    return i;
  };
  switch (m.type) {
    case 'listAdd': {
      const dup = findListEntry(entries, m.target);
      if (dup) throw new Error(`${dup.name} is already on the observing list`);
      if (entries.length >= LIST_MAX_ENTRIES) throw new Error(`The observing list is full (${LIST_MAX_ENTRIES} entries)`);
      const note = m.note?.trim().slice(0, LIST_NOTE_MAX);
      const e: ObservingListEntry = { id: ctx.newId(), name: m.target.name, target: m.target, addedAt: ctx.now, observedAt: null, ...(note ? { note } : {}) };
      return [...entries, e];
    }
    case 'listRemove': {
      const i = idx(m.id);
      return [...entries.slice(0, i), ...entries.slice(i + 1)];
    }
    case 'listMove': {
      const i = idx(m.id);
      const out = [...entries];
      const [e] = out.splice(i, 1);
      const to = Math.max(0, Math.min(out.length, Math.round(m.index)));
      out.splice(to, 0, e!);
      return out;
    }
    case 'listMarkObserved': {
      const i = idx(m.id);
      const cur = entries[i]!;
      const observed = m.observed ?? true;
      const next: ObservingListEntry = { ...cur, observedAt: observed ? (cur.observedAt ?? ctx.now) : null };
      if (m.note !== undefined) {
        const note = m.note.trim().slice(0, LIST_NOTE_MAX);
        if (note) next.note = note;
        else delete next.note;
      }
      const out = [...entries];
      out[i] = next;
      return out;
    }
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Structural check of a Target (also used by the server's message validation). */
export function isValidTarget(t: unknown): t is Target {
  if (!t || typeof t !== 'object') return false;
  const x = t as Record<string, unknown>;
  if (typeof x.name !== 'string') return false;
  if (x.kind === 'radec') return isNum(x.ra) && isNum(x.dec);
  if (x.kind === 'altaz') return isNum(x.az) && isNum(x.alt);
  return x.kind === 'body' && typeof x.body === 'string';
}

/** Keep only well-formed entries (for data loaded from the state file); drops duplicates by id. */
export function sanitizeList(raw: unknown): ObservingListEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ObservingListEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const e = r as Record<string, unknown>;
    if (typeof e.id !== 'string' || seen.has(e.id) || !isValidTarget(e.target) || !isNum(e.addedAt)) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      name: typeof e.name === 'string' ? e.name : (e.target as Target).name,
      target: e.target as Target,
      addedAt: e.addedAt,
      observedAt: isNum(e.observedAt) ? e.observedAt : null,
      ...(typeof e.note === 'string' && e.note ? { note: e.note.slice(0, LIST_NOTE_MAX) } : {}),
    });
    if (out.length >= LIST_MAX_ENTRIES) break;
  }
  return out;
}
