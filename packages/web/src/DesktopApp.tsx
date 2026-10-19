// Full laptop UI: 3D sky dome (three.js) with side panels. Lazy-loaded by App.tsx so the phone remote never
// downloads three.js or the renderer.
import { useStore } from './state/store.ts';
import { SkyView } from './sky/SkyView.tsx';
import { TopBar, TABS } from './panels/TopBar.tsx';
import { StatusPanel } from './panels/StatusPanel.tsx';
import { TonightPanel } from './panels/TonightPanel.tsx';
import { AlignPanel } from './panels/AlignPanel.tsx';
import { LocationPanel } from './panels/LocationPanel.tsx';
import { ListPanel } from './panels/ListPanel.tsx';
import { InfoCard } from './panels/InfoCard.tsx';
import { SlewPad, StopButton } from './panels/SlewPad.tsx';
import { Banners, LogDrawer, Modals, Toasts } from './panels/Overlays.tsx';
import { Icon } from './panels/ui.tsx';

function SidePanel() {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  const quality = useStore((s) => s.mount?.alignment.quality);
  const listCount = useStore((s) => s.observingList?.filter((e) => !e.observedAt).length ?? 0);
  return (
    <aside className={`side ${panel ? 'open' : 'closed'}`}>
      <nav className="tabs glass">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${panel === t.id ? 'on' : ''}`} onClick={() => setPanel(panel === t.id ? null : t.id)} title={t.label}>
            <Icon name={t.icon} size={18} />
            <span>{t.label}</span>
            {t.id === 'align' && quality && quality !== 'aligned' && <i className={`dot dot-${quality === 'none' ? 'bad' : 'warn'}`} />}
            {t.id === 'list' && listCount > 0 && <i className="tab-count mono">{listCount}</i>}
          </button>
        ))}
      </nav>
      {panel && (
        <div className="panel glass">
          <button className="panel-close icon-btn" onClick={() => setPanel(null)} aria-label="Collapse panel"><Icon name="chevronL" /></button>
          {panel === 'status' && <StatusPanel />}
          {panel === 'tonight' && <TonightPanel />}
          {panel === 'list' && <ListPanel />}
          {panel === 'align' && <AlignPanel />}
          {panel === 'location' && <LocationPanel />}
        </div>
      )}
    </aside>
  );
}

export default function DesktopApp() {
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
