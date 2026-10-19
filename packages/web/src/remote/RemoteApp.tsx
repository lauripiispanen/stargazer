// Phone remote: a touch-first layout that joins the same server session as the laptop (all telescope state is
// on the server). No three.js: the sky is a small 2D canvas (MiniSky). Bottom tab bar, STOP always visible
// above it while a telescope is connected, safe-area aware. Shares state, safety rules, modals and toasts
// with the desktop UI.
import { useStore, type RemoteTab } from '../state/store.ts';
import { connTone } from '../panels/StatusPanel.tsx';
import { Banners, Modals, Toasts } from '../panels/Overlays.tsx';
import { useStopVisible } from '../panels/SlewPad.tsx';
import { TonightPanel } from '../panels/TonightPanel.tsx';
import { ListPanel } from '../panels/ListPanel.tsx';
import { Icon, Pill } from '../panels/ui.tsx';
import { ControlTab } from './ControlTab.tsx';
import { SearchTab } from './SearchTab.tsx';
import { AlignTab } from './AlignTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import './remote.css';

const TABS: { id: RemoteTab; label: string; icon: string }[] = [
  { id: 'control', label: 'Control', icon: 'gamepad' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'tonight', label: 'Tonight', icon: 'star' },
  { id: 'list', label: 'List', icon: 'bookmark' },
  { id: 'align', label: 'Align', icon: 'crosshair' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

function Header() {
  const mount = useStore((s) => s.mount);
  const link = useStore((s) => s.link);
  const mock = useStore((s) => s.mock);
  const night = useStore((s) => s.night);
  const setNight = useStore((s) => s.setNight);
  const setTab = useStore((s) => s.setRemoteTab);
  const c = link !== 'open' ? 'server offline' : mount?.connection ?? 'disconnected';
  const tone = link !== 'open' ? 'bad' : connTone(mount?.connection);
  const clients = link === 'open' ? mount?.clients ?? 0 : 0;
  return (
    <header className="r-header">
      <div className="r-brand" aria-label="Stargazer">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden><path d="M12 2l2.2 6.6L21 12l-6.8 2.4L12 22l-2.2-7.6L3 12l6.8-3.4z" fill="var(--accent)" /></svg>
        {mock && <span className="badge">MOCK</span>}
      </div>
      <button className="r-conn" onClick={() => setTab('control')} title="Connection">
        <Pill tone={tone}>{c}</Pill>
        {clients > 1 && <span className="r-devices small"><Icon name="devices" size={13} /> {clients} devices</span>}
      </button>
      <button className={`icon-btn r-icon ${night ? 'on' : ''}`} onClick={() => setNight(!night)} aria-pressed={night} aria-label="Night mode" title="Night mode (red)">
        <Icon name="eye" size={20} />
      </button>
    </header>
  );
}

function RemoteStop() {
  const mount = useStore((s) => s.mount);
  const pending = useStore((s) => s.pendingStop);
  const stopAll = useStore((s) => s.stopAll);
  const visible = useStopVisible();
  if (!visible) return null;
  const moving = !!mount && (mount.slew !== 'idle' || mount.tracking);
  return (
    <div className="r-stop-wrap">
      <button className={`stop-btn r-stop ${moving ? 'moving' : ''}`} onClick={() => { navigator.vibrate?.(40); stopAll(); }} aria-label="STOP all motion">
        <span className="stop-octagon">STOP</span>
        <span className="stop-sub">{pending ? 'queued: reconnecting…' : moving ? (mount!.slew !== 'idle' ? `moving · ${mount!.slew.replace('goto-', 'GoTo ')}` : 'tracking') : 'all motion & tracking'}</span>
      </button>
    </div>
  );
}

function TabBar() {
  const tab = useStore((s) => s.remoteTab);
  const setTab = useStore((s) => s.setRemoteTab);
  const quality = useStore((s) => s.mount?.alignment.quality);
  const listCount = useStore((s) => s.observingList?.filter((e) => !e.observedAt).length ?? 0);
  return (
    <nav className="r-tabbar" aria-label="Sections">
      {TABS.map((t) => (
        <button key={t.id} className={`r-tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined} data-tab={t.id}>
          <Icon name={t.icon} size={22} />
          <span>{t.label}</span>
          {t.id === 'align' && quality && quality !== 'aligned' && <i className={`dot dot-${quality === 'none' ? 'bad' : 'warn'}`} />}
          {t.id === 'list' && listCount > 0 && <i className="tab-count mono">{listCount}</i>}
        </button>
      ))}
    </nav>
  );
}

export function RemoteApp() {
  const tab = useStore((s) => s.remoteTab);
  return (
    <div className="r-app">
      <Header />
      <main className="r-main" key={tab}>
        <Banners />
        {tab === 'control' && <ControlTab />}
        {tab === 'search' && <SearchTab />}
        {tab === 'tonight' && <TonightPanel />}
        {tab === 'list' && <ListPanel />}
        {tab === 'align' && <AlignTab />}
        {tab === 'settings' && <SettingsTab />}
      </main>
      <RemoteStop />
      <TabBar />
      <Toasts />
      <Modals />
    </div>
  );
}
