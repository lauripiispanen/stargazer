// Touch slew pad for the phone: press and hold to move. Uses the shared slew controller, so the same dead-man
// heartbeat applies (move re-sent every 200 ms; released on touchend/cancel, blur, page hide or link loss).
import { useEffect, useReducer, useRef } from 'react';
import { useStore } from '../state/store.ts';
import { heldDirs, padPress, padRelease, subscribeMotion } from '../state/slewController.ts';
import type { Dir } from '../lib/slewInput.ts';
import { Icon } from '../panels/ui.tsx';

const buzz = (ms: number) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };

function PadKey({ dir, disabled }: { dir: Dir; disabled: boolean }) {
  const pressed = useRef(false);
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeMotion(force), []);
  const down = (e: React.PointerEvent) => {
    if (disabled || pressed.current) return;
    e.preventDefault();
    pressed.current = true;
    buzz(12);
    padPress(dir);
  };
  const up = () => {
    if (!pressed.current) return;
    pressed.current = false;
    buzz(6);
    padRelease(dir);
  };
  useEffect(() => () => { if (pressed.current) padRelease(dir); }, [dir]);
  const active = heldDirs().has(dir);
  const label = dir === 'up' ? 'Up' : dir === 'down' ? 'Down' : dir === 'left' ? 'Left' : 'Right';
  return (
    <button
      className={`r-pad-key r-pad-${dir} ${active ? 'active' : ''}`} disabled={disabled} data-dir={dir}
      onPointerDown={down} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onPointerLeave={(e) => { if (e.pointerType === 'mouse') up(); }}
      onContextMenu={(e) => e.preventDefault()} aria-label={`Slew ${dir} (hold)`}
    >
      <Icon name={dir} size={30} />
      <span className="r-pad-lbl">{label}</span>
    </button>
  );
}

const PRESETS: { rate: number; label: string }[] = [{ rate: 3, label: 'Centre' }, { rate: 6, label: 'Find' }, { rate: 9, label: 'Slew' }];

export function RemotePad({ compact }: { compact?: boolean }) {
  const rate = useStore((s) => s.slewRate);
  const setRate = useStore((s) => s.setSlewRate);
  const mount = useStore((s) => s.mount);
  const link = useStore((s) => s.link);
  const disabled = !(link === 'open' && mount?.connection === 'connected');
  return (
    <div className={`r-pad ${compact ? 'compact' : ''}`} onContextMenu={(e) => e.preventDefault()}>
      <div className="r-pad-grid">
        <span />
        <PadKey dir="up" disabled={disabled} />
        <span />
        <PadKey dir="left" disabled={disabled} />
        <div className="r-pad-center mono" aria-label={`Rate ${rate}`}>{rate}<small>rate</small></div>
        <PadKey dir="right" disabled={disabled} />
        <span />
        <PadKey dir="down" disabled={disabled} />
        <span />
      </div>
      <div className="r-rate">
        <button className="r-rate-step" onClick={() => setRate(rate - 1)} disabled={rate <= 1} aria-label="Slower">−</button>
        <div className="r-rate-presets" role="radiogroup" aria-label="Slew rate">
          {PRESETS.map((p) => (
            <button key={p.rate} role="radio" aria-checked={rate === p.rate} className={`r-rate-preset ${rate === p.rate ? 'on' : ''} ${p.rate >= 7 ? 'fast' : ''}`} onClick={() => setRate(p.rate)}>
              <b className="mono">{p.rate}</b> {p.label}
            </button>
          ))}
        </div>
        <button className="r-rate-step" onClick={() => setRate(rate + 1)} disabled={rate >= 9} aria-label="Faster">+</button>
      </div>
      {disabled && <div className="dim small r-pad-note">Connect the telescope to slew.</div>}
    </div>
  );
}
