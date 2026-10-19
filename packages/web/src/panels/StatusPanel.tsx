import { useState } from 'react';
import { DEFAULT_TELESCOPE_HOST, DEFAULT_TELESCOPE_PORT, SIMULATOR_AUX_PORT, type MountHealth, type MountLimits } from '@stargazer/shared/api.ts';
import { useStore, useLocation } from '../state/store.ts';
import { useNow } from '../state/hooks.ts';
import { compassPoint, fmtDeg, fmtDms, fmtDuration, fmtRa, fmtTime } from '../lib/format.ts';
import { fmtLocation } from '../lib/location.ts';
import { adapterFallbacks } from '../lib/astroAdapter.ts';
import { mountHealth, mountLimits, wrapGauge } from '../lib/safety.ts';
import { KV, Pill, Section, Toggle, Icon } from './ui.tsx';
import { rendererFps, rendererCpuMs } from '../sky/SkyView.tsx';

const PRESETS = [
  { label: 'Telescope WiFi', host: DEFAULT_TELESCOPE_HOST, port: DEFAULT_TELESCOPE_PORT },
  { label: 'Simulator', host: '127.0.0.1', port: SIMULATOR_AUX_PORT },
];

export function connTone(c: string | undefined): 'ok' | 'warn' | 'bad' | 'idle' {
  return c === 'connected' ? 'ok' : c === 'connecting' ? 'warn' : c === 'error' ? 'bad' : 'idle';
}

function ConnectionCard() {
  const mount = useStore((s) => s.mount);
  const link = useStore((s) => s.link);
  const mock = useStore((s) => s.mock);
  const send = useStore((s) => s.send);
  // Until the user edits them, host/port follow the server (its TELESCOPE_HOST/PORT, or the last connection).
  const [hostEdit, setHost] = useState<string | null>(null);
  const [portEdit, setPort] = useState<number | null>(null);
  const host = hostEdit ?? mount?.host ?? DEFAULT_TELESCOPE_HOST;
  const port = portEdit ?? mount?.port ?? DEFAULT_TELESCOPE_PORT;
  const c = mount?.connection ?? 'disconnected';
  const busy = c === 'connecting';
  const connect = () => send({ type: 'connect', host, port });
  return (
    <Section title="Telescope" right={<Pill tone={connTone(c)}>{c}{mount?.simulator && c === 'connected' ? ' · sim' : ''}</Pill>}>
      {link !== 'open' && <div className="note warn">{mock ? 'Starting mock…' : 'No connection to the Stargazer server. Reconnecting…'}</div>}
      <div className="conn-row">
        <input className="input mono" value={host} onChange={(e) => setHost(e.target.value)} aria-label="Host" disabled={c === 'connected' || busy} />
        <span className="colon">:</span>
        <input className="input mono port" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} aria-label="Port" disabled={c === 'connected' || busy} />
        {c === 'connected' || busy
          ? <button className="btn" onClick={() => send({ type: 'disconnect' })}>Disconnect</button>
          : <button className="btn primary" onClick={connect} disabled={link !== 'open'}>Connect</button>}
      </div>
      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p.label} className={`chip ${host === p.host && port === p.port ? 'on' : ''}`} disabled={c === 'connected' || busy} onClick={() => { setHost(p.host); setPort(p.port); }}>
            {p.label} <span className="mono dim">{p.host}:{p.port}</span>
          </button>
        ))}
      </div>
      {mount?.error && <div className="note bad">{mount.error}</div>}
      {mount?.firmware && (
        <KV k="Firmware" mono v={[mount.firmware.az && `AZ ${mount.firmware.az}`, mount.firmware.alt && `ALT ${mount.firmware.alt}`, mount.firmware.wifi && `WiFi ${mount.firmware.wifi}`].filter(Boolean).join(' · ')} />
      )}
    </Section>
  );
}

function MountCard() {
  const mount = useStore((s) => s.mount);
  const send = useStore((s) => s.send);
  const follow = useStore((s) => s.follow);
  const setFollow = useStore((s) => s.setFollow);
  if (!mount) return null;
  const p = mount.pointing, e = mount.encoder, a = mount.alignment;
  const connected = mount.connection === 'connected';
  const slewTone = mount.slew === 'idle' ? 'idle' : mount.slew === 'manual' ? 'info' : 'warn';
  const q = a.quality;
  return (
    <Section title="Mount" right={<Pill tone={slewTone}>{mount.slew === 'idle' ? 'idle' : mount.slew.replace('goto-', 'GoTo ')}</Pill>}>
      <div className="grid2">
        <div className="readout">
          <div className="readout-h">Pointing (RA/Dec J2000)</div>
          <div className="mono big">{p ? fmtRa(p.ra) : '—'}</div>
          <div className="mono big">{p ? fmtDms(p.dec) : '—'}</div>
        </div>
        <div className="readout">
          <div className="readout-h">Alt / Az</div>
          <div className="mono big">{p ? `${fmtDeg(p.alt, 2)}` : '—'}</div>
          <div className="mono big">{p ? `${fmtDeg(p.az, 2)} ${compassPoint(p.az)}` : '—'}</div>
        </div>
      </div>
      <KV k="Raw encoders" mono v={e ? `az ${e.az.toFixed(3)}°  alt ${e.alt.toFixed(3)}°` : '—'} />
      <KV k="Target" v={mount.target ? mount.target.name : '—'} />
      <KV k="Alignment" v={<>
        <Pill tone={q === 'aligned' ? 'ok' : q === 'rough' ? 'warn' : 'bad'}>{q}</Pill>
        {a.rmsArcmin != null && <span className="mono dim"> RMS {a.rmsArcmin.toFixed(1)}′</span>}
        {a.points.length > 0 && <span className="dim"> · {a.points.length} star{a.points.length > 1 ? 's' : ''}</span>}
      </>} />
      {!p && connected && <div className="note">No pointing model yet. Open <b>Align</b> and do "Home" so the map can show where the scope points.</div>}
      <div className="toggles">
        <Toggle on={mount.tracking} disabled={!connected} onChange={(v) => send({ type: 'setTracking', enabled: v })} label="Tracking" title="Sidereal tracking of the current position" />
        <Toggle on={follow} disabled={!p} onChange={setFollow} label="Follow scope on map" />
      </div>
    </Section>
  );
}

function HealthCard() {
  const mount = useStore((s) => s.mount);
  const h: MountHealth | null = mountHealth(mount);
  if (!mount || mount.connection !== 'connected') return null;
  const limits = mountLimits(mount);
  const lim = limits.altDeg;
  return (
    <Section title={<><Icon name="gauge" /> Power &amp; health</>} className="health">
      {h?.warnings.length ? (
        <ul className="warnings">{h.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}</ul>
      ) : null}
      {!h && <div className="note dim">The server isn't reporting health telemetry yet.</div>}
      {h && (
        <>
          {h.battery ? (
            <KV k="Battery" v={<><span className="mono">{h.battery.volts.toFixed(2)} V</span> · {h.battery.level}{h.battery.charging ? ' · charging' : ''}</>} />
          ) : (
            <div className="note dim">Battery readout not supported by this mount. Link quality is shown instead, so watch for slow or erratic slews (low voltage).</div>
          )}
          <KV k="Link latency" mono v={<span className={h.latencyMs > 500 ? 'txt-bad' : h.latencyMs > 200 ? 'txt-warn' : ''}>{Math.round(h.latencyMs)} ms</span>} />
          <KV k="Timeouts" mono v={<span className={h.timeouts > 0 ? 'txt-warn' : ''}>{h.timeouts}</span>} />
          {h.slewSpeedRatio != null && (
            <KV k="Slew speed" mono title="Measured vs expected slew speed; low values suggest low voltage" v={<span className={h.slewSpeedRatio < 0.8 ? 'txt-bad' : ''}>{Math.round(h.slewSpeedRatio * 100)}% of nominal</span>} />
          )}
          {h.unwrappedAz != null && <WrapGauge az={h.unwrappedAz} limits={limits} />}
        </>
      )}
      <KV k="Alt slew limits" mono v={`${lim[0]}° … ${lim[1]}°`} title="Above the upper limit the tube can hit the tripod (SAFETY.md §1)" />
      <div className="note dim small">If the link drops, the telescope may keep moving. Keep the power plug within reach: unplugging it is the emergency stop.</div>
    </Section>
  );
}

function WrapGauge({ az, limits }: { az: number; limits: MountLimits }) {
  const g = wrapGauge(az, limits);
  const soft = limits.azSoftDeg;
  const pct = (x: number) => `${50 + x * 40}%`;
  return (
    <div className={`wrap-gauge wrap-${g.level}`} title={`Cable wrap: ${az.toFixed(0)}° from neutral (soft limit ±${soft}°)`}>
      <div className="wrap-h"><span>Cable wrap</span><span className="mono">{az >= 0 ? '+' : ''}{az.toFixed(0)}°</span></div>
      <div className="wrap-track">
        <span className="wrap-limit" style={{ left: pct(-1) }} />
        <span className="wrap-limit" style={{ left: pct(1) }} />
        <span className="wrap-zero" style={{ left: '50%' }} />
        <span className="wrap-needle" style={{ left: pct(g.fraction) }} />
      </div>
      <div className="wrap-scale mono"><span>−{soft}°</span><span>0</span><span>+{soft}°</span></div>
    </div>
  );
}

function TimeCard() {
  const now = useNow(1000);
  const skew = useStore((s) => s.clockSkewMs);
  const mount = useStore((s) => s.mount);
  const loc = useLocation();
  const fallbacks = adapterFallbacks();
  const bad = skew != null && Math.abs(skew) > 30000;
  return (
    <Section title="Time & place">
      <KV k="Location" v={fmtLocation(loc)} />
      <KV k="Browser time" mono v={fmtTime(now, true)} />
      <KV k="Server time" mono v={mount ? <span className={bad ? 'txt-bad' : ''}>{fmtTime(now + (skew ?? 0), true)}</span> : '—'} />
      {bad && <div className="note bad">Server and browser clocks differ by {fmtDuration(skew!)}. Pointing uses the server clock: check the laptop's time (1 min ≈ 15′ of RA error).</div>}
      <KV k="Renderer" mono v={`${rendererFps().toFixed(0)} fps · ${rendererCpuMs().toFixed(1)} ms CPU/frame`} />
      {fallbacks.length > 0 && <div className="note dim small">Local astro fallbacks in use: {fallbacks.join(', ')}</div>}
    </Section>
  );
}

export function StatusPanel() {
  return (
    <div className="panel-body">
      <ConnectionCard />
      <MountCard />
      <HealthCard />
      <TimeCard />
    </div>
  );
}
