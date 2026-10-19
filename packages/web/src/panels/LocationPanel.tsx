import { useState } from 'react';
import type { GeoLocation } from '@stargazer/shared/api.ts';
import { useStore, useLocation } from '../state/store.ts';
import { cachedToLocation, fmtLocation, parseCoord, readCachedGeo, searchCities, validLatLon, writeCachedGeo } from '../lib/location.ts';
import { Section, KV, Icon } from './ui.tsx';

export function requestGeolocation(onDone: (l: GeoLocation | null, err?: string) => void) {
  if (!('geolocation' in navigator)) { onDone(null, 'Geolocation is not available in this browser'); return; }
  navigator.geolocation.getCurrentPosition(
    (p) => {
      const g = { lat: p.coords.latitude, lon: p.coords.longitude, elevation: p.coords.altitude ?? 0, time: Date.now(), label: 'GPS / browser location' };
      writeCachedGeo(g);
      onDone({ lat: g.lat, lon: g.lon, elevation: g.elevation, source: 'gps', label: g.label });
    },
    (e) => onDone(null, e.message || 'Location unavailable (offline or permission denied)'),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60000 },
  );
}

export function LocationPanel() {
  const loc = useLocation();
  const serverLoc = useStore((s) => s.mount?.location ?? null);
  const setLocation = useStore((s) => s.setLocation);
  const catalog = useStore((s) => s.catalog);
  const [lat, setLat] = useState(loc.lat.toFixed(4));
  const [lon, setLon] = useState(loc.lon.toFixed(4));
  const [elev, setElev] = useState(String(Math.round(loc.elevation ?? 0)));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cached = readCachedGeo();
  const cities = catalog ? searchCities(catalog.cities, q) : [];

  const apply = (l: GeoLocation) => {
    setLocation(l);
    setLat(l.lat.toFixed(4)); setLon(l.lon.toFixed(4)); setElev(String(Math.round(l.elevation ?? 0)));
    setErr(null);
  };
  const manual = () => {
    const la = parseCoord(lat), lo = parseCoord(lon), el = Number(elev) || 0;
    if (!validLatLon(la, lo)) { setErr('Latitude must be −90…90 and longitude −180…180 (decimal degrees, or like 60°10′N)'); return; }
    apply({ lat: la, lon: lo, elevation: el, source: 'manual', label: 'Manual' });
  };
  return (
    <div className="panel-body">
      <Section title="Observing location">
        <KV k="In use" v={fmtLocation(loc)} />
        <KV k="Server has" v={serverLoc ? `${serverLoc.source}${serverLoc.label ? ` · ${serverLoc.label}` : ''}` : <span className="txt-warn">nothing yet</span>} />
        <div className="row-actions">
          <button className="btn primary" disabled={busy} onClick={() => { setBusy(true); requestGeolocation((l, e) => { setBusy(false); if (l) apply(l); else setErr(e ?? 'Failed'); }); }}>
            <Icon name="pin" /> {busy ? 'Locating…' : 'Use my location'}
          </button>
          {cached && (
            <button className="btn" onClick={() => apply(cachedToLocation(cached))} title={`Cached ${new Date(cached.time).toLocaleDateString()}`}>
              Cached ({cached.lat.toFixed(2)}, {cached.lon.toFixed(2)}){cached.stale ? ' · old' : ''}
            </button>
          )}
        </div>
        <div className="note dim small">Browser geolocation usually needs internet (WiFi positioning), so it may fail on the telescope's network. The last fix is cached for offline use.</div>
        {err && <div className="note bad">{err}</div>}
      </Section>
      <Section title="Manual entry">
        <div className="form-grid">
          <label>Latitude<input className="input mono" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="60.17 or 60°10′N" /></label>
          <label>Longitude<input className="input mono" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="24.94 or 24°56′E" /></label>
          <label>Elevation (m)<input className="input mono" type="number" value={elev} onChange={(e) => setElev(e.target.value)} /></label>
        </div>
        <button className="btn" onClick={manual}><Icon name="check" /> Set location</button>
      </Section>
      <Section title="Pick a city">
        <input className="input" placeholder="Search cities (offline list)…" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="city-list">
          {cities.map((c) => (
            <li key={`${c.name}-${c.country}-${c.lat}`}>
              <button onClick={() => apply({ lat: c.lat, lon: c.lon, elevation: 0, source: 'city', label: `${c.name}, ${c.country}` })}>
                <b>{c.name}</b> <span className="dim">{c.country}</span> <span className="mono dim small">{c.lat.toFixed(2)}, {c.lon.toFixed(2)}</span>
              </button>
            </li>
          ))}
          {q && cities.length === 0 && <li className="dim small">No match in the offline city list.</li>}
        </ul>
      </Section>
    </div>
  );
}
