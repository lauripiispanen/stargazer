// Name/ID search over sky objects. Pure.
import type { SkyObject } from './catalog.ts';

/** Normalise a query or name: lowercase, strip accents/punctuation/space, canonicalise catalog prefixes. */
export function normalizeName(s: string): string {
  let t = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  t = t.replace(/^messier\s*/, 'm').replace(/^caldwell\s*/, 'c').replace(/^hip\s*/, 'hip');
  t = t.replace(/[^a-z0-9Ͱ-Ͽ]+/g, '');
  // 'ngc0224' -> 'ngc224', 'm031' -> 'm31'
  t = t.replace(/^(m|ngc|ic|c|hip)0+(\d)/, '$1$2');
  return t;
}

interface Entry { obj: SkyObject; terms: string[]; words: string[][] }

export interface SearchIndex { entries: Entry[] }

export function buildSearchIndex(objects: SkyObject[]): SearchIndex {
  return {
    entries: objects.map((obj) => {
      const raw = [obj.name, obj.id, ...obj.aliases].filter((s): s is string => !!s);
      return {
        obj,
        terms: [...new Set(raw.map(normalizeName))].filter(Boolean),
        words: raw.map((r) => r.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)),
      };
    }),
  };
}

const KIND_BONUS: Record<SkyObject['kind'], number> = { body: 4, dso: 2, star: 1, constellation: 0 };

/** Score: 100 exact, 80 prefix, 60 word-prefix, 40 substring; ties by kind and brightness. */
export function search(index: SearchIndex, query: string, limit = 12): SkyObject[] {
  const q = normalizeName(query);
  if (!q) return [];
  const qWords = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const scored: { obj: SkyObject; score: number }[] = [];
  for (const e of index.entries) {
    let best = 0;
    for (const t of e.terms) {
      if (t === q) { best = 100; break; }
      if (t.startsWith(q)) {
        // 'm3' should not rank 'm31' above 'm3': prefix matches on purely numeric tails score lower
        best = Math.max(best, /\d$/.test(q) && /^\d/.test(t.slice(q.length)) ? 50 : 80);
      } else if (t.includes(q) && q.length >= 3) best = Math.max(best, 40);
    }
    if (best < 60 && qWords.length > 0) {
      for (const ws of e.words) {
        if (qWords.every((qw) => ws.some((w) => w.startsWith(qw)))) { best = Math.max(best, 60); break; }
      }
    }
    if (best > 0) {
      const mag = e.obj.mag ?? 12;
      scored.push({ obj: e.obj, score: best * 100 + KIND_BONUS[e.obj.kind] * 5 - mag });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.obj);
}
