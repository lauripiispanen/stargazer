import { useEffect, useRef, useState } from 'react';
import { useStore, type Layers, type PanelTab } from '../state/store.ts';
import { useNow } from '../state/hooks.ts';
import { search } from '../lib/search.ts';
import { objectTitle, type SkyObject } from '../lib/catalog.ts';
import { fmtTime, toLocalInput } from '../lib/format.ts';
import { centerOn } from '../sky/SkyView.tsx';
import { connTone } from './StatusPanel.tsx';
import { Icon, Pill } from './ui.tsx';

export function SearchBox() {
  const index = useStore((s) => s.searchIndex);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const results = index && q ? search(index, q, 10) : [];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') { e.preventDefault(); ref.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const pick = (o: SkyObject) => { centerOn(o); setQ(''); setOpen(false); ref.current?.blur(); };
  return (
    <div className="search">
      <Icon name="search" />
      <input
        ref={ref} value={q} placeholder="Search M31, Vega, Jupiter, Orion Nebula…  ( / )" spellCheck={false}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(results.length - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
          else if (e.key === 'Enter' && results[hi]) pick(results[hi]);
          else if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur(); }
          e.stopPropagation();
        }}
        aria-label="Search sky objects"
      />
      {open && results.length > 0 && (
        <ul className="search-results glass">
          {results.map((o, i) => (
            <li key={o.key} className={i === hi ? 'hi' : ''} onMouseDown={(e) => { e.preventDefault(); pick(o); }} onMouseEnter={() => setHi(i)}>
              <span className="sr-name">{objectTitle(o)}</span>
              <span className="sr-meta dim">{o.typeLabel}{o.mag != null ? ` · ${o.mag.toFixed(1)}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {open && q && results.length === 0 && index && <ul className="search-results glass"><li className="dim">No match</li></ul>}
    </div>
  );
}

function TimeControls() {
  const offset = useStore((s) => s.timeOffsetMs);
  const setOffset = useStore((s) => s.setTimeOffset);
  const now = useNow(1000);
  const [picking, setPicking] = useState(false);
  const t = now + offset;
  const live = Math.abs(offset) < 1000;
  return (
    <div className="timectl" title="Sky time (the map rotates in real time)">
      <Icon name="clock" />
      {picking ? (
        <input type="datetime-local" className="input mono" autoFocus defaultValue={toLocalInput(t)}
          onChange={(e) => { const v = new Date(e.target.value).getTime(); if (Number.isFinite(v)) setOffset(v - Date.now()); }}
          onBlur={() => setPicking(false)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') setPicking(false); }} />
      ) : (
        <button className={`time-btn mono ${live ? '' : 'offset'}`} onClick={() => setPicking(true)}>
          {fmtTime(t, true)}{!live && <span className="time-date"> {new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>}
        </button>
      )}
      <button className="chip" onClick={() => setOffset(offset - 3600e3)} title="−1 hour">−1h</button>
      <button className="chip" onClick={() => setOffset(offset + 3600e3)} title="+1 hour">+1h</button>
      <button className={`chip ${live ? 'on' : ''}`} onClick={() => setOffset(0)} title="Back to now">Now</button>
    </div>
  );
}

const LAYER_LABELS: [keyof Layers, string][] = [
  ['constellations', 'Constellation lines'], ['constellationNames', 'Constellation names'], ['starNames', 'Star names'],
  ['dsos', 'Deep-sky objects'], ['planets', 'Sun, Moon & planets'], ['milkyWay', 'Milky Way outline'],
  ['altAzGrid', 'Alt-az grid'], ['eqGrid', 'Equatorial grid (+ecliptic)'], ['ground', 'Ground'],
];

function LayersMenu() {
  const layers = useStore((s) => s.layers);
  const toggle = useStore((s) => s.toggleLayer);
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-wrap">
      <button className={`icon-btn ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Layers" aria-label="Layers"><Icon name="layers" /></button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu glass">
            {LAYER_LABELS.map(([k, l]) => (
              <label key={k} className="menu-item"><input type="checkbox" checked={layers[k]} onChange={() => toggle(k)} /> {l}</label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function TopBar() {
  const mount = useStore((s) => s.mount);
  const link = useStore((s) => s.link);
  const mock = useStore((s) => s.mock);
  const night = useStore((s) => s.night);
  const setNight = useStore((s) => s.setNight);
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  const layers = useStore((s) => s.layers);
  const toggle = useStore((s) => s.toggleLayer);
  const fov = useStore((s) => s.view.fov);
  const c = link !== 'open' ? 'server offline' : mount?.connection ?? 'disconnected';
  const tone = link !== 'open' ? 'bad' : connTone(mount?.connection);
  return (
    <header className="topbar glass">
      <div className="brand" title="Stargazer">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden><path d="M12 2l2.2 6.6L21 12l-6.8 2.4L12 22l-2.2-7.6L3 12l6.8-3.4z" fill="var(--accent)" /></svg>
        <span>Stargazer</span>
        {mock && <span className="badge">MOCK</span>}
      </div>
      <button className="conn-pill" onClick={() => setPanel(panel === 'status' ? null : 'status')} title="Connection & status">
        <Pill tone={tone}>{c}</Pill>
      </button>
      <SearchBox />
      <TimeControls />
      <div className="tb-right">
        <span className="fov mono dim" title="Field of view">{fov >= 10 ? fov.toFixed(0) : fov.toFixed(1)}°</span>
        <button className={`icon-btn ${layers.altAzGrid ? 'on' : ''}`} onClick={() => toggle('altAzGrid')} title="Alt-az grid">Az</button>
        <button className={`icon-btn ${layers.eqGrid ? 'on' : ''}`} onClick={() => toggle('eqGrid')} title="Equatorial grid">Eq</button>
        <LayersMenu />
        <button className={`icon-btn night-btn ${night ? 'on' : ''}`} onClick={() => setNight(!night)} title="Night mode (red)" aria-pressed={night}><Icon name="eye" /></button>
      </div>
    </header>
  );
}

export const TABS: { id: PanelTab; label: string; icon: string }[] = [
  { id: 'status', label: 'Status', icon: 'plug' },
  { id: 'tonight', label: 'Tonight', icon: 'star' },
  { id: 'align', label: 'Align', icon: 'crosshair' },
  { id: 'location', label: 'Location', icon: 'pin' },
];
