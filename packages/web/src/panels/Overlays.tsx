// Banners, modals (server confirmations, keep-clear notice, stop failure), toasts and the log drawer.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store.ts';
import { useNow, useSun } from '../state/hooks.ts';
import { autoSlewBlocked, mountHealth, mountLimits, sunIsUp } from '../lib/safety.ts';
import { fmtDuration, fmtTime } from '../lib/format.ts';
import { Icon } from './ui.tsx';

export function Banners() {
  const mount = useStore((s) => s.mount);
  const link = useStore((s) => s.link);
  const lost = useStore((s) => s.lostWhileMoving);
  const catalog = useStore((s) => s.catalog);
  const localLoc = useStore((s) => s.localLocation);
  const sun = useSun();
  const now = useNow(1000);
  const banners: { tone: 'bad' | 'warn' | 'info'; text: React.ReactNode; key: string; action?: React.ReactNode }[] = [];
  if (lost) {
    banners.push({
      key: 'lost', tone: 'bad',
      text: <><b>Connection lost while the telescope was {lost.what}.</b> It may still be moving (last command {fmtDuration(now - (lost.lastCommandAt || lost.since))} ago). If it doesn't stop, <b>unplug its power</b>.</>,
      action: <button className="btn small" onClick={() => useStore.setState({ lostWhileMoving: null })}>Dismiss</button>,
    });
  }
  const connected = link === 'open' && mount?.connection === 'connected';
  const limits = mountLimits(mount);
  const fault = mountHealth(mount)?.fault;
  if (connected && fault) {
    banners.push({ key: 'fault', tone: 'bad', text: <><b>Fault: {fault}</b> Motion is blocked. Check the telescope, then press STOP to acknowledge.</> });
  }
  if (connected && autoSlewBlocked(sun.alt, mount?.alignment.quality, limits)) {
    banners.push({ key: 'sun', tone: 'warn', text: <><Icon name="sun" /> <b>The Sun is up and the mount is not star-aligned: automatic slews (GoTo) are blocked.</b> Cap the tube and finder before moving it manually.</> });
  } else if (connected && sunIsUp(sun.alt, limits)) {
    banners.push({ key: 'sunup', tone: 'info', text: <><Icon name="sun" /> Daytime: GoTo refuses targets within {limits.sunDeg}° of the Sun. Never look at the Sun without a full-aperture solar filter.</> });
  }
  if (catalog && catalog.missing.length) {
    const core = catalog.missing.includes('stars') || catalog.missing.includes('dso');
    banners.push({ key: 'data', tone: core ? 'bad' : 'warn', text: <>{core ? <b>Catalog data not found — run <span className="mono">npm run setup</span> while online.</b> : 'Some catalog files are missing.'} <span className="dim">(missing: {catalog.missing.join(', ')})</span></> });
  }
  if (!mount?.location && !localLoc) banners.push({ key: 'loc', tone: 'info', text: <>No location set: showing the sky for a default location. </>, action: <button className="btn small" onClick={() => useStore.getState().setPanel('location')}>Set location</button> });
  if (!banners.length) return null;
  return (
    <div className="banners">
      {banners.map((b) => <div key={b.key} className={`banner banner-${b.tone}`}><span>{b.text}</span>{b.action}</div>)}
    </div>
  );
}

function Modal({ children, tone, onClose }: { children: React.ReactNode; tone?: 'bad' | 'warn'; onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button.primary, button')?.focus(); }, []);
  return (
    <div className="modal-backdrop" onKeyDown={(e) => { if (e.key === 'Escape' && onClose) onClose(); }}>
      <div ref={ref} className={`modal glass ${tone ? `modal-${tone}` : ''}`} role="dialog" aria-modal>{children}</div>
    </div>
  );
}

export function Modals() {
  const confirms = useStore((s) => s.confirms);
  const answer = useStore((s) => s.answerConfirm);
  const pendingGoto = useStore((s) => s.pendingGoto);
  const confirmGoto = useStore((s) => s.confirmGoto);
  const stopFailure = useStore((s) => s.stopFailure);
  const stopAll = useStore((s) => s.stopAll);
  const sun = useSun();
  const [dontAsk, setDontAsk] = useState(false);
  if (stopFailure) {
    return (
      <Modal tone="bad">
        <div className="stopfail">
          <div className="stopfail-icon">⚠</div>
          <h2>Cut power to the telescope now</h2>
          <p>Stopping the mount failed: it may still be moving. <b>Unplug the telescope's power cable.</b></p>
          <p className="dim small mono">{stopFailure}</p>
          <div className="row-actions">
            <button className="btn" onClick={() => stopAll()}>Send STOP again</button>
            <button className="btn primary" onClick={() => useStore.setState({ stopFailure: null })}>Power is off / it stopped</button>
          </div>
        </div>
      </Modal>
    );
  }
  if (confirms.length) {
    const c = confirms[0];
    const sunRelated = /sun/i.test(c.message);
    return (
      <Modal tone={sunRelated ? 'bad' : 'warn'} onClose={() => answer(c.id, false)}>
        <h2>{sunRelated ? 'Solar safety' : 'Please confirm'}</h2>
        <p>{c.message}</p>
        {sunRelated && <p className="note bad">Pointing at or near the Sun without a certified full-aperture solar filter can cause instant, permanent eye damage, and can damage the telescope and finder.</p>}
        <div className="row-actions">
          <button className="btn primary" onClick={() => answer(c.id, false)}>Cancel</button>
          <button className="btn danger" onClick={() => answer(c.id, true)}>Proceed anyway</button>
        </div>
      </Modal>
    );
  }
  if (pendingGoto) {
    const day = sunIsUp(sun.alt);
    return (
      <Modal tone="warn" onClose={() => confirmGoto(false)}>
        <h2>Telescope will move</h2>
        <p>Slewing to <b>{pendingGoto.name}</b>. Keep heads and hands clear of the tube: the eyepiece end swings quickly.</p>
        {day && <p className="note warn">Daytime: make sure the tube and finder are capped.</p>}
        {!day && <label className="check"><input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} /> Don't ask again this session</label>}
        <div className="row-actions">
          <button className="btn" onClick={() => confirmGoto(false)}>Cancel</button>
          <button className="btn primary" onClick={() => confirmGoto(true, !day && dontAsk)}><Icon name="target" /> Slew</button>
        </div>
      </Modal>
    );
  }
  return null;
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`} onClick={() => dismiss(t.id)}>{t.message}</div>
      ))}
    </div>
  );
}

export function LogDrawer() {
  const open = useStore((s) => s.logOpen);
  const logs = useStore((s) => s.logs);
  const [level, setLevel] = useState<'all' | 'warn'>('all');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [open, logs.length]);
  const errors = logs.filter((l) => l.level === 'error').length;
  const shown = level === 'all' ? logs.filter((l) => l.level !== 'debug') : logs.filter((l) => l.level === 'warn' || l.level === 'error');
  return (
    <div className={`logdrawer glass ${open ? 'open' : ''}`}>
      <button className="log-tab" onClick={() => useStore.setState({ logOpen: !open })}>
        <Icon name="log" size={14} /> Log {errors > 0 && <span className="badge bad">{errors}</span>}
      </button>
      {open && (
        <>
          <div className="log-h">
            <div className="seg small">
              <button className={level === 'all' ? 'on' : ''} onClick={() => setLevel('all')}>All</button>
              <button className={level === 'warn' ? 'on' : ''} onClick={() => setLevel('warn')}>Warnings</button>
            </div>
            <button className="btn small ghost" onClick={() => useStore.setState({ logs: [] })}>Clear</button>
          </div>
          <div className="log-body mono" ref={ref}>
            {shown.map((l) => (
              <div key={l.id} className={`log-line log-${l.level}`}>
                <span className="dim">{fmtTime(l.time, true)}</span> <span className="log-src">{l.source === 'server' ? 'srv' : 'gui'}</span> {l.message}
              </div>
            ))}
            {shown.length === 0 && <div className="dim">No messages.</div>}
          </div>
        </>
      )}
    </div>
  );
}
