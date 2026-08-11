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
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Body } from '../core/types';
import { sampleOrbitPathRV } from '../core/orbital/elements';

const ORBIT_SEGMENTS = 256;

export interface RenderBody {
  def: Body;
  mesh: THREE.Mesh;
}

export class Renderer {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly bodies: RenderBody[] = [];
  private sunLight: THREE.PointLight;
  private unit = new THREE.SphereGeometry(1, 48, 24);
  private sunIdx = 0;
  private orbits: { idx: number; line: THREE.Line; scratch: Float64Array }[] = [];
  private muSun = 1.32712440018e20;
  showOrbits = true;
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
  }

  setBodies(defs: Body[]): void {
    defs.forEach((def, i) => {
      const isStar = def.id === 'Sun';
      if (isStar) this.sunIdx = i;
      const mat = isStar
        ? new THREE.MeshBasicMaterial({ color: def.appearance.colour })
        : new THREE.MeshStandardMaterial({ color: def.appearance.colour, roughness: 1, metalness: 0 });
      const mesh = new THREE.Mesh(this.unit, mat);
      mesh.frustumCulled = true;
      this.scene.add(mesh);
      this.bodies.push({ def, mesh });
    });
    this.muSun = defs[this.sunIdx].gm;
    // Orbit paths for heliocentric bodies (planets: no parent, not the Sun).
    defs.forEach((def, i) => {
      if (i === this.sunIdx || def.parent) return;
      const geom = new THREE.BufferGeometry();
      // N+1 points: the loop is closed by repeating the first vertex (WebGPU-
      // Renderer has no LineLoop).
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array((ORBIT_SEGMENTS + 1) * 3), 3));
      const mat = new THREE.LineBasicMaterial({ color: def.appearance.colour, transparent: true, opacity: 0.3 });
      const line = new THREE.Line(geom, mat);
      line.frustumCulled = false; // spans the whole orbit; culling by centre is wrong
      this.scene.add(line);
      this.orbits.push({ idx: i, line, scratch: new Float64Array(ORBIT_SEGMENTS * 3) });
    });
  }

  private updateOrbits(state: Float64Array): void {
    const sb = this.sunIdx * 6;
    const sun = this.bodies[this.sunIdx].mesh.position;
    const r = new Float64Array(3), v = new Float64Array(3);
    for (const o of this.orbits) {
      o.line.visible = this.showOrbits;
      if (!this.showOrbits) continue;
      const b = o.idx * 6;
      for (let k = 0; k < 3; k++) { r[k] = state[b + k] - state[sb + k]; v[k] = state[b + 3 + k] - state[sb + 3 + k]; }
      if (!sampleOrbitPathRV(r, v, this.muSun, ORBIT_SEGMENTS, o.scratch)) { o.line.visible = false; continue; }
      const pos = o.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let k = 0; k < o.scratch.length; k++) arr[k] = o.scratch[k];
      arr[o.scratch.length] = o.scratch[0]; // close the loop
      arr[o.scratch.length + 1] = o.scratch[1];
      arr[o.scratch.length + 2] = o.scratch[2];
      pos.needsUpdate = true;
      o.line.position.copy(sun); // heliocentric points + Sun scene position
    }
  }

  /**
   * Place every body for this frame. `state` is nBodies*6 SI ecliptic-J2000
   * (x,y,z,vx,vy,vz). `focusIdx` selects the floating-origin anchor.
   * `exaggeration` scales displayed radius (1 = true scale).
   */
  update(state: Float64Array, focusIdx: number, exaggeration: number): void {
    const fx = state[focusIdx * 6], fy = state[focusIdx * 6 + 1], fz = state[focusIdx * 6 + 2];
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const px = state[i * 6] - fx, py = state[i * 6 + 1] - fy, pz = state[i * 6 + 2] - fz;
      b.mesh.position.set(px, py, pz);
      const r = b.def.radius * (b.def.id === 'Sun' ? Math.min(exaggeration, 30) : exaggeration);
      b.mesh.scale.setScalar(r);
      if (b.def.id === 'Sun') this.sunLight.position.set(px, py, pz);
    }
    this.updateOrbits(state);
    this.controls.update();
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
    this.renderer.render(this.scene, this.camera);
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
