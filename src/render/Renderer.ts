// Renderer: floating origin + depth partitioning (build plan §4.4).
//
// Floating origin: the focus body is pinned to the scene origin every frame, so
// whatever you are looking at keeps full f32 precision and distant bodies fall
// back gracefully. This is what kills jitter from the Sun out to Neptune.
//
// Depth: one scene unit = one metre, so the full range spans ~1e13 — no single
// depth buffer survives that. The plan calls for multi-pass depth partitioning,
// but WebGPURenderer clears colour on every stacked render() call regardless of
// autoClear, so stacking passes on the default framebuffer blanks all but the
// last. Proper partitioning needs render-target compositing, which is the P5
// RenderPipeline integration.
//
// ponytail: for P1 we instead bracket near/far adaptively around the bodies in
// view each frame and render in a single pass. With the floating origin pinning
// the focus at the origin this keeps depth precision high on whatever you are
// looking at (no z-fighting at a close moon pass) and renders reliably.
// Upgrade to render-target depth partitioning when compositing lands in P5.

import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FlyControls } from 'three/addons/controls/FlyControls.js';
import type { Body } from '../core/types';
import { sampleOrbitPathRV } from '../core/orbital/elements';
import { eqjToEcl } from '../core/frames';
import { StarField } from './StarField';

const ORBIT_SEGMENTS = 256;
const RING_SEGMENTS = 256;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const texLoader = new THREE.TextureLoader();

/** Load an equirectangular texture from public/textures, sRGB. Async fill. */
function loadTex(file: string): THREE.Texture {
  const t = texLoader.load(`textures/${file}`);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
const bodyTexture = (id: string): THREE.Texture => loadTex(`${id.toLowerCase()}.jpg`);

/** Mesh +Y aligned to a body's spin pole (IAU RA/Dec in deg, ICRF equatorial). */
function poleQuat(poleRA: number, poleDec: number): THREE.Quaternion {
  const ra = (poleRA * Math.PI) / 180, dec = (poleDec * Math.PI) / 180;
  const eq = new Float64Array([Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)]);
  eqjToEcl(eq, eq); // ephemeris frame is ecliptic-J2000, so the pole must be too
  const up = new THREE.Vector3(eq[0], eq[1], eq[2]).normalize();
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
}

/** Ring lying in the XZ plane (normal +Y = local pole), radii in planet-radii,
 *  v: 0 inner -> 1 outer so a radial alpha texture maps cleanly. */
function buildRing(innerR: number, outerR: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const a = (i / RING_SEGMENTS) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    pos.push(innerR * c, 0, innerR * s, outerR * c, 0, outerR * s);
    uv.push(i / RING_SEGMENTS, 0, i / RING_SEGMENTS, 1);
    if (i < RING_SEGMENTS) { const b = i * 2; idx.push(b, b + 1, b + 3, b, b + 3, b + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** 1-D radial alpha strip approximating Saturn's C/B/Cassini/A structure. */
function ringTexture(): THREE.CanvasTexture {
  // Opacity by fractional radius v (0 inner -> 1 outer): faint C ring, dense B
  // ring, the dark Cassini division, then the A ring with the thin Encke gap.
  const density = (v: number): number => {
    if (v < 0.20) return 0.35;            // C ring
    if (v < 0.55) return 0.95;            // B ring (brightest)
    if (v < 0.62) return 0.10;            // Cassini division
    if (v > 0.92 && v < 0.94) return 0.2; // Encke gap
    if (v < 0.98) return 0.75;            // A ring
    return 0.4;
  };
  const h = 256, cv = document.createElement('canvas');
  cv.width = 1; cv.height = h;
  const ctx = cv.getContext('2d')!;
  for (let y = 0; y < h; y++) {
    const v = y / h;
    const edge = Math.min(1, v / 0.03, (1 - v) / 0.03); // soft inner/outer rims
    const grain = 0.93 + 0.07 * Math.sin(v * 30); // faint fine structure
    const a = density(v) * edge * grain;
    ctx.fillStyle = `rgba(222,205,168,${a})`;
    ctx.fillRect(0, y, 1, 1);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

export interface RenderBody {
  def: Body;
  mesh: THREE.Mesh;
  pole: THREE.Quaternion; // tilt: local +Y -> ecliptic spin pole
}

export class Renderer {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly bodies: RenderBody[] = [];
  private sunLight: THREE.PointLight;
  private unit = new THREE.SphereGeometry(1, 64, 32);
  private sunIdx = 0;
  private orbits: { idx: number; centerIdx: number; mu: number; line: THREE.Line; scratch: Float64Array }[] = [];
  private fly: FlyControls | null = null;
  private post: THREE.PostProcessing | null = null;
  private spin = new THREE.Quaternion(); // scratch, reused per body per frame
  private lastUpdate = performance.now();
  showOrbits = true;
  starField: StarField | null = null;
  isWebGPU = false;

  constructor(container: HTMLElement) {
    // ?webgl forces the WebGL2 backend (used for headless screenshot checks;
    // headless WebGPU presents to the swap chain but does not composite into
    // page screenshots).
    const forceWebGL = new URLSearchParams(location.search).has('webgl');
    this.renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL });
    this.renderer.setClearColor(0x05070a, 1); // opaque near-black (§9 --bg)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x05070a);
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1e0, 1e13);
    // Start ~2.5 AU out looking at the inner system.
    this.camera.position.set(0, 1.5e11, 3.7e11);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomSpeed = 1.2; // OrbitControls dolly is multiplicative => exponential zoom
    this.controls.target.set(0, 0, 0); // focus body is pinned here
    this.controls.minDistance = 1e2;
    this.controls.maxDistance = 1e13;

    this.sunLight = new THREE.PointLight(0xffffff, 1, 0, 0);
    this.scene.add(this.sunLight);
    this.scene.add(new THREE.AmbientLight(0x222233, 1.2));

    window.addEventListener('resize', () => this.onResize());
  }

  async init(): Promise<void> {
    await this.renderer.init();
    this.isWebGPU = (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    // Bloom: scene pass + a thresholded bloom so the Sun (and bright stars) glow.
    // Node-based, so it runs on both the WebGPU and WebGL2 backends.
    const scenePass = pass(this.scene, this.camera);
    const bloomPass = bloom(scenePass, 0.7, 0.5, 0.85); // strength, radius, threshold
    this.post = new THREE.PostProcessing(this.renderer);
    this.post.outputNode = scenePass.add(bloomPass);
  }

  async loadStars(url: string, year: number): Promise<void> {
    const buf = await (await fetch(url)).arrayBuffer();
    this.starField = new StarField(buf);
    this.starField.applyEpoch(year);
    this.scene.add(this.starField.points);
  }

  setBodies(defs: Body[]): void {
    defs.forEach((def, i) => {
      const isStar = def.id === 'Sun';
      if (isStar) this.sunIdx = i;
      const map = bodyTexture(def.id);
      // Star: unlit (self-luminous, bright enough to bloom). Planet/moon: lit by
      // the Sun's point light, so a real terminator falls across the texture.
      const mat = isStar
        ? new THREE.MeshBasicMaterial({ map })
        : new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 });
      const mesh = new THREE.Mesh(this.unit, mat);
      mesh.frustumCulled = true;
      const pole = poleQuat(def.rotation.poleRA, def.rotation.poleDec); // axial tilt
      mesh.quaternion.copy(pole);
      this.scene.add(mesh);

      if (def.id === 'Earth') {
        // Night lights: emissive map so cities glow on the dark side (and bloom).
        // Adds slightly on the day side too, but the lit albedo swamps it there.
        const em = mat as THREE.MeshStandardMaterial;
        em.emissiveMap = loadTex('earth_night.jpg');
        em.emissive = new THREE.Color(0xffffff);
        em.emissiveIntensity = 1.4;
        // Clouds: a lit translucent shell just above the surface, alpha from the
        // cloud map's luminance. Child of Earth, so it spins with the surface.
        const clouds = new THREE.Mesh(this.unit, new THREE.MeshStandardMaterial({
          alphaMap: loadTex('earth_clouds.jpg'), transparent: true, color: 0xffffff,
          roughness: 1, metalness: 0, depthWrite: false,
        }));
        clouds.scale.setScalar(1.012);
        mesh.add(clouds);
      }

      if (def.appearance.ringInner && def.appearance.ringOuter) {
        // Radii in planet-radii so the ring inherits the mesh's display scale.
        const ring = new THREE.Mesh(
          buildRing(def.appearance.ringInner / def.radius, def.appearance.ringOuter / def.radius),
          new THREE.MeshBasicMaterial({ map: ringTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false }),
        );
        ring.frustumCulled = false;
        mesh.add(ring); // parent tilt (poleQuat) lays the ring in the equatorial plane
      }
      this.bodies.push({ def, mesh, pole });
    });
    const idOf = (id: string) => defs.findIndex((d) => d.id === id);
    // Orbit paths: planets about the Sun, satellites about their parent body.
    defs.forEach((def, i) => {
      if (i === this.sunIdx) return;
      const centerIdx = def.parent ? idOf(def.parent) : this.sunIdx;
      if (centerIdx < 0) return;
      const mu = defs[centerIdx].gm;
      const geom = new THREE.BufferGeometry();
      // N+1 points: the loop is closed by repeating the first vertex (WebGPU-
      // Renderer has no LineLoop).
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ORBIT_SEGMENTS + 1) * 3), 3));
      const mat = new THREE.LineBasicMaterial({ color: def.appearance.colour, transparent: true, opacity: 0.3 });
      const line = new THREE.Line(geom, mat);
      line.frustumCulled = false; // spans the whole orbit; culling by centre is wrong
      this.scene.add(line);
      this.orbits.push({ idx: i, centerIdx, mu, line, scratch: new Float64Array(ORBIT_SEGMENTS * 3) });
    });
  }

  private updateOrbits(state: Float64Array): void {
    const r = new Float64Array(3), v = new Float64Array(3);
    for (const o of this.orbits) {
      o.line.visible = this.showOrbits;
      if (!this.showOrbits) continue;
      const b = o.idx * 6, cb = o.centerIdx * 6;
      for (let k = 0; k < 3; k++) { r[k] = state[b + k] - state[cb + k]; v[k] = state[b + 3 + k] - state[cb + 3 + k]; }
      if (!sampleOrbitPathRV(r, v, o.mu, ORBIT_SEGMENTS, o.scratch)) { o.line.visible = false; continue; }
      const pos = o.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let k = 0; k < o.scratch.length; k++) arr[k] = o.scratch[k];
      arr[o.scratch.length] = o.scratch[0]; // close the loop
      arr[o.scratch.length + 1] = o.scratch[1];
      arr[o.scratch.length + 2] = o.scratch[2];
      pos.needsUpdate = true;
      o.line.position.copy(this.bodies[o.centerIdx].mesh.position); // centre-relative points + centre scene position
    }
  }

  /**
   * Place every body for this frame. `state` is nBodies*6 SI ecliptic-J2000
   * (x,y,z,vx,vy,vz). `focusIdx` selects the floating-origin anchor.
   * `exaggeration` scales displayed radius (1 = true scale).
   */
  update(state: Float64Array, focusIdx: number, exaggeration: number, tdb: number): void {
    const fx = state[focusIdx * 6], fy = state[focusIdx * 6 + 1], fz = state[focusIdx * 6 + 2];
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const px = state[i * 6] - fx, py = state[i * 6 + 1] - fy, pz = state[i * 6 + 2] - fz;
      b.mesh.position.set(px, py, pz);
      const r = b.def.radius * (b.def.id === 'Sun' ? Math.min(exaggeration, 30) : exaggeration);
      b.mesh.scale.setScalar(r);
      // Live axial rotation: W = W0 + 360*(t/period) deg about the pole. Negative
      // period is retrograde (Venus, Uranus). Visible once time is running fast.
      const p = b.def.rotation.period;
      if (p !== 0) {
        const w = ((b.def.rotation.primeMeridian + 360 * (tdb / p)) % 360) * (Math.PI / 180);
        this.spin.setFromAxisAngle(Y_AXIS, w);
        b.mesh.quaternion.copy(b.pole).multiply(this.spin);
      }
      if (b.def.id === 'Sun') this.sunLight.position.set(px, py, pz);
    }
    this.updateOrbits(state);
    if (this.starField) this.starField.update(this.camera);

    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastUpdate) / 1000);
    this.lastUpdate = now;
    if (this.fly) {
      this.fly.movementSpeed = Math.max(1e6, this.camera.position.length() * 0.6); // scale with distance
      this.fly.update(dt);
    } else {
      this.controls.update();
    }
  }

  /** Toggle free-flight (WASD/RF + drag-to-look) vs orbit/focus controls. */
  setFlyMode(on: boolean): void {
    if (on && !this.fly) {
      this.controls.enabled = false;
      this.fly = new FlyControls(this.camera, this.renderer.domElement);
      this.fly.rollSpeed = 0.6;
      this.fly.dragToLook = true; // look only while dragging; keys always move
    } else if (!on && this.fly) {
      this.fly.dispose();
      this.fly = null;
      this.controls.enabled = true;
    }
  }

  render(): void {
    // Bracket near/far around the bodies actually in front of the camera, so
    // the depth buffer spends its precision where it is needed this frame.
    const camPos = this.camera.position;
    let dmax = 0;
    for (const b of this.bodies) {
      const d = camPos.distanceTo(b.mesh.position) + b.mesh.scale.x;
      if (d > dmax) dmax = d;
    }
    const camDist = camPos.length(); // distance to focus at origin
    this.camera.near = Math.max(1, camDist * 0.02);
    this.camera.far = Math.max(camDist * 5, dmax * 1.5, this.camera.near * 10);
    this.camera.updateProjectionMatrix();
    this.renderer.autoClear = true;
    if (this.post) this.post.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /** Distance from camera to the focus (origin), in metres. For the HUD. */
  focusDistance(): number {
    return this.camera.position.length();
  }

  /** Debug: canvas size + each body's projected NDC and display radius. */
  diag() {
    const cam = this.camera.clone();
    cam.near = 1e3; cam.far = 1e13; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    const v = new THREE.Vector3();
    const bodies = this.bodies.map((b) => {
      v.copy(b.mesh.position).project(cam);
      return { id: b.def.id, ndc: [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)], r: b.mesh.scale.x };
    });
    const el = this.renderer.domElement;
    return { w: el.width, h: el.height, clientW: el.clientWidth, clientH: el.clientHeight, bodies };
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
