// View control for the sky map without importing the renderer (three.js), so panels shared with the phone
// remote don't pull the 3D map into its bundle. SkyView registers the live renderer here.
import { useStore } from '../state/store.ts';
import type { SkyObject } from '../lib/catalog.ts';
import type { SolarBody } from '@stargazer/shared/api.ts';

/** The bits of SkyRenderer that view control needs. */
export interface ActiveSky {
  frame: { bodies: { body: SolarBody; altAz: { az: number; alt: number } }[] } | null;
  altAzOf(ra: number, dec: number): { az: number; alt: number };
  fps: number;
  cpuMs: number;
}

let active: ActiveSky | null = null;
export function setActiveSky(r: ActiveSky | null) { active = r; }
export function activeSky(): ActiveSky | null { return active; }

/**
 * Centre the view on an object (and optionally zoom), select it, stop following the telescope.
 * Without a sky map (phone remote) it only selects.
 */
export function centerOn(o: SkyObject, opts: { fov?: number; select?: boolean } = {}) {
  const st = useStore.getState();
  let aa: { az: number; alt: number } | null = null;
  const fc = active?.frame;
  if (o.kind === 'body' && o.body && fc) {
    const b = fc.bodies.find((x) => x.body === o.body);
    if (b) aa = b.altAz;
  }
  if (!aa && active) aa = active.altAzOf(o.ra, o.dec);
  if (aa) {
    let fov = opts.fov;
    if (fov === undefined) {
      const size = o.sizeArcmin?.[0] ? o.sizeArcmin[0] / 60 : 0;
      fov = o.kind === 'constellation' ? 50 : size ? Math.min(st.view.fov, Math.max(1.5, size * 4)) : Math.min(st.view.fov, o.kind === 'body' ? 10 : 30);
    }
    st.setFollow(false);
    animateView(aa.az, Math.max(-20, aa.alt), fov);
  }
  if (opts.select !== false && o.kind !== 'constellation') st.select(o);
}

export function centerOnAltAz(az: number, alt: number, fov?: number) {
  useStore.getState().setFollow(false);
  animateView(az, alt, fov ?? useStore.getState().view.fov);
}

let anim = 0;
export function cancelViewAnimation() { cancelAnimationFrame(anim); }

function animateView(az: number, alt: number, fov: number) {
  const st = useStore.getState();
  const from = { ...st.view };
  let dAz = ((az - from.az + 540) % 360) - 180;
  const t0 = performance.now(), dur = 650;
  cancelAnimationFrame(anim);
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    useStore.getState().setView({
      az: from.az + dAz * e, alt: from.alt + (alt - from.alt) * e,
      fov: Math.exp(Math.log(from.fov) + (Math.log(fov) - Math.log(from.fov)) * e),
    });
    if (k < 1) anim = requestAnimationFrame(step);
  };
  dAz = Number.isFinite(dAz) ? dAz : 0;
  step();
}

export function rendererFps(): number { return active?.fps ?? 0; }
export function rendererCpuMs(): number { return active?.cpuMs ?? 0; }
