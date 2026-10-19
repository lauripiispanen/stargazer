// Which UI to show: the full desktop sky map or the phone remote. Pure except the localStorage/URL helpers.
export type Layout = 'desktop' | 'remote';

export interface LayoutEnv {
  /** window.location.search */
  search: string;
  /** Saved choice from the in-app layout toggle, if any. */
  stored: Layout | null;
  width: number;
  height: number;
  /** matchMedia('(pointer: coarse)') */
  coarse: boolean;
  /** matchMedia('(hover: hover)') */
  hover: boolean;
}

/** Narrower than this always gets the remote (phones, split-screen). */
export const REMOTE_MAX_WIDTH = 700;
/** Touch-only screens whose short side is below this get the remote (phones in landscape). Tablets keep the map. */
export const REMOTE_MAX_TOUCH_SIDE = 600;

/**
 * Priority: `?remote` / `?desktop` in the URL, then the saved toggle, then the device: narrow screens, or
 * small touch-only screens, get the remote.
 */
export function chooseLayout(env: LayoutEnv): Layout {
  const q = new URLSearchParams(env.search);
  if (q.has('remote')) return 'remote';
  if (q.has('desktop')) return 'desktop';
  if (env.stored) return env.stored;
  if (env.width < REMOTE_MAX_WIDTH) return 'remote';
  if (env.coarse && !env.hover && Math.min(env.width, env.height) < REMOTE_MAX_TOUCH_SIDE) return 'remote';
  return 'desktop';
}

const KEY = 'stargazer.layout';

export function readStoredLayout(): Layout | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'remote' || v === 'desktop' ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredLayout(l: Layout): void {
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
}

/** The URL without ?remote / ?desktop (so a toggle isn't overridden by the address bar on reload). */
export function stripLayoutParams(href: string): string {
  const u = new URL(href);
  u.searchParams.delete('remote');
  u.searchParams.delete('desktop');
  return u.pathname + (u.searchParams.toString() ? `?${u.searchParams.toString().replace(/=(&|$)/g, '$1')}` : '') + u.hash;
}

export function detectLayout(): Layout {
  const mq = (q: string) => { try { return window.matchMedia(q).matches; } catch { return false; } };
  return chooseLayout({
    search: window.location.search,
    stored: readStoredLayout(),
    width: window.innerWidth,
    height: window.innerHeight,
    coarse: mq('(pointer: coarse)'),
    hover: mq('(hover: hover)'),
  });
}
