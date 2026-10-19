import { useEffect, useReducer, useRef } from 'react';
import { useStore } from '../state/store.ts';
import { padPress, padRelease, subscribeMotion, heldDirs } from '../state/slewController.ts';
import type { Dir } from '../lib/slewInput.ts';
import { Icon } from './ui.tsx';

function PadButton({ dir, disabled }: { dir: Dir; disabled: boolean }) {
  const pressed = useRef(false);
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeMotion(force), []);
  const down = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    // no pointer capture on purpose: sliding off the button (pointerleave) must stop the axis
    pressed.current = true; padPress(dir);
  };
  const up = () => { if (pressed.current) { pressed.current = false; padRelease(dir); } };
  // safety net: release if unmounted while held
  useEffect(() => () => { if (pressed.current) padRelease(dir); }, [dir]);
  const active = heldDirs().has(dir);
  return (
    <button
      className={`pad-btn pad-${dir} ${active ? 'active' : ''}`}
      disabled={disabled}
      onPointerDown={down} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} onLostPointerCapture={up}
      onBlur={up} onContextMenu={(e) => e.preventDefault()}
      aria-label={`Slew ${dir}`} title={`Slew ${dir} (hold) · ${dir === 'up' ? '↑/W' : dir === 'down' ? '↓/S' : dir === 'left' ? '←/A' : '→/D'}`}
    >
      <Icon name={dir} size={22} />
    </button>
  );
}

export function SlewPad() {
  const rate = useStore((s) => s.slewRate);
  const setRate = useStore((s) => s.setSlewRate);
  const mount = useStore((s) => s.mount);
  const link = useStore((s) => s.link);
  const open = useStore((s) => s.padOpen);
  const disabled = !(link === 'open' && mount?.connection === 'connected');
  if (!open) {
    return <button className="pad-collapsed glass" onClick={() => useStore.setState({ padOpen: true })} title="Show slew pad"><Icon name="gamepad" /> Slew pad</button>;
  }
  return (
    <div className="slewpad glass" onContextMenu={(e) => e.preventDefault()}>
      <div className="slewpad-h">
        <span>Slew</span>
        <span className="dim small">{disabled ? 'not connected' : 'hold to move'}</span>
        <button className="icon-btn" onClick={() => useStore.setState({ padOpen: false })} aria-label="Hide slew pad"><Icon name="x" size={14} /></button>
      </div>
      <div className="pad-grid">
        <span />
        <PadButton dir="up" disabled={disabled} />
        <span />
        <PadButton dir="left" disabled={disabled} />
        <div className="pad-center mono" title="Current rate">{rate}</div>
        <PadButton dir="right" disabled={disabled} />
        <span />
        <PadButton dir="down" disabled={disabled} />
        <span />
      </div>
      <div className="rates" role="radiogroup" aria-label="Slew rate">
        {Array.from({ length: 9 }, (_, i) => i + 1).map((r) => (
          <button key={r} role="radio" aria-checked={r === rate} className={`rate ${r === rate ? 'on' : ''} ${r >= 7 ? 'fast' : ''}`} onClick={() => setRate(r)} title={`Rate ${r} (key ${r})`}>{r}</button>
        ))}
      </div>
      <div className="dim small pad-hint">Keys: arrows/WASD · 1–9 rate · Space/Esc stop · gamepad stick</div>
    </div>
  );
}

/** Big STOP: visible whenever a telescope is connected (and when a stop might be needed). */
export function StopButton() {
  const mount = useStore((s) => s.mount);
  const pending = useStore((s) => s.pendingStop);
  const lost = useStore((s) => s.lostWhileMoving);
  const stopAll = useStore((s) => s.stopAll);
  const visible = mount?.connection === 'connected' || mount?.connection === 'connecting' || pending || !!lost;
  if (!visible) return null;
  const moving = !!mount && (mount.slew !== 'idle' || mount.tracking);
  return (
    <button className={`stop-btn ${moving ? 'moving' : ''}`} onClick={() => stopAll()} title="Stop all motion and tracking (Space / Esc)">
      <span className="stop-octagon">STOP</span>
      <span className="stop-sub">{pending ? 'queued: reconnecting…' : 'Space / Esc'}</span>
    </button>
  );
}
