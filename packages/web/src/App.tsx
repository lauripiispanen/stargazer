// App shell: boots the store (server link, catalog, location), then shows the desktop sky map or the phone
// remote (lib/layout.ts). The desktop layout is lazy-loaded: phones never download three.js.
import { lazy, Suspense, useEffect } from 'react';
import { useStore, REMOTE_TABS, type PanelTab, type RemoteTab } from './state/store.ts';
import { startSlewController } from './state/slewController.ts';
import { loadCatalog } from './lib/catalog.ts';
import { extraDsoRecords } from './lib/astroAdapter.ts';
import { cachedToLocation, readCachedGeo } from './lib/location.ts';
import { activeSky, centerOn } from './sky/viewControl.ts';
import { search } from './lib/search.ts';
import { requestGeolocation } from './panels/LocationPanel.tsx';
import { RemoteApp } from './remote/RemoteApp.tsx';

const DesktopApp = lazy(() => import('./DesktopApp.tsx'));

let booted = false;
function useBootstrap() {
  useEffect(() => {
    if (booted) return;
    booted = true;
    const params = new URLSearchParams(window.location.search);
    const mock = params.has('mock');
    const st = useStore.getState();
    st.start(mock);
    const panel = params.get('panel');
    if (panel && ['status', 'tonight', 'list', 'align', 'location'].includes(panel)) st.setPanel(panel as PanelTab);
    const tab = params.get('tab');
    if (tab && (REMOTE_TABS as string[]).includes(tab)) st.setRemoteTab(tab as RemoteTab);
    if (params.has('night')) st.setNight(true);
    // ?mock&demo: auto-connect the fake mount and set Home (for demos / screenshots)
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
        const sel = params.get('select');
        const idx = useStore.getState().searchIndex;
        const hit = sel && idx ? search(idx, sel, 1)[0] : undefined;
        if (!hit) return;
        // the (lazy) sky map may not be up yet: wait a little for it, then centre (or just select on the remote)
        let tries = 0;
        const go = () => { if (activeSky() || useStore.getState().layout === 'remote' || ++tries > 40) centerOn(hit); else setTimeout(go, 150); };
        setTimeout(go, 200);
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

  // Night mode and layout on <html> for CSS
  const night = useStore((s) => s.night);
  useEffect(() => { document.documentElement.classList.toggle('night', night); }, [night]);
  const layout = useStore((s) => s.layout);
  useEffect(() => { document.documentElement.classList.toggle('remote', layout === 'remote'); }, [layout]);
}

export function App() {
  useBootstrap();
  const layout = useStore((s) => s.layout);
  if (layout === 'remote') return <RemoteApp />;
  return (
    <Suspense fallback={<div className="loading glass">Loading sky map…</div>}>
      <DesktopApp />
    </Suspense>
  );
}
