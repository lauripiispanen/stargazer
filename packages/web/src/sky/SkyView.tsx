import { useEffect, useRef } from 'react';
import { useStore } from '../state/store.ts';
import { SkyRenderer } from './SkyRenderer.ts';
import { worldToAltAz } from './projection.ts';
import { cancelViewAnimation, centerOnAltAz, setActiveSky } from './viewControl.ts';

export function SkyView() {
  const ref = useRef<HTMLDivElement>(null);
  const catalog = useStore((s) => s.catalog);
  const rendererRef = useRef<SkyRenderer | null>(null);

  useEffect(() => {
    const el = ref.current!;
    let r: SkyRenderer;
    try {
      r = new SkyRenderer(el);
    } catch (e) {
      el.innerHTML = '<div class="sky-error">WebGL is not available in this browser, so the sky map cannot be shown. Telescope controls still work.</div>';
      console.error(e);
      return;
    }
    rendererRef.current = r; setActiveSky(r);
    const cat = useStore.getState().catalog;
    if (cat) r.setCatalog(cat);

    // ---- pointer interaction ----
    const pointers = new Map<number, { x: number; y: number }>();
    let downAt = { x: 0, y: 0, t: 0 }, moved = false, pinchDist = 0;
    const local = (e: PointerEvent | WheelEvent | MouseEvent) => { const b = el.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 1) { const p = local(e); downAt = { ...p, t: performance.now() }; moved = false; }
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchDist = Math.hypot(a.x - b.x, a.y - b.y); moved = true; }
      cancelViewAnimation();
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      pointers.set(e.pointerId, p);
      const st = useStore.getState();
      if (pointers.size === 1) {
        if (!moved && Math.hypot(p.x - downAt.x, p.y - downAt.y) < 5) return;
        if (!moved) { moved = true; el.classList.add('dragging'); }
        const h = el.clientHeight || 1;
        const dpp = st.view.fov / h;
        const c = Math.max(0.25, Math.cos((st.view.alt * Math.PI) / 180));
        st.setView({ az: st.view.az - ((p.x - prev.x) * dpp) / c, alt: st.view.alt + (p.y - prev.y) * dpp });
        if (st.follow) st.setFollow(false);
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0 && d > 0) st.setView({ fov: st.view.fov * (pinchDist / d) });
        pinchDist = d;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      el.classList.remove('dragging');
      if (pointers.size === 0 && !moved && performance.now() - downAt.t < 600) {
        const p = local(e);
        const o = r.pick(p.x, p.y);
        useStore.getState().select(o);
      }
      if (pointers.size < 2) pinchDist = 0;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const st = useStore.getState();
      const k = Math.exp((e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0015);
      const newFov = Math.min(120, Math.max(0.5, st.view.fov * k));
      // zoom toward the cursor: keep the sky point under the pointer fixed (approximately)
      const fc = r.frame;
      if (fc) {
        const p = local(e);
        const before = worldToAltAz(fc.proj.unproject(p.x, p.y));
        const t = 1 - newFov / st.view.fov;
        const dAz = ((before.az - st.view.az + 540) % 360) - 180;
        st.setView({ fov: newFov, az: st.view.az + dAz * t, alt: st.view.alt + (before.alt - st.view.alt) * t });
      } else st.setView({ fov: newFov });
      cancelViewAnimation();
    };
    const onDbl = (e: MouseEvent) => {
      const fc = r.frame; if (!fc) return;
      const p = local(e);
      const aa = worldToAltAz(fc.proj.unproject(p.x, p.y));
      centerOnAltAz(aa.az, aa.alt, Math.max(0.5, useStore.getState().view.fov / 2));
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDbl);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDbl);
      r.dispose();
      setActiveSky(null);
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => { if (catalog && rendererRef.current) rendererRef.current.setCatalog(catalog); }, [catalog]);

  return <div ref={ref} className="sky" aria-label="Sky map" />;
}
