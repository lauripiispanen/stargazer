// Global app state (zustand): server link + MountState mirror, logs, confirmations, catalog, sky view & UI.
import { create } from 'zustand';
import { STOP_FAILED_MESSAGE, type ClientMessage, type GeoLocation, type MountState, type ObservingListEntry, type ServerMessage } from '@stargazer/shared/api.ts';
import { findListEntry } from '@stargazer/shared/observingList.ts';
import { detectLayout, stripLayoutParams, writeStoredLayout, type Layout } from '../lib/layout.ts';
import { createMockTransport, createWsTransport, wsUrl, type LinkStatus, type Transport } from './transport.ts';
import type { Catalog, SkyObject } from '../lib/catalog.ts';
import { buildSearchIndex, type SearchIndex } from '../lib/search.ts';
import type { AlignStarSuggestion } from '../lib/astroAdapter.ts';
import { isStopFailure, mountHealth, mountLimits } from '../lib/safety.ts';
import type { Target } from '@stargazer/shared/api.ts';

export interface LogEntry { id: number; level: 'debug' | 'info' | 'warn' | 'error'; message: string; time: number; source: 'server' | 'client' }
export interface ConfirmRequest { id: number; message: string; request: ClientMessage }
export interface Toast { id: number; level: 'info' | 'warn' | 'error'; message: string; time: number }

export interface Layers {
  constellations: boolean; constellationNames: boolean; milkyWay: boolean; dsos: boolean; planets: boolean;
  starNames: boolean; altAzGrid: boolean; eqGrid: boolean; ground: boolean;
}
export type PanelTab = 'status' | 'tonight' | 'list' | 'align' | 'location';
export type RemoteTab = 'control' | 'search' | 'tonight' | 'list' | 'align' | 'settings';
export const REMOTE_TABS: RemoteTab[] = ['control', 'search', 'tonight', 'list', 'align', 'settings'];

export interface View { az: number; alt: number; fov: number }

/** Fallback when neither server nor browser knows a location (labelled clearly in the UI). */
export const DEFAULT_LOCATION: GeoLocation = { lat: 60.17, lon: 24.94, elevation: 20, source: 'manual', label: 'Default (Helsinki), set your location' };

const lsGet = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? { ...d as object, ...JSON.parse(v) } as T : d; } catch { return d; } };
const lsGetBool = (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, typeof v === 'boolean' ? (v ? '1' : '0') : JSON.stringify(v)); } catch { /* ignore */ } };

export interface AppState {
  // link
  transport: Transport | null;
  mock: boolean;
  link: LinkStatus;
  mount: MountState | null;
  /** serverTime - browser time at receipt (ms). */
  clockSkewMs: number | null;
  logs: LogEntry[];
  confirms: ConfirmRequest[];
  toasts: Toast[];
  // location used for rendering (server's when known)
  localLocation: GeoLocation | null;
  locationBootstrapped: boolean;
  // data
  catalog: Catalog | null;
  catalogError: string | null;
  searchIndex: SearchIndex | null;
  // sky
  view: View;
  timeOffsetMs: number;
  layers: Layers;
  follow: boolean;
  selected: SkyObject | null;
  hovered: SkyObject | null;
  alignSuggestions: AlignStarSuggestion[];
  // ui
  night: boolean;
  panel: PanelTab | null;
  padOpen: boolean;
  logOpen: boolean;
  slewRate: number;
  wizardStar: SkyObject | null;
  lastSlewPress: number;
  // safety
  pendingStop: boolean;
  stopFailure: string | null;
  lastCommandAt: number;
  /** set when the link/telescope connection dropped while the mount was moving or tracking */
  lostWhileMoving: { since: number; lastCommandAt: number; what: string } | null;
  pendingGoto: Target | null;
  keepClearAck: boolean;
  /** "Centred" was pressed: the server waits for the mount to settle, then records the point. */
  pendingCapture: { name: string; points: number; since: number; settleMs: number } | null;
  /** Shared observing list from the server (null until received: older servers don't have one). */
  observingList: ObservingListEntry[] | null;
  // layout
  layout: Layout;
  remoteTab: RemoteTab;

  start(mock: boolean): void;
  send(m: ClientMessage): boolean;
  log(level: LogEntry['level'], message: string): void;
  toast(level: Toast['level'], message: string): void;
  dismissToast(id: number): void;
  answerConfirm(id: number, yes: boolean): void;
  setCatalog(c: Catalog): void;
  setView(v: Partial<View>): void;
  setTimeOffset(ms: number): void;
  toggleLayer(k: keyof Layers): void;
  setFollow(f: boolean): void;
  select(o: SkyObject | null): void;
  setNight(n: boolean): void;
  setPanel(p: PanelTab | null): void;
  setLocation(l: GeoLocation, sendToServer?: boolean): void;
  setSlewRate(r: number): void;
  stopAll(): void;
  requestGoto(t: Target, opts?: { daytime?: boolean }): void;
  confirmGoto(yes: boolean, dontAskAgain?: boolean): void;
  alignCentred(t: Target): void;
  /** Add to the shared observing list (no-op with a toast if it's already there). */
  addToList(t: Target): void;
  setLayout(l: Layout): void;
  setRemoteTab(t: RemoteTab): void;
}

const PANEL_TO_REMOTE: Record<PanelTab, RemoteTab> = { status: 'control', tonight: 'tonight', list: 'list', align: 'align', location: 'settings' };

let logId = 1;
const MAX_LOGS = 600;

export const useStore = create<AppState>((set, get) => ({
  transport: null,
  mock: false,
  link: 'closed',
  mount: null,
  clockSkewMs: null,
  logs: [],
  confirms: [],
  toasts: [],
  localLocation: null,
  locationBootstrapped: false,
  catalog: null,
  catalogError: null,
  searchIndex: null,
  view: lsGet<View>('stargazer.view', { az: 180, alt: 35, fov: 80 }),
  timeOffsetMs: 0,
  layers: lsGet<Layers>('stargazer.layers', {
    constellations: true, constellationNames: true, milkyWay: true, dsos: true, planets: true, starNames: true,
    altAzGrid: false, eqGrid: false, ground: true,
  }),
  follow: false,
  selected: null,
  hovered: null,
  alignSuggestions: [],
  night: lsGetBool('stargazer.night', false),
  panel: (() => { try { return (localStorage.getItem('stargazer.panel') as PanelTab | null) ?? 'status'; } catch { return 'status'; } })(),
  padOpen: true,
  logOpen: false,
  slewRate: 6,
  wizardStar: null,
  lastSlewPress: 0,
  pendingStop: false,
  stopFailure: null,
  lastCommandAt: 0,
  lostWhileMoving: null,
  pendingGoto: null,
  keepClearAck: false,
  pendingCapture: null,
  observingList: null,
  layout: typeof window === 'undefined' ? 'desktop' : detectLayout(),
  remoteTab: 'control',

  start(mock) {
    if (get().transport) return;
    const handlers = {
      onMessage: (m: ServerMessage) => handleServerMessage(m),
      onStatus: (s: LinkStatus, info?: string) => {
        const prev = get().link;
        set({ link: s });
        if (s === 'open' && prev !== 'open') {
          get().log('info', mock ? 'Mock mode: using in-browser fake mount' : 'Connected to Stargazer server');
          if (get().pendingStop && get().transport?.send({ type: 'stop' })) { set({ pendingStop: false }); get().log('warn', 'Queued STOP sent after reconnect'); }
        }
        if (s === 'closed' && prev === 'open') {
          get().log('warn', `Lost connection to server${info ? `: ${info}` : ''}; reconnecting…`);
          const m = get().mount;
          if (m && m.connection === 'connected' && (m.slew !== 'idle' || m.tracking)) {
            set({ lostWhileMoving: { since: Date.now(), lastCommandAt: get().lastCommandAt, what: m.slew !== 'idle' ? `slewing (${m.slew})` : 'tracking' } });
          }
        }
      },
    };
    const transport = mock ? createMockTransport(handlers) : createWsTransport(wsUrl(), handlers);
    set({ transport, mock });
  },

  send(m) {
    const t = get().transport;
    const ok = !!t && t.send(m);
    if (ok) set({ lastCommandAt: Date.now() });
    else if (m.type !== 'move' && m.type !== 'stopAxis') get().toast('error', 'Not connected to the Stargazer server');
    return ok;
  },

  log(level, message) {
    set((s) => ({ logs: [...s.logs.slice(-MAX_LOGS + 1), { id: logId++, level, message, time: Date.now(), source: 'client' }] }));
  },
  toast(level, message) {
    // the server reports some safety alerts both as a log line and as an error: show them once
    if (get().toasts.some((t) => t.message === message && Date.now() - t.time < 3000)) return;
    const id = logId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, level, message, time: Date.now() }] }));
    setTimeout(() => get().dismissToast(id), level === 'error' ? 7000 : 4000);
  },
  dismissToast(id) { set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })); },

  answerConfirm(id, yes) {
    const c = get().confirms.find((x) => x.id === id);
    set((s) => ({ confirms: s.confirms.filter((x) => x.id !== id) }));
    if (c && yes) get().send({ ...c.request, force: true } as ClientMessage);
  },

  setCatalog(c) {
    const objs: SkyObject[] = [
      ...c.bodies, ...c.dsos, ...c.namedStars,
      ...c.constellations.map((k): SkyObject => ({ key: `con:${k.id}`, kind: 'constellation', name: k.name, id: k.id, aliases: [k.id], ra: k.label[0], dec: k.label[1], typeLabel: 'Constellation' })),
    ];
    set({ catalog: c, searchIndex: buildSearchIndex(objs) });
  },

  setView(v) {
    const cur = get().view;
    const fov = Math.min(120, Math.max(0.5, v.fov ?? cur.fov));
    const alt = Math.min(90, Math.max(-30, v.alt ?? cur.alt));
    const az = (((v.az ?? cur.az) % 360) + 360) % 360;
    set({ view: { az, alt, fov } });
    saveViewSoon();
  },
  setTimeOffset(ms) { set({ timeOffsetMs: ms }); },
  toggleLayer(k) { const layers = { ...get().layers, [k]: !get().layers[k] }; set({ layers }); lsSet('stargazer.layers', layers); },
  setFollow(f) { set({ follow: f }); },
  select(o) { set({ selected: o }); },
  setNight(n) { set({ night: n }); lsSet('stargazer.night', n); },
  setPanel(p) {
    // on the phone remote, desktop panel links (e.g. "Set location", "Finish") open the matching tab
    if (get().layout === 'remote' && p) { set({ remoteTab: PANEL_TO_REMOTE[p] }); return; }
    set({ panel: p }); try { if (p) localStorage.setItem('stargazer.panel', p); } catch { /* ignore */ }
  },
  setLocation(l, sendToServer = true) {
    set({ localLocation: l, locationBootstrapped: true });
    if (sendToServer) get().send({ type: 'setLocation', location: l });
  },
  setSlewRate(r) { set({ slewRate: Math.min(9, Math.max(1, Math.round(r))) }); },
  stopAll() {
    const t = get().transport;
    // stop is idempotent: send it even if we think nothing is moving
    if (t && t.send({ type: 'stop' })) { set({ lastCommandAt: Date.now(), pendingStop: false }); get().log('warn', 'STOP sent'); return; }
    set({ pendingStop: true });
    get().toast('error', 'STOP queued: it will be sent as soon as the server reconnects. If the telescope is moving, unplug its power now.');
    get().log('error', 'STOP queued (no server connection)');
  },
  requestGoto(t, opts = {}) {
    // SAFETY.md §6: "keep clear" notice before any GoTo: dismissible per session at night, always in daytime
    if (get().keepClearAck && !opts.daytime) { get().send({ type: 'goto', target: t }); return; }
    set({ pendingGoto: t });
  },
  confirmGoto(yes, dontAskAgain) {
    const t = get().pendingGoto;
    set({ pendingGoto: null, ...(dontAskAgain ? { keepClearAck: true } : {}) });
    if (yes && t) get().send({ type: 'goto', target: t });
  },
  addToList(t) {
    const list = get().observingList;
    if (list === null) { get().toast('warn', 'This server has no observing list (update Stargazer on the laptop)'); return; }
    const dup = findListEntry(list, t);
    if (dup) { get().toast('info', `${dup.name} is already on your list`); return; }
    if (get().send({ type: 'listAdd', target: t })) get().toast('info', `${t.name} added to your list`);
  },
  setLayout(l) {
    writeStoredLayout(l);
    try { window.history.replaceState(null, '', stripLayoutParams(window.location.href)); } catch { /* ignore */ }
    set({ layout: l });
  },
  setRemoteTab(t) { set({ remoteTab: t }); },
  alignCentred(t) {
    const m = get().mount;
    if (!m || get().pendingCapture) return;
    if (get().send({ type: 'alignAddPoint', target: t })) {
      const pc = { name: t.name, points: m.alignment.points.length, since: Date.now(), settleMs: mountLimits(m).settleMs };
      set({ pendingCapture: pc });
      // safety net: never leave the wizard stuck in "settling"
      setTimeout(() => { if (get().pendingCapture === pc) set({ pendingCapture: null }); }, pc.settleMs + 8000);
    }
  },
}));

let viewTimer: ReturnType<typeof setTimeout> | null = null;
function saveViewSoon() {
  if (viewTimer) return;
  viewTimer = setTimeout(() => { viewTimer = null; lsSet('stargazer.view', useStore.getState().view); }, 1000);
}

function handleServerMessage(m: ServerMessage) {
  const st = useStore.getState();
  switch (m.type) {
    case 'state': {
      const prev = st.mount;
      const patch: Partial<AppState> = { mount: m.state, clockSkewMs: m.state.serverTime - Date.now() };
      if (prev && prev.connection === 'connected' && m.state.connection !== 'connected' && (prev.slew !== 'idle' || prev.tracking)) {
        patch.lostWhileMoving = { since: Date.now(), lastCommandAt: st.lastCommandAt, what: prev.slew !== 'idle' ? `slewing (${prev.slew})` : 'tracking' };
      }
      if (m.state.connection === 'connected' && st.lostWhileMoving && st.link === 'open') patch.lostWhileMoving = null;
      // structured stop-failure flag: raise the modal on the rising edge (the user can dismiss it)
      if (mountHealth(m.state)?.stopFailed && !mountHealth(prev)?.stopFailed && !st.stopFailure) patch.stopFailure = STOP_FAILED_MESSAGE;
      const pc = st.pendingCapture;
      if (pc && m.state.alignment.points.length > pc.points) {
        patch.pendingCapture = null;
        patch.wizardStar = null; // wizard moves on to the next star
        const a = m.state.alignment;
        st.toast('info', `${pc.name} added (${a.points.length} star${a.points.length > 1 ? 's' : ''}${a.rmsArcmin != null ? `, RMS ${a.rmsArcmin.toFixed(1)}′` : ''})`);
      }
      useStore.setState(patch);
      if (prev && prev.connection !== m.state.connection && m.state.connection === 'error' && m.state.error) st.toast('error', m.state.error);
      break;
    }
    case 'log':
      useStore.setState((s) => ({ logs: [...s.logs.slice(-MAX_LOGS + 1), { id: logId++, level: m.level, message: m.message, time: m.time, source: 'server' }] }));
      if (m.level === 'error') st.toast('error', m.message);
      if (m.level === 'error' && isStopFailure(m.message)) useStore.setState({ stopFailure: m.message });
      break;
    case 'error':
      if (isStopFailure(m.message) || (m.requestType === 'stop')) useStore.setState({ stopFailure: m.message });
      if (m.requestType === 'alignAddPoint') useStore.setState({ pendingCapture: null });
      st.toast('error', m.message);
      st.log('error', `${m.requestType ? `[${m.requestType}] ` : ''}${m.message}`);
      break;
    case 'confirm':
      useStore.setState((s) => ({ confirms: [...s.confirms, { id: logId++, message: m.message, request: m.request }] }));
      break;
    case 'list':
      if (Array.isArray(m.entries)) useStore.setState({ observingList: m.entries });
      break;
  }
}

/** Location used for all sky computations. */
export function effectiveLocation(s: Pick<AppState, 'mount' | 'localLocation'>): GeoLocation {
  return s.mount?.location ?? s.localLocation ?? DEFAULT_LOCATION;
}
export const useLocation = () => useStore((s) => s.mount?.location ?? s.localLocation ?? DEFAULT_LOCATION);

/** Displayed sky time (ms). */
export function displayTime(): number { return Date.now() + useStore.getState().timeOffsetMs; }
