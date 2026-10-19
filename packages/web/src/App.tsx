import { useEffect } from 'react';
import { useStore } from './state/store.ts';
import { startSlewController } from './state/slewController.ts';
import { loadCatalog } from './lib/catalog.ts';
import { extraDsoRecords } from './lib/astroAdapter.ts';
import { cachedToLocation, readCachedGeo } from './lib/location.ts';
import { SkyView, centerOn } from './sky/SkyView.tsx';
import { search } from './lib/search.ts';
import { TopBar, TABS } from './panels/TopBar.tsx';
import { StatusPanel } from './panels/StatusPanel.tsx';
import { TonightPanel } from './panels/TonightPanel.tsx';
import { AlignPanel } from './panels/AlignPanel.tsx';
import { LocationPanel, requestGeolocation } from './panels/LocationPanel.tsx';
import { InfoCard } from './panels/InfoCard.tsx';
import { SlewPad, StopButton } from './panels/SlewPad.tsx';
import { Banners, LogDrawer, Modals, Toasts } from './panels/Overlays.tsx';
import { Icon } from './panels/ui.tsx';

let booted = false;
function useBootstrap() {
  useEffect(() => {
    if (booted) return;
    booted = true;
    const mock = new URLSearchParams(window.location.search).has('mock');
    const st = useStore.getState();
    st.start(mock);
    // ?mock&demo: auto-connect the fake mount and set Home (for demos / screenshots)
    const params = new URLSearchParams(window.location.search);
    const panel = params.get('panel');
    if (panel && ['status', 'tonight', 'align', 'location'].includes(panel)) st.setPanel(panel as 'status');
    if (params.has('night')) st.setNight(true);
    if (mock && params.has('demo')) {
      setTimeout(() => {
        const s = useStore.getState();
        if (!s.mount?.location) s.setLocation({ lat: 60.17, lon: 24.94, elevation: 20, source: 'manual', label: 'Helsinki (demo)' });
        s.send({ type: 'connect' });
        setTimeout(() => { useStore.getState().send({ type: 'alignHome' }); }, 1200);
      }, 300);
    }
    startSlewController();
    loadCatalog({ extraDsos: extraDsoRecords })
      .then((c) => {
        useStore.getState().setCatalog(c);
        const sel = new URLSearchParams(window.location.search).get('select');
        const idx = useStore.getState().searchIndex;
        if (sel && idx) { const hit = search(idx, sel, 1)[0]; if (hit) setTimeout(() => centerOn(hit), 200); }
      })
      .catch((e) => { console.error(e); useStore.setState({ catalogError: String(e) }); });
  }, []);

  // Location bootstrap: prefer the server's; otherwise cached GPS, then a fresh geolocation attempt.
  const haveState = useStore((s) => !!s.mount);
  useEffect(() => {
    if (!haveState) return;
    const st = useStore.getState();
    if (st.locationBootstrapped) return;
    useStore.setState({ locationBootstrapped: true });
    if (st.mount?.location) return;
    const cached = readCachedGeo();
    if (cached && !cached.stale) { st.setLocation(cachedToLocation(cached)); st.log('info', 'Using cached location'); return; }
    requestGeolocation((l) => {
      if (l) { useStore.getState().setLocation(l); useStore.getState().log('info', 'Location from browser geolocation'); }
      else if (cached) useStore.getState().setLocation(cachedToLocation(cached));
    });
  }, [haveState]);

  // Night mode on <html> for CSS
  const night = useStore((s) => s.night);
  useEffect(() => { document.documentElement.classList.toggle('night', night); }, [night]);
}

function SidePanel() {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  const quality = useStore((s) => s.mount?.alignment.quality);
  return (
    <aside className={`side ${panel ? 'open' : 'closed'}`}>
      <nav className="tabs glass">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${panel === t.id ? 'on' : ''}`} onClick={() => setPanel(panel === t.id ? null : t.id)} title={t.label}>
            <Icon name={t.icon} size={18} />
            <span>{t.label}</span>
            {t.id === 'align' && quality && quality !== 'aligned' && <i className={`dot dot-${quality === 'none' ? 'bad' : 'warn'}`} />}
          </button>
        ))}
      </nav>
      {panel && (
        <div className="panel glass">
          <button className="panel-close icon-btn" onClick={() => setPanel(null)} aria-label="Collapse panel"><Icon name="chevronL" /></button>
          {panel === 'status' && <StatusPanel />}
          {panel === 'tonight' && <TonightPanel />}
          {panel === 'align' && <AlignPanel />}
          {panel === 'location' && <LocationPanel />}
        </div>
      )}
    </aside>
  );
}

export function App() {
  useBootstrap();
  const catalog = useStore((s) => s.catalog);
  const err = useStore((s) => s.catalogError);
  return (
    <div className="app">
      <SkyView />
      {!catalog && <div className="loading glass">{err ? `Failed to load catalog: ${err}` : 'Loading star catalog…'}</div>}
      <TopBar />
      <SidePanel />
      <Banners />
      <InfoCard />
      <div className="bottom-right">
        <StopButton />
        <SlewPad />
      </div>
      <LogDrawer />
      <Toasts />
      <Modals />
    </div>
  );
}
