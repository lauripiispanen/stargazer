// three.js sky dome: observer at the centre of a unit celestial sphere. Stars and J2000 line work live in
// static GPU buffers; a per-frame J2000->horizon matrix uniform does the rotation (and refraction) on the GPU.
import * as THREE from 'three';
import type { GeoLocation, SolarBody } from '@stargazer/shared/api.ts';
import type { Catalog, SkyObject } from '../lib/catalog.ts';
import { bvToRgb } from '../lib/colors.ts';
import { starMagLimit } from '../lib/declutter.ts';
import { bodyRaDec, eqj2000ToWorldMatrix, illumination } from '../lib/astroAdapter.ts';
import { mountLimits } from '../lib/safety.ts';

import { useStore, displayTime, effectiveLocation } from '../state/store.ts';
import { STAR_VERT, STAR_FRAG, LINE_VERT, LINE_FRAG, SKY_VERT, SKY_FRAG, GROUND_FRAG, ZONE_FRAG } from './shaders.ts';
import { altAzGrid, altCircle, celestialEquator, ecliptic, equatorialGrid, horizonLine, polylinesToSegments } from './geometry.ts';
import { Projector, mulMat3, raDecToVec, refractWorld, worldToAltAz, type Mat3, type Vec3 } from './projection.ts';
import { drawOverlay, OverlayCache, pickAt } from './overlay.ts';

export interface BodyPos { body: SolarBody; ra: number; dec: number; mag: number; distanceAu: number; phase: number; world: Vec3; altAz: { az: number; alt: number } }

/** Everything a frame needs; shared with the overlay and picking. */
export interface FrameContext {
  time: number;
  loc: GeoLocation;
  M: Mat3; // J2000 -> world (no refraction)
  proj: Projector;
  sunAlt: number;
  bodies: BodyPos[];
  night: boolean;
  magLimit: number;
  /** J2000 (ra,dec) -> apparent world vector (refracted). */
  toWorld(ra: number, dec: number, out?: Vec3): Vec3;
}

function lineMaterial(shared: { uEqToWorld: { value: THREE.Matrix3 }; uNight: { value: number } }, color: number, opacity: number, refract: boolean) {
  return new THREE.ShaderMaterial({
    vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, transparent: true, depthTest: false, depthWrite: false,
    uniforms: { uEqToWorld: shared.uEqToWorld, uNight: shared.uNight, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uRefract: { value: refract ? 1 : 0 } },
  });
}

export class SkyRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
  readonly overlay: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private container: HTMLElement;
  private raf = 0;
  private disposed = false;
  private proj = new Projector();
  private uniforms = { uEqToWorld: { value: new THREE.Matrix3() }, uNight: { value: 0 } };
  private worldUniforms = { uEqToWorld: { value: new THREE.Matrix3() }, uNight: this.uniforms.uNight };
  private starMat: THREE.ShaderMaterial | null = null;
  private stars: THREE.Points | null = null;
  private skyMat: THREE.ShaderMaterial;
  private groundMat: THREE.ShaderMaterial;
  private ground: THREE.Mesh;
  private layers: Record<string, THREE.Object3D> = {};
  private catalog: Catalog | null = null;
  private cache = new OverlayCache();
  private M: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  private mTime = -1e15;
  private mLocKey = '';
  private bodies: BodyPos[] = [];
  private bodiesTime = -1e15;
  private bodiesLocKey = '';
  private w = 1; private h = 1; private dpr = 1;
  private altLimit = NaN;
  private limitCap: THREE.Mesh | null = null;
  private ro: ResizeObserver;
  /** last frame context (for picking) */
  frame: FrameContext | null = null;
  private fpsT = performance.now(); private fpsN = 0; fps = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.domElement.className = 'sky-gl';
    container.appendChild(this.renderer.domElement);
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'sky-overlay';
    container.appendChild(this.overlay);
    this.ctx2d = this.overlay.getContext('2d')!;
    this.camera.rotation.order = 'YXZ';

    // background sky dome
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false,
      uniforms: { uSunDir: { value: new THREE.Vector3(0, -1, 0) }, uSunAlt: { value: -30 }, uNight: this.uniforms.uNight, uMoonGlow: { value: 0 }, uMoonDir: { value: new THREE.Vector3(0, -1, 0) } },
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), this.skyMat);
    sky.renderOrder = -10; sky.frustumCulled = false;
    this.scene.add(sky);

    // ground: lower hemisphere drawn after everything sky-side (opaque, no depth test)
    this.groundMat = new THREE.ShaderMaterial({
      // transparent so it sorts into the same pass as stars/lines and renderOrder puts it on top
      vertexShader: SKY_VERT, fragmentShader: GROUND_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false, transparent: true,
      uniforms: { uSunAlt: { value: -30 }, uNight: this.uniforms.uNight },
    });
    this.ground = new THREE.Mesh(new THREE.SphereGeometry(5, 64, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), this.groundMat);
    this.ground.renderOrder = 50; this.ground.frustumCulled = false;
    this.scene.add(this.ground);

    // world-frame lines (identity matrix): alt-az grid + horizon
    this.addLines('altAzGrid', altAzGrid(), this.worldUniforms, 0x5fa8d3, 0.22, false, 5);
    this.addLines('horizon', horizonLine(), this.worldUniforms, 0x9fb7c9, 0.55, false, 60);
    this.addLines('eqGrid', equatorialGrid(), this.uniforms, 0x6f8fd8, 0.16, true, 5);
    this.addLines('equator', celestialEquator(), this.uniforms, 0x6f8fd8, 0.32, true, 5);
    this.addLines('ecliptic', ecliptic(), this.uniforms, 0xd8b26f, 0.22, true, 5);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  private addLines(name: string, positions: Float32Array, uniforms: typeof this.uniforms, color: number, opacity: number, refract: boolean, order: number) {
    this.layers[name]?.removeFromParent();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const l = new THREE.LineSegments(g, lineMaterial(uniforms, color, opacity, refract));
    l.frustumCulled = false; l.renderOrder = order;
    this.scene.add(l);
    this.layers[name] = l;
  }

  /** Faint 'no-go' cap above the mount's upper altitude limit (tube would hit the tripod). */
  private buildLimitZone(lim: number) {
    this.altLimit = lim;
    if (this.limitCap) { this.limitCap.geometry.dispose(); (this.limitCap.material as THREE.Material).dispose(); this.limitCap.removeFromParent(); this.limitCap = null; }
    if (!(lim < 90)) { this.layers.limitEdge?.removeFromParent(); return; }
    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: ZONE_FRAG, side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { uNight: this.uniforms.uNight, uColor: { value: new THREE.Color(0xff5a4a) }, uOpacity: { value: 0.07 } },
    });
    this.limitCap = new THREE.Mesh(new THREE.SphereGeometry(4, 64, 12, 0, Math.PI * 2, 0, ((90 - lim) * Math.PI) / 180), mat);
    this.limitCap.renderOrder = 30; this.limitCap.frustumCulled = false;
    this.scene.add(this.limitCap);
    this.addLines('limitEdge', altCircle(lim), this.worldUniforms, 0xff6a5a, 0.45, false, 31);
  }

  setCatalog(c: Catalog) {
    this.catalog = c;
    this.cache.setCatalog(c);
    // stars
    if (this.stars) { this.stars.geometry.dispose(); this.stars.removeFromParent(); }
    const n = c.stars.count;
    const pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3);
    const v: Vec3 = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      raDecToVec(c.stars.ra[i], c.stars.dec[i], v);
      pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2];
      mag[i] = c.stars.mag[i];
      const rgb = bvToRgb(c.stars.bv[i]);
      col[i * 3] = rgb[0]; col[i * 3 + 1] = rgb[1]; col[i * 3 + 2] = rgb[2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    this.starMat ??= new THREE.ShaderMaterial({
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { ...this.uniforms, uMagLimit: { value: 6.5 }, uSizeBase: { value: 2 }, uPixelRatio: { value: 1 }, uBrightness: { value: 1 } },
    });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false; this.stars.renderOrder = 20;
    this.scene.add(this.stars);
    // J2000 line work
    this.addLines('constellations', polylinesToSegments(c.constellations.flatMap((k) => k.lines), 1.5), this.uniforms, 0x7aa2d6, 0.42, true, 10);
    this.addLines('milkyWay', polylinesToSegments(c.milkyWay, 2, true), this.uniforms, 0xa7b4d8, 0.06, true, 4);
  }

  private resize() {
    const r = this.container.getBoundingClientRect();
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.w, this.h, false);
    this.renderer.domElement.style.width = `${this.w}px`; this.renderer.domElement.style.height = `${this.h}px`;
    this.overlay.width = Math.round(this.w * this.dpr); this.overlay.height = Math.round(this.h * this.dpr);
    this.overlay.style.width = `${this.w}px`; this.overlay.style.height = `${this.h}px`;
  }

  private updateBodies(loc: GeoLocation, t: number, locKey: string) {
    if (Math.abs(t - this.bodiesTime) < 1500 && locKey === this.bodiesLocKey) {
      for (const b of this.bodies) { this.toWorldInto(b.ra, b.dec, b.world); b.altAz = worldToAltAz(b.world); }
      return;
    }
    this.bodiesTime = t; this.bodiesLocKey = locKey;
    const names: SolarBody[] = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];
    this.bodies = names.map((body) => {
      const p = bodyRaDec(body, loc, t);
      const ill = body === 'Sun' ? { phase: 1, mag: -26.7 } : illumination(body, t);
      const world = this.toWorldInto(p.ra, p.dec, [0, 0, 0]);
      return { body, ra: p.ra, dec: p.dec, mag: Number.isFinite(p.mag) ? p.mag : ill.mag, distanceAu: p.distanceAu, phase: ill.phase, world, altAz: worldToAltAz(world) };
    });
  }

  private toWorldInto = (ra: number, dec: number, out: Vec3): Vec3 => {
    raDecToVec(ra, dec, out);
    mulMat3(this.M, out, out);
    return refractWorld(out);
  };

  private loop() {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    try { this.renderFrame(); } catch (e) { console.error('[sky] frame failed', e); }
  }

  cpuMs = 0;
  renderFrame() {
    const t0 = performance.now();
    this.renderFrameInner();
    this.cpuMs = this.cpuMs * 0.95 + (performance.now() - t0) * 0.05;
  }

  private renderFrameInner() {
    const st = useStore.getState();
    const t = displayTime();
    const loc = effectiveLocation(st);
    const locKey = `${loc.lat},${loc.lon}`;
    if (Math.abs(t - this.mTime) > 40 || locKey !== this.mLocKey) {
      this.M = eqj2000ToWorldMatrix(loc, t); this.mTime = t; this.mLocKey = locKey;
      const m = this.M;
      this.uniforms.uEqToWorld.value.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    }
    this.updateBodies(loc, t, locKey);
    const lim = mountLimits(st.mount).altDeg[1];
    if (lim !== this.altLimit) this.buildLimitZone(lim);

    // follow telescope
    let view = st.view;
    if (st.follow && st.mount?.pointing) {
      const p = st.mount.pointing;
      const wv = this.toWorldInto(p.ra, p.dec, [0, 0, 0]);
      const aa = worldToAltAz(wv);
      if (Math.abs(aa.az - view.az) > 1e-4 || Math.abs(aa.alt - view.alt) > 1e-4) {
        st.setView({ az: aa.az, alt: aa.alt });
        view = useStore.getState().view;
      }
    }

    this.camera.fov = view.fov;
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
    this.camera.rotation.set(view.alt * Math.PI / 180, -view.az * Math.PI / 180, 0, 'YXZ');
    this.camera.updateMatrixWorld();
    this.proj.update(this.w, this.h, view.az, view.alt, view.fov);

    const sun = this.bodies[0];
    const moon = this.bodies[1];
    const sunAlt = sun ? sun.altAz.alt : -30;
    const night = st.night ? 1 : 0;
    this.uniforms.uNight.value = night;
    const dayDim = 1 - smooth(-14, 2, sunAlt); // star visibility
    const magLimit = starMagLimit(view.fov) - (1 - dayDim) * 5.5 - (moon && moon.altAz.alt > 0 ? moon.phase * 0.8 : 0);
    if (this.starMat) {
      const u = this.starMat.uniforms;
      u.uMagLimit.value = magLimit;
      u.uSizeBase.value = 1.7 * Math.pow(60 / view.fov, 0.12);
      u.uPixelRatio.value = this.dpr;
      u.uBrightness.value = (0.25 + 0.75 * dayDim) * (st.night ? 0.85 : 1);
    }
    if (sun) (this.skyMat.uniforms.uSunDir.value as THREE.Vector3).set(sun.world[0], sun.world[1], sun.world[2]);
    this.skyMat.uniforms.uSunAlt.value = sunAlt;
    if (moon) {
      (this.skyMat.uniforms.uMoonDir.value as THREE.Vector3).set(moon.world[0], moon.world[1], moon.world[2]);
      this.skyMat.uniforms.uMoonGlow.value = moon.altAz.alt > 0 ? moon.phase * dayDim : 0;
    }
    this.groundMat.uniforms.uSunAlt.value = sunAlt;

    const L = st.layers;
    const vis = (k: string, on: boolean) => { if (this.layers[k]) this.layers[k].visible = on; };
    vis('constellations', L.constellations);
    vis('milkyWay', L.milkyWay);
    vis('altAzGrid', L.altAzGrid);
    vis('eqGrid', L.eqGrid); vis('equator', L.eqGrid); vis('ecliptic', L.eqGrid);
    this.ground.visible = L.ground;
    this.renderer.setClearColor(st.night ? 0x000000 : 0x02030a, 1);

    this.renderer.render(this.scene, this.camera);

    const toWorld = (ra: number, dec: number, out: Vec3 = [0, 0, 0]) => this.toWorldInto(ra, dec, out);
    this.frame = { time: t, loc, M: this.M, proj: this.proj, sunAlt, bodies: this.bodies, night: st.night, magLimit, toWorld };
    if (this.catalog) {
      const ctx = this.ctx2d;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      drawOverlay(ctx, this.frame, st, this.cache);
    }

    this.fpsN++;
    const now = performance.now();
    if (now - this.fpsT > 1000) { this.fps = (this.fpsN * 1000) / (now - this.fpsT); this.fpsN = 0; this.fpsT = now; }
  }

  pick(x: number, y: number): SkyObject | null {
    if (!this.frame || !this.catalog) return null;
    return pickAt(x, y, this.frame, useStore.getState(), this.cache);
  }

  /** Apparent world direction of a J2000 position at the current frame (for centring). */
  altAzOf(ra: number, dec: number): { az: number; alt: number } {
    return worldToAltAz(this.toWorldInto(ra, dec, [0, 0, 0]));
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
