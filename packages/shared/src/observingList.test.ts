import { describe, expect, it } from 'vitest';
import type { ObservingListEntry, Target } from './api.ts';
import { applyListMessage, findListEntry, sameTarget, sanitizeList } from './observingList.ts';

const m31: Target = { kind: 'radec', ra: 10.68, dec: 41.27, name: 'Andromeda Galaxy', id: 'M31' };
const vega: Target = { kind: 'radec', ra: 279.23, dec: 38.78, name: 'Vega' };
const jupiter: Target = { kind: 'body', body: 'Jupiter', name: 'Jupiter' };

function ctx(now = 1000) {
  let n = 0;
  return { now, newId: () => `e${++n}` };
}

describe('observing list reducer', () => {
  it('adds, refuses duplicates, removes', () => {
    const c = ctx();
    let l = applyListMessage([], { type: 'listAdd', target: m31, note: '  look for M110 ' }, c);
    l = applyListMessage(l, { type: 'listAdd', target: jupiter }, c);
    expect(l).toEqual([
      { id: 'e1', name: 'Andromeda Galaxy', target: m31, addedAt: 1000, observedAt: null, note: 'look for M110' },
      { id: 'e2', name: 'Jupiter', target: jupiter, addedAt: 1000, observedAt: null },
    ]);
    expect(() => applyListMessage(l, { type: 'listAdd', target: { ...m31, name: 'M31' } }, c)).toThrow(/already/);
    const before = l;
    l = applyListMessage(l, { type: 'listRemove', id: 'e1' }, c);
    expect(l.map((e) => e.id)).toEqual(['e2']);
    expect(before).toHaveLength(2); // not mutated
    expect(() => applyListMessage(l, { type: 'listRemove', id: 'nope' }, c)).toThrow(/no longer/);
  });

  it('reorders with clamping', () => {
    const c = ctx();
    let l: ObservingListEntry[] = [];
    for (const t of [m31, vega, jupiter]) l = applyListMessage(l, { type: 'listAdd', target: t }, c);
    expect(applyListMessage(l, { type: 'listMove', id: 'e3', index: 0 }, c).map((e) => e.id)).toEqual(['e3', 'e1', 'e2']);
    expect(applyListMessage(l, { type: 'listMove', id: 'e1', index: 99 }, c).map((e) => e.id)).toEqual(['e2', 'e3', 'e1']);
    expect(applyListMessage(l, { type: 'listMove', id: 'e2', index: -4 }, c).map((e) => e.id)).toEqual(['e2', 'e1', 'e3']);
  });

  it('marks observed with notes and unmarks', () => {
    let l = applyListMessage([], { type: 'listAdd', target: vega }, ctx(1));
    l = applyListMessage(l, { type: 'listMarkObserved', id: 'e1', note: 'blue-white, lovely' }, ctx(50));
    expect(l[0]).toMatchObject({ observedAt: 50, note: 'blue-white, lovely' });
    // re-marking keeps the first observation time; an empty note clears it
    l = applyListMessage(l, { type: 'listMarkObserved', id: 'e1', note: '' }, ctx(90));
    expect(l[0]!.observedAt).toBe(50);
    expect(l[0]!.note).toBeUndefined();
    l = applyListMessage(l, { type: 'listMarkObserved', id: 'e1', observed: false }, ctx(99));
    expect(l[0]!.observedAt).toBeNull();
  });

  it('matches targets sensibly', () => {
    expect(sameTarget(jupiter, { kind: 'body', body: 'Jupiter', name: 'Jup' })).toBe(true);
    expect(sameTarget(vega, { ...vega, ra: vega.ra + 0.001 })).toBe(true);
    expect(sameTarget(vega, { ...vega, name: 'Other' })).toBe(false);
    expect(sameTarget(m31, jupiter)).toBe(false);
    expect(findListEntry(applyListMessage([], { type: 'listAdd', target: m31 }, ctx()), { ...m31, name: 'x' })?.id).toBe('e1');
  });

  it('sanitizes persisted data', () => {
    const good = { id: 'a', name: 'Vega', target: vega, addedAt: 5, observedAt: null };
    expect(sanitizeList(null)).toEqual([]);
    expect(sanitizeList([good, { ...good }, { id: 'b', target: { kind: 'radec', name: 'x' }, addedAt: 1 }, 'junk', { id: 'c', target: jupiter, addedAt: 2, observedAt: 'x', note: 7 }])).toEqual([
      good,
      { id: 'c', name: 'Jupiter', target: jupiter, addedAt: 2, observedAt: null },
    ]);
  });
});
