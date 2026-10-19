// Remote "Search" tab: the catalog search with altitude, visibility and GoTo per result. GoTo buttons use the
// same blocking rules and reasons as the desktop (useGotoBlocker), and the same keep-clear / confirm modals.
import { useState } from 'react';
import { useLocation, useStore } from '../state/store.ts';
import { useGotoBlocker, useNow, useSun } from '../state/hooks.ts';
import { search } from '../lib/search.ts';
import { objectToTarget } from '../lib/astroAdapter.ts';
import { objectTitle } from '../lib/catalog.ts';
import { compassPoint, fmtDeg, fmtMag, fmtTime } from '../lib/format.ts';
import { mountLimits, sunIsUp } from '../lib/safety.ts';
import { targetVisibility } from '../lib/visibility.ts';
import { AddToListButton } from '../panels/ListPanel.tsx';
import { Icon } from '../panels/ui.tsx';

const QUICK = ['Moon', 'Jupiter', 'Saturn', 'M31', 'M42', 'M13', 'Pleiades', 'Albireo', 'Vega'];

export function SearchTab() {
  const index = useStore((s) => s.searchIndex);
  const catalogError = useStore((s) => s.catalogError);
  const mount = useStore((s) => s.mount);
  const requestGoto = useStore((s) => s.requestGoto);
  const select = useStore((s) => s.select);
  const setTab = useStore((s) => s.setRemoteTab);
  const blocker = useGotoBlocker();
  const loc = useLocation();
  const now = useNow(30000);
  const sun = useSun();
  const limits = mountLimits(mount);
  const [q, setQ] = useState('');
  const results = index && q.trim() ? search(index, q, 25).filter((o) => o.kind !== 'constellation') : [];

  return (
    <div className="r-tab-body">
      <div className="r-search">
        <Icon name="search" size={18} />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="M31, Vega, Jupiter, Orion Nebula…" aria-label="Search sky objects"
          autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="search" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        {q && <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear search"><Icon name="x" /></button>}
      </div>
      {!index && <div className="note dim">{catalogError ? `Catalog failed to load: ${catalogError}` : 'Loading catalog…'}</div>}
      {index && !q.trim() && (
        <div className="r-quick">
          <div className="dim small">Try</div>
          <div className="chips">{QUICK.map((n) => <button key={n} className="chip r-chip" onClick={() => setQ(n)}>{n}</button>)}</div>
        </div>
      )}
      <ul className="r-results">
        {results.map((o) => {
          const target = objectToTarget(o);
          const vis = targetVisibility(target, loc, now, limits, (t) => fmtTime(t));
          const block = blocker(o);
          return (
            <li key={o.key} className="r-result">
              <div className="r-res-row">
                <button className="r-res-main" onClick={() => { select(o); setTab('control'); }} title="Show in the sky view">
                  <span className="r-res-name">{objectTitle(o)}</span>
                  <span className="dim small">{o.typeLabel}{o.mag != null ? ` · mag ${fmtMag(o.mag)}` : ''}</span>
                  {vis && (
                    <span className={`small vis vis-${vis.level}`}>
                      {vis.alt >= 0 ? `${fmtDeg(vis.alt, 0)} ${compassPoint(vis.az)} · ` : `${fmtDeg(vis.alt, 0)} · `}{vis.label}
                    </span>
                  )}
                </button>
                <AddToListButton target={target} small label={false} />
                <span className="btn-wrap" title={block ?? `GoTo ${o.name}`}>
                  <button className="btn primary r-goto" disabled={!!block} onClick={() => requestGoto(target, { daytime: sunIsUp(sun.alt, limits) })}>GoTo</button>
                </span>
              </div>
              {block && <div className="dim small block-reason">{block}</div>}
            </li>
          );
        })}
        {index && q.trim() && results.length === 0 && <li className="note dim">No match.</li>}
      </ul>
    </div>
  );
}
