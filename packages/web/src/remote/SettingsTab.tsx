// Remote "Settings" tab: display (night mode, layout), observing location (the shared LocationPanel) and
// session info.
import { useStore } from '../state/store.ts';
import { LocationPanel } from '../panels/LocationPanel.tsx';
import { Icon, KV, Section, Toggle } from '../panels/ui.tsx';

export function SettingsTab() {
  const night = useStore((s) => s.night);
  const setNight = useStore((s) => s.setNight);
  const setLayout = useStore((s) => s.setLayout);
  const mount = useStore((s) => s.mount);
  const link = useStore((s) => s.link);
  const mock = useStore((s) => s.mock);
  return (
    <div className="r-tab-body">
      <Section title="Display" className="r-card">
        <div className="r-setting"><Toggle on={night} onChange={setNight} label="Night mode (red)" /></div>
        <button className="btn r-btn wide" onClick={() => setLayout('desktop')}><Icon name="monitor" /> Use the full desktop layout</button>
        <div className="dim small">The full layout has the 3D sky map; it's heavier and made for larger screens. Switch back with the phone icon in its top bar.</div>
      </Section>
      <Section title="Session" className="r-card">
        <KV k="Server" mono v={mock ? 'mock (in this browser)' : window.location.host} />
        <KV k="Link" v={link === 'open' ? 'connected' : link} />
        {mount?.clients != null && <KV k="Devices" v={`${mount.clients} connected`} />}
        <div className="note dim small">This phone shares the laptop's session: telescope, alignment and observing list. STOP on any device stops everything.</div>
      </Section>
      <LocationPanel />
    </div>
  );
}
