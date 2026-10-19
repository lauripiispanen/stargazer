import type { ReactNode } from 'react';

export function Section({ title, children, right, className }: { title?: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`section ${className ?? ''}`}>
      {title != null && <header className="section-h"><h3>{title}</h3>{right}</header>}
      {children}
    </section>
  );
}

export function KV({ k, v, mono, title }: { k: ReactNode; v: ReactNode; mono?: boolean; title?: string }) {
  return (
    <div className="kv" title={title}>
      <span className="k">{k}</span>
      <span className={`v ${mono ? 'mono' : ''}`}>{v}</span>
    </div>
  );
}

export function Pill({ tone, children, title }: { tone: 'ok' | 'warn' | 'bad' | 'idle' | 'info'; children: ReactNode; title?: string }) {
  return <span className={`pill pill-${tone}`} title={title}><i />{children}</span>;
}

export function Toggle({ on, onChange, label, title, disabled }: { on: boolean; onChange: (v: boolean) => void; label: ReactNode; title?: string; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? 'disabled' : ''}`} title={title}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track"><span className="thumb" /></span>
      <span className="toggle-label">{label}</span>
    </label>
  );
}

/** Tiny inline SVG icons (no icon fonts / network). */
export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const p: Record<string, ReactNode> = {
    search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>,
    moon: <path d="M12.5 10.2A5.5 5.5 0 015.8 3.5a5.5 5.5 0 106.7 6.7z" />,
    eye: <><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
    layers: <><path d="M8 2l6 3-6 3-6-3z" /><path d="M2 8l6 3 6-3" /><path d="M2 11l6 3 6-3" /></>,
    clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>,
    target: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.5" /><path d="M8 0.5v3M8 12.5v3M0.5 8h3M12.5 8h3" /></>,
    x: <path d="M4 4l8 8M12 4l-8 8" />,
    chevronL: <path d="M10 3L5 8l5 5" />,
    chevronR: <path d="M6 3l5 5-5 5" />,
    up: <path d="M3 10l5-5 5 5" />, down: <path d="M3 6l5 5 5-5" />, left: <path d="M10 3L5 8l5 5" />, right: <path d="M6 3l5 5-5 5" />,
    plug: <><path d="M5 1.5v3M11 1.5v3M3.5 4.5h9v3a4.5 4.5 0 01-9 0z" /><path d="M8 12v2.5" /></>,
    star: <path d="M8 1.5l1.9 4.1 4.4.5-3.3 3 .9 4.4L8 11.3 4.1 13.5 5 9.1 1.7 6.1l4.4-.5z" />,
    list: <><path d="M5 4h9M5 8h9M5 12h9" /><circle cx="2" cy="4" r=".6" /><circle cx="2" cy="8" r=".6" /><circle cx="2" cy="12" r=".6" /></>,
    pin: <><path d="M8 14.5s-4.5-4.3-4.5-8a4.5 4.5 0 019 0c0 3.7-4.5 8-4.5 8z" /><circle cx="8" cy="6.5" r="1.6" /></>,
    gauge: <><path d="M2 11a6 6 0 1112 0" /><path d="M8 11l3-4" /></>,
    log: <><rect x="2.5" y="2" width="11" height="12" rx="1.5" /><path d="M5 5.5h6M5 8h6M5 10.5h4" /></>,
    gamepad: <><rect x="1.5" y="4.5" width="13" height="7" rx="3.5" /><path d="M4.5 8h3M6 6.5v3" /><circle cx="11" cy="7" r=".7" /><circle cx="12" cy="9" r=".7" /></>,
    crosshair: <><circle cx="8" cy="8" r="5" /><path d="M8 1v4M8 11v4M1 8h4M11 8h4" /></>,
    compass: <><circle cx="8" cy="8" r="6.5" /><path d="M8 3l2 5-2 5-2-5z" /></>,
    check: <path d="M3 8.5l3 3 7-7" />,
    trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" /></>,
    plus: <path d="M8 3v10M3 8h10" />,
    phone: <><rect x="4.5" y="1.5" width="7" height="13" rx="1.5" /><path d="M7 12.5h2" /></>,
    monitor: <><rect x="1.5" y="2.5" width="13" height="8.5" rx="1.2" /><path d="M6 14h4M8 11v3" /></>,
    gear: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>,
    bookmark: <path d="M4 1.8h8v12.4l-4-3-4 3z" />,
    bookmarkAdd: <><path d="M4 1.8h8v12.4l-4-3-4 3z" /><path d="M8 4.5v4M6 6.5h4" /></>,
    bookmarkOn: <path d="M4 1.8h8v12.4l-4-3-4 3z" fill="currentColor" />,
    arrowUp: <path d="M8 13V3M4 7l4-4 4 4" />,
    arrowDown: <path d="M8 3v10M4 9l4 4 4-4" />,
    edit: <><path d="M10.5 2.5l3 3L6 13H3v-3z" /><path d="M9 4l3 3" /></>,
    devices: <><rect x="1.5" y="3" width="9" height="7" rx="1" /><path d="M4 12.5h4" /><rect x="11" y="5.5" width="3.5" height="7" rx=".8" /></>,
    sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" /></>,
  };
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {p[name] ?? null}
    </svg>
  );
}
