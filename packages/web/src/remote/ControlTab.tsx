// Remote "Control" tab: connection, where the scope points, a small sky view, the touch slew pad, tracking
// and the compact power & health card. STOP lives in RemoteApp (always visible above the tab bar).
import { useState } from 'react';
import { DEFAULT_TELESCOPE_HOST, DEFAULT_TELESCOPE_PORT, SIMULATOR_AUX_PORT } from '@stargazer/shared/api.ts';
import { useStore } from '../state/store.ts';
import { compassPoint, fmtDeg, fmtDms, fmtRa } from '../lib/format.ts';
import { connTone, HealthCard } from '../panels/StatusPanel.tsx';
import { Pill, Section, Toggle } from '../panels/ui.tsx';
import { MiniSky } from './MiniSky.tsx';
import { RemotePad } from './RemotePad.tsx';

const PRESETS = [
  { label: 'Telescope WiFi', host: DEFAULT_TELESCOPE_HOST, port: DEFAULT_TELESCOPE_PORT },
  { label: 'Simulator', host: '127.0.0.1', port: SIMULATOR_AUX_PORT },
];

function Connection() {
  const mount = useStore((s) => s.mount);
  const link = useStore((s) => s.link);
  const mock = useStore((s) => s.mock);
  const send = useStore((s) => s.send);
  const [preset, setPreset] = useState<number | null>(null);
  const c = mount?.connection ?? 'disconnected';
  const busy = c === 'connecting';
  const cur = preset != null ? PRESETS[preset]! : { host: mount?.host ?? DEFAULT_TELESCOPE_HOST, port: mount?.port ?? DEFAULT_TELESCOPE_PORT };
  if (c === 'connected' || busy) {
    return (
      <div className="r-card r-conn-card">
        <div className="r-conn-line">
          <Pill tone={connTone(c)}>{c}{mount?.simulator && c === 'connected' ? ' · sim' : ''}</Pill>
          <span className="mono dim small">{mount?.host}:{mount?.port}</span>
          <button className="btn r-btn" onClick={() => send({ type: 'disconnect' })}>Disconnect</button>
        </div>
        {mount?.error && <div className="note bad small">{mount.error}</div>}
      </div>
    );
  }
  return (
    <Section title="Telescope" className="r-card" right={<Pill tone={connTone(c)}>{link !== 'open' ? 'server offline' : c}</Pill>}>
      {link !== 'open' && <div className="note warn small">{mock ? 'Starting mock…' : 'No connection to the Stargazer server on the laptop. Reconnecting…'}</div>}
      <div className="r-presets" role="radiogroup" aria-label="Telescope address">
        {PRESETS.map((p, i) => (
          <button key={p.label} role="radio" aria-checked={cur.host === p.host && cur.port === p.port} className={`r-preset ${cur.host === p.host && cur.port === p.port ? 'on' : ''}`} onClick={() => setPreset(i)}>
            <b>{p.label}</b><span className="mono dim small">{p.host}:{p.port}</span>
          </button>
        ))}
      </div>
      <button className="btn primary r-btn wide" disabled={link !== 'open'} onClick={() => send({ type: 'connect', host: cur.host, port: cur.port })}>Connect</button>
      {mount?.error && <div className="note bad small">{mount.error}</div>}
    </Section>
  );
}

function Pointing() {
  const mount = useStore((s) => s.mount);
  const send = useStore((s) => s.send);
  if (!mount || mount.connection !== 'connected') return null;
  const p = mount.pointing;
  const slewTone = mount.slew === 'idle' ? 'idle' : mount.slew === 'manual' ? 'info' : 'warn';
  return (
    <div className="r-card r-pointing">
      <div className="r-pt-head">
        <div className="r-pt-target"><span className="dim small">Target</span><b>{mount.target?.name ?? '—'}</b></div>
        <Pill tone={slewTone}>{mount.slew === 'idle' ? 'idle' : mount.slew.replace('goto-', 'GoTo ')}</Pill>
      </div>
      <div className="r-pt-grid mono">
        <div><span className="k">RA</span>{p ? fmtRa(p.ra) : '—'}</div>
        <div><span className="k">Alt</span>{p ? fmtDeg(p.alt, 1) : '—'}</div>
        <div><span className="k">Dec</span>{p ? fmtDms(p.dec) : '—'}</div>
        <div><span className="k">Az</span>{p ? `${fmtDeg(p.az, 1)} ${compassPoint(p.az)}` : '—'}</div>
      </div>
      {!p && <div className="note small">No pointing model yet: do <b>Home</b> in the Align tab.</div>}
      <Toggle on={mount.tracking} onChange={(v) => send({ type: 'setTracking', enabled: v })} label="Tracking" title="Sidereal tracking of the current position" />
    </div>
  );
}

export function ControlTab() {
  const connected = useStore((s) => s.mount?.connection === 'connected');
  return (
    <div className="r-tab-body">
      <Connection />
      <Pointing />
      <RemotePad />
      <MiniSky />
      {connected && <HealthCard compact />}
    </div>
  );
}
