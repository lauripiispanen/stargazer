import { useMemo, useState } from 'react';
import { useStore, useLocation } from '../state/store.ts';
import { useGotoBlocker, useNow, useSun } from '../state/hooks.ts';
import { observingConditions, whatsUpTonight, type TonightItem, type TonightCategory } from '../lib/astroAdapter.ts';
import { sunIsUp } from '../lib/safety.ts';
import { fmtDeg, fmtTime, fmtMag } from '../lib/format.ts';
import { DSO_TYPE_LABEL, type DsoType, type SkyObject } from '../lib/catalog.ts';
import { centerOn } from '../sky/SkyView.tsx';
import { Section, Icon } from './ui.tsx';

const FILTERS: { id: string; label: string; match: (i: TonightItem) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'planets', label: 'Moon & planets', match: (i) => i.category === 'planet' || i.category === 'moon' },
  { id: 'galaxy', label: 'Galaxies', match: (i) => i.type === 'galaxy' },
  { id: 'clusters', label: 'Clusters', match: (i) => i.type === 'open-cluster' || i.type === 'globular-cluster' },
  { id: 'nebula', label: 'Nebulae', match: (i) => ['nebula', 'planetary-nebula', 'supernova-remnant'].includes(i.type) },
  { id: 'double', label: 'Doubles', match: (i) => i.category === 'double-star' },
  { id: 'star', label: 'Stars', match: (i) => i.category === 'star' },
];

function typeLabel(i: TonightItem): string {
  if (i.category === 'moon') return 'Moon';
  if (i.category === 'planet') return 'Planet';
  if (i.category === 'star') return 'Star';
  if (i.category === 'double-star') return 'Double star';
  return DSO_TYPE_LABEL[i.type as DsoType] ?? i.type;
}

/** Map a tonight item to a selectable sky object (prefer the catalog entry). */
function toSkyObject(i: TonightItem, all: SkyObject[]): SkyObject {
  const t = i.target;
  const hit = all.find((o) => o.id === i.id || (t.kind === 'body' && o.body === t.body));
  if (hit) return hit;
  const ra = t.kind === 'radec' ? t.ra : 0, dec = t.kind === 'radec' ? t.dec : 0;
  return { key: `tonight:${i.id}`, kind: i.category === 'star' ? 'star' : 'dso', name: i.name, id: i.id, aliases: [], ra, dec, mag: i.mag ?? undefined, typeLabel: typeLabel(i), sizeArcmin: i.sizeArcmin, con: i.con };
}

export function TonightPanel() {
  const catalog = useStore((s) => s.catalog);
  const blocker = useGotoBlocker();
  const requestGoto = useStore((s) => s.requestGoto);
  const offset = useStore((s) => s.timeOffsetMs);
  const loc = useLocation();
  const now = useNow(60000);
  const sun = useSun();
  const [filter, setFilter] = useState('all');
  const [when, setWhen] = useState<'now' | 'later'>('later');
  const t = now + offset;
  const locKey = `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;

  const cond = useMemo(() => { try { return observingConditions(loc, t); } catch (e) { console.warn(e); return null; } },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locKey, Math.floor(t / 600000)]);
  const items = useMemo(() => {
    if (!catalog) return [];
    try {
      const cats: TonightCategory[] | undefined = undefined;
      return whatsUpTonight(loc, t, { dsos: catalog.dsoRecords, stars: catalog.stars, starNames: catalog.starNames, starsFile: catalog.starsFile ?? undefined }, { limit: 120, categories: cats });
    } catch (e) { console.warn('whatsUpTonight failed', e); return []; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, locKey, Math.floor(t / 600000)]);

  const all = useMemo(() => catalog ? [...catalog.bodies, ...catalog.dsos, ...catalog.namedStars] : [], [catalog]);
  const f = FILTERS.find((x) => x.id === filter)!;
  const shown = items.filter(f.match).filter((i) => when === 'later' || i.altNow > 15).slice(0, 60);

  return (
    <div className="panel-body">
      <Section title="Tonight">
        {cond ? (
          <>
            <div className="cond-summary">{cond.summary}</div>
            <NightBar cond={cond} now={t} />
            <div className="cond-grid">
              <div><span className="k">Sunset</span><span className="mono">{fmtTime(cond.sunset)}</span></div>
              <div><span className="k">Dark</span><span className="mono">{cond.darkStart ? `${fmtTime(cond.darkStart)}–${fmtTime(cond.darkEnd)}` : cond.darkness}</span></div>
              <div><span className="k">Sunrise</span><span className="mono">{fmtTime(cond.sunrise)}</span></div>
              <div><span className="k">Moon</span><span className="mono"><MoonGlyph phase={cond.moon.phase} /> {Math.round(cond.moon.phase * 100)}%</span></div>
            </div>
          </>
        ) : <div className="note dim">Computing…</div>}
      </Section>
      <div className="filters">
        <div className="seg">
          <button className={when === 'now' ? 'on' : ''} onClick={() => setWhen('now')}>Up now</button>
          <button className={when === 'later' ? 'on' : ''} onClick={() => setWhen('later')}>Later tonight</button>
        </div>
        <div className="chips">
          {FILTERS.map((x) => <button key={x.id} className={`chip ${filter === x.id ? 'on' : ''}`} onClick={() => setFilter(x.id)}>{x.label}</button>)}
        </div>
      </div>
      <ol className="tonight-list">
        {shown.map((i, n) => {
          const o = toSkyObject(i, all);
          const block = blocker(i.target);
          return (
            <li key={i.id} className="tonight-item" onClick={() => centerOn(o)}>
              <span className="rank mono">{n + 1}</span>
              <div className="ti-main">
                <div className="ti-name">{i.category === 'dso' && i.id !== i.name && !i.name.startsWith(i.id) ? <><b>{i.id}</b> {i.name}</> : <b>{i.name}</b>}</div>
                <div className="ti-meta dim">
                  {typeLabel(i)}{i.mag != null ? ` · mag ${fmtMag(i.mag)}` : ''} · {i.altNow > 0 ? `now ${fmtDeg(i.altNow, 0)}` : 'below horizon'} · best {fmtTime(i.bestTime)} ({fmtDeg(i.maxAlt, 0)})
                </div>
                {i.description && <div className="ti-desc dim">{i.description}</div>}
              </div>
              <span className="btn-wrap" title={block ?? 'GoTo'} onClick={(e) => e.stopPropagation()}>
                <button className="btn small" disabled={!!block} onClick={() => requestGoto(i.target, { daytime: sunIsUp(sun.alt) })}>GoTo</button>
              </span>
            </li>
          );
        })}
        {shown.length === 0 && <li className="note dim">Nothing matches. Try “Later tonight” or another filter.</li>}
      </ol>
    </div>
  );
}

function NightBar({ cond, now }: { cond: NonNullable<ReturnType<typeof observingConditions>>; now: number }) {
  const start = (cond.sunset ?? cond.windowStart) - 3600e3;
  const end = (cond.sunrise ?? cond.windowEnd) + 3600e3;
  const span = Math.max(1, end - start);
  const pct = (t: number | null) => t == null ? null : Math.min(100, Math.max(0, ((t - start) / span) * 100));
  const ss = pct(cond.sunset) ?? 0, sr = pct(cond.sunrise) ?? 100, ds = pct(cond.darkStart), de = pct(cond.darkEnd), n = pct(now);
  return (
    <div className="nightbar" title="Twilight and darkness tonight">
      <div className="nb-twi" style={{ left: `${ss}%`, width: `${Math.max(0, sr - ss)}%` }} />
      {ds != null && de != null && <div className="nb-dark" style={{ left: `${ds}%`, width: `${Math.max(0, de - ds)}%` }} />}
      {n != null && n > 0 && n < 100 && <div className="nb-now" style={{ left: `${n}%` }} />}
    </div>
  );
}

export function MoonGlyph({ phase }: { phase: number }) {
  const r = 6, k = phase;
  const ex = r * Math.abs(1 - 2 * k);
  return (
    <svg width="14" height="14" viewBox="-7 -7 14 14" className="moon-glyph" aria-hidden>
      <circle r={r} fill="currentColor" opacity="0.2" />
      <path d={`M0 ${-r} A ${r} ${r} 0 0 1 0 ${r} A ${ex} ${r} 0 0 ${k < 0.5 ? 0 : 1} 0 ${-r}`} fill="currentColor" />
    </svg>
  );
}

export { Icon };
