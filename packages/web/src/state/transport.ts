// Transport to the server: an auto-reconnecting WebSocket on /ws, or the in-browser mock mount.
import type { ClientMessage, ServerMessage } from '@stargazer/shared/api.ts';
import { MockMount } from './mockMount.ts';

export type LinkStatus = 'connecting' | 'open' | 'closed';

export interface TransportHandlers {
  onMessage(m: ServerMessage): void;
  onStatus(s: LinkStatus, info?: string): void;
}

export interface Transport {
  send(m: ClientMessage): boolean;
  close(): void;
  readonly kind: 'ws' | 'mock';
}

/** Exponential backoff schedule for reconnects (ms). Exported for tests. */
export function backoffMs(attempt: number): number {
  return Math.min(5000, 400 * Math.pow(1.6, Math.max(0, attempt)));
}

export function wsUrl(loc: Location = window.location): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/ws`;
}

export function createWsTransport(url: string, h: TransportHandlers): Transport {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    h.onStatus('connecting');
    try { ws = new WebSocket(url); } catch (e) { schedule(String(e)); return; }
    ws.onopen = () => { attempt = 0; h.onStatus('open'); };
    ws.onmessage = (ev) => {
      try { h.onMessage(JSON.parse(String(ev.data)) as ServerMessage); } catch (e) { console.warn('bad WS message', e); }
    };
    ws.onclose = () => { ws = null; schedule(); };
    ws.onerror = () => { /* onclose follows */ };
  };
  const schedule = (info?: string) => {
    if (closed) return;
    h.onStatus('closed', info);
    const d = backoffMs(attempt++);
    timer = setTimeout(open, d);
  };
  // reconnect promptly when the tab comes back / network returns
  const kick = () => { if (!ws && !closed) { if (timer) clearTimeout(timer); attempt = 0; open(); } };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });

  open();
  return {
    kind: 'ws',
    send(m) {
      if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(m)); return true; }
      return false;
    },
    close() { closed = true; if (timer) clearTimeout(timer); ws?.close(); window.removeEventListener('online', kick); },
  };
}

export function createMockTransport(h: TransportHandlers): Transport {
  const mock = new MockMount((m) => h.onMessage(m));
  setTimeout(() => h.onStatus('open'), 50);
  return {
    kind: 'mock',
    send(m) { mock.handle(m); return true; },
    close() { mock.dispose(); },
  };
}
