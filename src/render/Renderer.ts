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
import { pass, texture, uniform, normalWorld, dot, smoothstep } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FlyControls } from 'three/addons/controls/FlyControls.js';
import type { Body } from '../core/types';
import { sampleOrbitPathRV } from '../core/orbital/elements';
import { eqjToEcl } from '../core/frames';
import * as satellite from 'satellite.js';
import { IAS15 } from '../core/integrate/ias15';
import { Vessel, rtnBasis } from '../core/spacecraft/vessel';
import { tdbToDate } from '../core/time';
import { StarField } from './StarField';
import { AsteroidField } from './AsteroidField';

const GM_SUN = 1.32712440018e20;
const V_DRAG_SCALE = 3e-7; // world-metres of drag -> m/s of insert velocity
export type InsertCommit = (x: [number, number, number], v: [number, number, number]) => void;

const ORBIT_SEGMENTS = 256;
const RING_SEGMENTS = 256;
const MAX_PARTICLES = 64;
const TRAIL_LEN = 600; // breadcrumb points per test particle
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
  private earthIdx = -1;
  private earthClouds: THREE.Mesh | null = null;
  // Spheres of influence (P3.5): r_SOI = a·(m/M)^(2/5), drawn true-scale per planet.
  private soi: { idx: number; mesh: THREE.Mesh; k: number }[] = [];
  private soiVisible = false;
  // Test particles (P3): one Points cloud for markers + a ring-buffer trail line
  // each. Trails hold absolute ecliptic positions, re-offset by focus per frame.
  private particlePoints!: THREE.Points;
  private trails: { line: THREE.Line; abs: Float64Array; head: number; len: number }[] = [];
  private prevParticleCount = 0;
  // Interactive insert (P3): click to place on the ecliptic, drag to set velocity,
  // a two-body preview ellipse updates live, release commits to the worker.
  private focusAbs = new THREE.Vector3(); // absolute ecliptic focus offset (m)
  private sunAbs = new THREE.Vector3();
  private previewLine!: THREE.Line;
  private previewIas!: IAS15;
  private inserting = false;
  private insertOnCommit: InsertCommit | null = null;
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  // Real mission trajectories (P3.5): baked polylines + a marker at the current epoch.
  private missions: { name: string; line: THREE.Line; marker: THREE.Points; abs: Float64Array; times: Float64Array }[] = [];
  // Earth satellites (P3.5): named SGP4 groups (e.g. mixed constellations, Starlink).
  private satGroups: { name: string; satrecs: satellite.SatRec[]; names: string[]; points: THREE.Points; visible: boolean; drawIdx: number[]; drawCount: number }[] = [];
  private pickV = new THREE.Vector3();
  private satFrame = 0;
  // Vessel on rails (P3.5): heliocentric Kepler plan, offset by the Sun each frame.
  private vessel: Vessel | null = null;
  private vesselMarker!: THREE.Points;
  private vesselLine!: THREE.Line;
  private nodeMarkers!: THREE.Points;
  private static VTRAJ = 320;
  private static TSAMP = 220;
  // Transfer planner (P3.5): a heliocentric trajectory + from/to markers.
  private transferLine!: THREE.Line;
  private transferMarks!: THREE.Points;
  private transferHelio: Float64Array | null = null;
  private transferMarksHelio: Float64Array | null = null;
  // Maneuver-node gizmo: 3 draggable handles along prograde/normal/radial.
  private handles: THREE.Mesh[] = [];
  private gizmoAxis = -1;           // which axis is being dragged (0=pro,1=nrm,2=rad)
  private gizmoNode = new THREE.Vector3();  // node position, scene coords
  private gizmoDirs = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private gizmoL = 1;               // current handle rest length (scene m)
  onNodeDrag: (() => void) | null = null;
  private placeAbs = new THREE.Vector3(); // placement point (absolute)
  private insVel: [number, number, number] = [0, 0, 0];
  private dragging = false;
  // TSL uniform handle (Earth->Sun dir, scene frame). `any`: TSL node types are
  // too loose to thread through dot()/emissiveNode without friction.
  private sunDirNode: { value: THREE.Vector3 } | null = null;
  showOrbits = true;
  starField: StarField | null = null;
  private asteroids: AsteroidField | null = null;
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

    this.setupParticles();
    this.setupInsert();
    // Vessel: planned trajectory line, craft marker, maneuver-node markers.
    this.vesselLine = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(Renderer.VTRAJ * 3), 3)),
      new THREE.LineBasicMaterial({ color: 0x66ddff, transparent: true, opacity: 0.9 }));
    this.vesselLine.frustumCulled = false; this.vesselLine.visible = false; this.scene.add(this.vesselLine);
    this.vesselMarker = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
      new THREE.PointsMaterial({ color: 0xffffff, size: 10, sizeAttenuation: false }));
    this.vesselMarker.frustumCulled = false; this.vesselMarker.visible = false; this.scene.add(this.vesselMarker);
    this.nodeMarkers = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(8 * 3), 3)),
      new THREE.PointsMaterial({ color: 0xffcc33, size: 11, sizeAttenuation: false }));
    this.nodeMarkers.frustumCulled = false; this.nodeMarkers.visible = false; this.scene.add(this.nodeMarkers);
    // Node gizmo handles: prograde (green), normal (purple), radial (cyan).
    const hcol = [0x66ff88, 0xcc77ff, 0x66ddff];
    for (let a = 0; a < 3; a++) {
      const h = new THREE.Mesh(this.unit, new THREE.MeshBasicMaterial({ color: hcol[a], depthTest: false, transparent: true }));
      h.frustumCulled = false; h.visible = false; h.renderOrder = 999;
      h.userData.axis = a;
      this.handles.push(h); this.scene.add(h);
    }
    this.transferLine = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(Renderer.TSAMP * 3), 3)),
      new THREE.LineBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.95 }));
    this.transferLine.frustumCulled = false; this.transferLine.visible = false; this.scene.add(this.transferLine);
    this.transferMarks = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(2 * 3), 3)),
      new THREE.PointsMaterial({ color: 0xffee88, size: 11, sizeAttenuation: false, depthTest: false }));
    this.transferMarks.frustumCulled = false; this.transferMarks.visible = false; this.scene.add(this.transferMarks);
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.onGizmoDown(e));
    el.addEventListener('pointermove', (e) => this.onGizmoMove(e));
    window.addEventListener('pointerup', () => this.onGizmoUp());
    window.addEventListener('resize', () => this.onResize());
  }

  /** Draw a heliocentric transfer trajectory (n×3) + endpoint markers, or clear. */
  setTransfer(path: Float64Array | null, marks: Float64Array | null): void {
    this.transferHelio = path; this.transferMarksHelio = marks ?? null;
    this.transferLine.visible = !!path; this.transferMarks.visible = !!marks;
  }

  private updateTransfer(): void {
    const path = this.transferHelio;
    if (!path || !this.transferLine.visible) return;
    const ox = this.sunAbs.x - this.focusAbs.x, oy = this.sunAbs.y - this.focusAbs.y, oz = this.sunAbs.z - this.focusAbs.z;
    const n = path.length / 3, arr = this.transferLine.geometry.getAttribute('position').array as Float32Array;
    for (let i = 0; i < n; i++) { arr[i * 3] = path[i * 3] + ox; arr[i * 3 + 1] = path[i * 3 + 1] + oy; arr[i * 3 + 2] = path[i * 3 + 2] + oz; }
    (this.transferLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.transferLine.geometry.setDrawRange(0, n);
    const m = this.transferMarksHelio;
    if (m) {
      const ma = this.transferMarks.geometry.getAttribute('position').array as Float32Array;
      for (let i = 0; i < m.length / 3; i++) { ma[i * 3] = m[i * 3] + ox; ma[i * 3 + 1] = m[i * 3 + 1] + oy; ma[i * 3 + 2] = m[i * 3 + 2] + oz; }
      (this.transferMarks.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      this.transferMarks.geometry.setDrawRange(0, m.length / 3);
    }
  }

  setVessel(v: Vessel | null): void {
    this.vessel = v;
    const on = v !== null;
    this.vesselLine.visible = on; this.vesselMarker.visible = on; this.nodeMarkers.visible = on;
    for (const h of this.handles) h.visible = on;
  }

  private vr = new Float64Array(3); private vv = new Float64Array(3);
  private vtraj = new Float64Array(Renderer.VTRAJ * 3);
  private periodAt(r: Float64Array, v: Float64Array): number {
    const rn = Math.hypot(r[0], r[1], r[2]), v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    const a = 1 / (2 / rn - v2 / GM_SUN);
    return a > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / GM_SUN) : Infinity;
  }

  // Draw the vessel plan: heliocentric samples offset by (Sun - focus).
  private updateVessel(tdb: number): void {
    const ves = this.vessel;
    if (!ves || !this.vesselLine.visible) return;
    const ox = this.sunAbs.x - this.focusAbs.x, oy = this.sunAbs.y - this.focusAbs.y, oz = this.sunAbs.z - this.focusAbs.z;
    ves.stateAt(tdb, this.vr, this.vv);
    const mk = this.vesselMarker.geometry.getAttribute('position') as THREE.BufferAttribute;
    (mk.array as Float32Array)[0] = this.vr[0] + ox; (mk.array as Float32Array)[1] = this.vr[1] + oy; (mk.array as Float32Array)[2] = this.vr[2] + oz;
    mk.needsUpdate = true;
    // Span: ~1.15 current periods, extended past the last node's post-burn orbit.
    let per = this.periodAt(this.vr, this.vv);
    if (!Number.isFinite(per)) per = 10 * 365.25 * 86400; // unbound: fixed 10 yr window
    let tEnd = tdb + per * 1.15;
    if (ves.nodes.length) {
      const last = Math.max(...ves.nodes.map((n) => n.t));
      ves.stateAt(last + 1, this.vr, this.vv);
      let pp = this.periodAt(this.vr, this.vv); if (!Number.isFinite(pp)) pp = 10 * 365.25 * 86400;
      tEnd = Math.max(tEnd, last + pp * 1.15);
    }
    const N = Renderer.VTRAJ;
    ves.sampleTrajectory(tdb, tEnd, N, this.vtraj);
    const pos = this.vesselLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < N; i++) { arr[i * 3] = this.vtraj[i * 3] + ox; arr[i * 3 + 1] = this.vtraj[i * 3 + 1] + oy; arr[i * 3 + 2] = this.vtraj[i * 3 + 2] + oz; }
    pos.needsUpdate = true;
    // Node markers.
    const nm = this.nodeMarkers.geometry.getAttribute('position') as THREE.BufferAttribute;
    const na = nm.array as Float32Array;
    ves.nodes.slice(0, 8).forEach((node, k) => {
      ves.stateAt(node.t, this.vr, this.vv);
      na[k * 3] = this.vr[0] + ox; na[k * 3 + 1] = this.vr[1] + oy; na[k * 3 + 2] = this.vr[2] + oz;
    });
    nm.needsUpdate = true; this.nodeMarkers.geometry.setDrawRange(0, Math.min(8, ves.nodes.length));

    // Gizmo handles on the editable node (nodes[0]). Position = node + axis*(L + dv/K),
    // L screen-scaled so handles stay grabbable and roughly constant on screen.
    if (ves.nodes.length && this.gizmoAxis < 0) {
      const node = ves.nodes[0];
      ves.stateAt(node.t, this.vr, this.vv); // pre-burn state -> basis
      this.gizmoNode.set(this.vr[0] + ox, this.vr[1] + oy, this.vr[2] + oz);
      const { P, N, R } = rtnBasis(this.vr, this.vv);
      const dirs = [P, N, R], comps = [node.prograde, node.normal, node.radial];
      const L = 0.12 * this.camera.position.distanceTo(this.gizmoNode);
      this.gizmoL = L; const K = L / 5000; // 5000 m/s spans one rest-length
      for (let a = 0; a < 3; a++) {
        this.gizmoDirs[a].set(dirs[a][0], dirs[a][1], dirs[a][2]);
        this.handles[a].position.copy(this.gizmoNode).addScaledVector(this.gizmoDirs[a], L + comps[a] * K);
        this.handles[a].scale.setScalar(0.05 * L);
      }
    }
  }

  private setNdc(e: PointerEvent): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private onGizmoDown(e: PointerEvent): void {
    if (!this.vessel || !this.vessel.nodes.length || this.inserting || this.fly) return;
    this.setNdc(e); this.ray.setFromCamera(this.ndc, this.camera);
    const hit = this.ray.intersectObjects(this.handles, false)[0];
    if (!hit) return;
    this.gizmoAxis = hit.object.userData.axis as number;
    this.controls.enabled = false;
  }

  private onGizmoMove(e: PointerEvent): void {
    if (this.gizmoAxis < 0 || !this.vessel) return;
    this.setNdc(e); this.ray.setFromCamera(this.ndc, this.camera);
    // Signed distance along the axis of the point closest to the pointer ray.
    const D = this.gizmoDirs[this.gizmoAxis], E = this.ray.ray.direction;
    const w0x = this.gizmoNode.x - this.ray.ray.origin.x, w0y = this.gizmoNode.y - this.ray.ray.origin.y, w0z = this.gizmoNode.z - this.ray.ray.origin.z;
    const b = D.x * E.x + D.y * E.y + D.z * E.z;
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-6) return; // ray ~parallel to the axis
    const d = D.x * w0x + D.y * w0y + D.z * w0z, ee = E.x * w0x + E.y * w0y + E.z * w0z;
    const s = (b * ee - d) / denom; // distance along the axis from the node
    let dv = (s - this.gizmoL) / (this.gizmoL / 5000);
    dv = Math.max(-8000, Math.min(8000, dv));
    const node = this.vessel.nodes[0];
    if (this.gizmoAxis === 0) node.prograde = dv; else if (this.gizmoAxis === 1) node.normal = dv; else node.radial = dv;
    this.onNodeDrag?.();
  }

  private onGizmoUp(): void {
    if (this.gizmoAxis < 0) return;
    this.gizmoAxis = -1;
    this.controls.enabled = !this.inserting;
  }

  /** Load a real mission trajectory ([tdb_s, x, y, z] per sample, m) in `color`. */
  async loadMission(name: string, url: string, color: number): Promise<void> {
    const buf = await (await fetch(url)).arrayBuffer();
    const dv = new DataView(buf);
    const n = dv.getUint32(0, true);
    const times = new Float64Array(n), abs = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const o = 4 + i * 32;
      times[i] = dv.getFloat64(o, true);
      abs[i * 3] = dv.getFloat64(o + 8, true); abs[i * 3 + 1] = dv.getFloat64(o + 16, true); abs[i * 3 + 2] = dv.getFloat64(o + 24, true);
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
    line.frustumCulled = false; line.geometry.setDrawRange(0, n); this.scene.add(line);
    const marker = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
      new THREE.PointsMaterial({ color, size: 8, sizeAttenuation: false, transparent: true }));
    marker.frustumCulled = false; this.scene.add(marker);
    this.missions.push({ name, line, marker, abs, times });
  }

  setMissionVisible(name: string, on: boolean): void {
    const m = this.missions.find((x) => x.name === name);
    if (m) { m.line.visible = on; m.marker.visible = on; }
  }
  missionNames(): string[] { return this.missions.map((m) => m.name); }

  /** Load a named Earth-satellite group (TLE name/line1/line2 triples) for SGP4. */
  async loadSatelliteGroup(name: string, url: string, color: number, size = 3): Promise<void> {
    const lines = (await (await fetch(url)).text()).split(/\r?\n/);
    const satrecs: satellite.SatRec[] = [], names: string[] = [];
    for (let i = 0; i + 2 < lines.length; i++) {
      if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
        try { satrecs.push(satellite.twoline2satrec(lines[i + 1], lines[i + 2])); names.push((lines[i] || `NORAD ${lines[i + 1].slice(2, 7)}`).trim()); } catch { /* skip */ }
        i += 2;
      }
    }
    const points = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(satrecs.length * 3), 3)),
      new THREE.PointsMaterial({ color, size, sizeAttenuation: false, transparent: true })); // depth-test: occluded behind Earth
    points.frustumCulled = false; points.visible = false; points.geometry.setDrawRange(0, 0); this.scene.add(points);
    this.satGroups.push({ name, satrecs, names, points, visible: false, drawIdx: [], drawCount: 0 });
  }

  setSatGroupVisible(name: string, on: boolean): void {
    const g = this.satGroups.find((x) => x.name === name);
    if (g) { g.visible = on; g.points.visible = on; }
  }
  satGroupCount(name: string): number { return this.satGroups.find((x) => x.name === name)?.satrecs.length ?? 0; }

  /** Name of the satellite nearest the cursor (within ~12 px) across visible groups. */
  pickSatellite(clientX: number, clientY: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    let best = 12, name: string | null = null;
    for (const g of this.satGroups) {
      if (!g.visible || !g.drawCount) continue;
      const arr = g.points.geometry.getAttribute('position').array as Float32Array;
      for (let i = 0; i < g.drawCount; i++) {
        this.pickV.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]).project(this.camera);
        if (this.pickV.z >= 1) continue;
        const d = Math.hypot((this.pickV.x * 0.5 + 0.5) * rect.width - px, (-this.pickV.y * 0.5 + 0.5) * rect.height - py);
        if (d < best) { best = d; name = g.names[g.drawIdx[i]]; }
      }
    }
    return name;
  }

  // SGP4-propagate each visible group and place it around Earth (TEME ≈ equatorial
  // J2000 -> ecliptic; + Earth's barycentric position). Big groups throttle to
  // ~every 4th frame (satellites barely move a pixel between frames).
  private updateSatellites(state: Float64Array, tdb: number): void {
    if (this.earthIdx < 0) return;
    this.satFrame++;
    const date = tdbToDate(tdb as never);
    const ex = state[this.earthIdx * 6], ey = state[this.earthIdx * 6 + 1], ez = state[this.earthIdx * 6 + 2];
    const fx = this.focusAbs.x, fy = this.focusAbs.y, fz = this.focusAbs.z;
    for (const g of this.satGroups) {
      if (!g.visible) continue;
      if (g.satrecs.length > 1000 && this.satFrame % 4 !== 0) continue; // throttle large constellations
      const arr = g.points.geometry.getAttribute('position').array as Float32Array;
      let count = 0;
      for (let si = 0; si < g.satrecs.length; si++) {
        const pv = satellite.propagate(g.satrecs[si], date);
        const pos = pv?.position;
        if (!pos || typeof pos === 'boolean') continue;
        this.vr[0] = pos.x * 1000; this.vr[1] = pos.y * 1000; this.vr[2] = pos.z * 1000;
        eqjToEcl(this.vr, this.vr);
        arr[count * 3] = this.vr[0] + ex - fx; arr[count * 3 + 1] = this.vr[1] + ey - fy; arr[count * 3 + 2] = this.vr[2] + ez - fz;
        g.drawIdx[count] = si; count++;
      }
      g.drawCount = count;
      (g.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      g.points.geometry.setDrawRange(0, count);
    }
  }

  // Rewrite each visible mission's line offset by focus + place its epoch marker.
  private updateMissions(tdb: number): void {
    const fx = this.focusAbs.x, fy = this.focusAbs.y, fz = this.focusAbs.z;
    for (const ms of this.missions) {
      if (!ms.line.visible) continue;
      const { abs, times } = ms, n = times.length;
      const arr = ms.line.geometry.getAttribute('position').array as Float32Array;
      for (let i = 0; i < n; i++) { arr[i * 3] = abs[i * 3] - fx; arr[i * 3 + 1] = abs[i * 3 + 1] - fy; arr[i * 3 + 2] = abs[i * 3 + 2] - fz; }
      (ms.line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      const mk = ms.marker.geometry.getAttribute('position') as THREE.BufferAttribute;
      if (tdb < times[0] || tdb > times[n - 1]) { ms.marker.visible = false; continue; }
      ms.marker.visible = true;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= tdb) lo = mid; else hi = mid; }
      const f = (tdb - times[lo]) / (times[hi] - times[lo] || 1);
      for (let k = 0; k < 3; k++) (mk.array as Float32Array)[k] = abs[lo * 3 + k] + (abs[hi * 3 + k] - abs[lo * 3 + k]) * f - [fx, fy, fz][k];
      mk.needsUpdate = true;
    }
  }

  private setupInsert(): void {
    // Two-body (Sun-only) preview integrator — fast analytic-quality ellipse.
    this.previewIas = new IAS15(1, (_t, x, a) => {
      const dx = this.sunAbs.x - x[0], dy = this.sunAbs.y - x[1], dz = this.sunAbs.z - x[2];
      const r2 = dx * dx + dy * dy + dz * dz, inv = GM_SUN / (r2 * Math.sqrt(r2));
      a[0] = inv * dx; a[1] = inv * dy; a[2] = inv * dz;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(300 * 3), 3));
    g.setDrawRange(0, 0);
    this.previewLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.9 }));
    this.previewLine.frustumCulled = false; this.previewLine.visible = false;
    this.scene.add(this.previewLine);
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.onInsertDown(e));
    el.addEventListener('pointermove', (e) => this.onInsertMove(e));
    window.addEventListener('pointerup', () => this.onInsertUp());
  }

  /** Enable click-to-place insert (disables orbit controls while active). */
  setInsertMode(on: boolean, onCommit?: InsertCommit): void {
    this.inserting = on;
    this.insertOnCommit = onCommit ?? null;
    this.controls.enabled = !on;
    if (!on) { this.dragging = false; this.previewLine.visible = false; }
  }

  private eclipticHit(e: PointerEvent, out: THREE.Vector3): boolean {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    // True ecliptic plane (abs z=0) sits at scene z = -focusAbs.z.
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), this.focusAbs.z);
    return this.ray.ray.intersectPlane(plane, out) !== null;
  }

  private onInsertDown(e: PointerEvent): void {
    if (!this.inserting) return;
    const hit = new THREE.Vector3();
    if (!this.eclipticHit(e, hit)) return;
    this.placeAbs.copy(hit).add(this.focusAbs); // scene -> absolute
    this.dragging = true;
    this.updatePreview(0, 0, 0);
  }

  private onInsertMove(e: PointerEvent): void {
    if (!this.inserting || !this.dragging) return;
    const hit = new THREE.Vector3();
    if (!this.eclipticHit(e, hit)) return;
    hit.add(this.focusAbs); // absolute drag point
    this.updatePreview(
      (hit.x - this.placeAbs.x) * V_DRAG_SCALE,
      (hit.y - this.placeAbs.y) * V_DRAG_SCALE,
      (hit.z - this.placeAbs.z) * V_DRAG_SCALE,
    );
  }

  private onInsertUp(): void {
    if (!this.inserting || !this.dragging) return;
    this.dragging = false;
    this.previewLine.visible = false;
    this.insertOnCommit?.([this.placeAbs.x, this.placeAbs.y, this.placeAbs.z], this.insVel);
  }

  /** Integrate a two-body preview for the candidate state and draw the ellipse. */
  private updatePreview(vx: number, vy: number, vz: number): void {
    this.insVel = [vx, vy, vz];
    const P = this.previewIas; P.reset();
    P.x[0] = this.placeAbs.x; P.x[1] = this.placeAbs.y; P.x[2] = this.placeAbs.z;
    P.v[0] = vx; P.v[1] = vy; P.v[2] = vz;
    const rx = this.placeAbs.x - this.sunAbs.x, ry = this.placeAbs.y - this.sunAbs.y, rz = this.placeAbs.z - this.sunAbs.z;
    const r = Math.hypot(rx, ry, rz), v2 = vx * vx + vy * vy + vz * vz;
    const eps = v2 / 2 - GM_SUN / r; // specific orbital energy (Sun-relative)
    const span = eps < 0
      ? 1.15 * 2 * Math.PI * Math.sqrt(Math.pow(-GM_SUN / (2 * eps), 3) / GM_SUN) // ~1.15 periods
      : 3 * r / Math.max(Math.sqrt(v2), 500); // unbound: a few radii of travel
    const STEPS = 300, dt = span / STEPS;
    const arr = this.previewLine.geometry.getAttribute('position').array as Float32Array;
    let t = 0;
    for (let k = 0; k < STEPS; k++) {
      arr[k * 3] = P.x[0] - this.focusAbs.x; arr[k * 3 + 1] = P.x[1] - this.focusAbs.y; arr[k * 3 + 2] = P.x[2] - this.focusAbs.z;
      P.step(t, dt); t += dt;
    }
    (this.previewLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.previewLine.geometry.setDrawRange(0, STEPS);
    this.previewLine.visible = true;
  }

  private setupParticles(): void {
    // Markers: fixed-pixel-size bright points (always visible, no attenuation).
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3));
    g.setDrawRange(0, 0);
    this.particlePoints = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x66ffcc, size: 7, sizeAttenuation: false, transparent: true,
    }));
    this.particlePoints.frustumCulled = false;
    this.scene.add(this.particlePoints);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_LEN * 3), 3));
      tg.setDrawRange(0, 0);
      const line = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.55 }));
      line.frustumCulled = false; line.visible = false;
      this.scene.add(line);
      this.trails.push({ line, abs: new Float64Array(TRAIL_LEN * 3), head: 0, len: 0 });
    }
  }

  /** Place test-particle markers + append to their trails. `pos` is count*3
   *  barycentric ecliptic m; (fx,fy,fz) is the floating-origin focus offset. */
  updateParticles(pos: Float64Array, fx: number, fy: number, fz: number): void {
    const count = pos.length / 3;
    // Reset trails that vanished (cleared) or were newly added.
    for (let i = count; i < this.prevParticleCount; i++) { const t = this.trails[i]; t.head = 0; t.len = 0; t.line.visible = false; }
    for (let i = this.prevParticleCount; i < count; i++) { const t = this.trails[i]; t.head = 0; t.len = 0; }
    this.prevParticleCount = count;

    const mk = this.particlePoints.geometry.getAttribute('position') as THREE.BufferAttribute;
    const mkArr = mk.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const ax = pos[i * 3], ay = pos[i * 3 + 1], az = pos[i * 3 + 2];
      mkArr[i * 3] = ax - fx; mkArr[i * 3 + 1] = ay - fy; mkArr[i * 3 + 2] = az - fz;
      // Append absolute position to the ring buffer.
      const t = this.trails[i];
      t.abs[t.head * 3] = ax; t.abs[t.head * 3 + 1] = ay; t.abs[t.head * 3 + 2] = az;
      t.head = (t.head + 1) % TRAIL_LEN;
      if (t.len < TRAIL_LEN) t.len++;
      // Rebuild the line oldest->newest, offset by focus.
      const la = t.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      const laArr = la.array as Float32Array;
      const start = (t.head - t.len + TRAIL_LEN) % TRAIL_LEN;
      for (let k = 0; k < t.len; k++) {
        const s = (start + k) % TRAIL_LEN;
        laArr[k * 3] = t.abs[s * 3] - fx; laArr[k * 3 + 1] = t.abs[s * 3 + 1] - fy; laArr[k * 3 + 2] = t.abs[s * 3 + 2] - fz;
      }
      la.needsUpdate = true; t.line.geometry.setDrawRange(0, t.len); t.line.visible = t.len > 1;
    }
    mk.needsUpdate = true; this.particlePoints.geometry.setDrawRange(0, count);
    this.particlePoints.visible = count > 0;
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

  /** Load the baked asteroid elements as a GPU-propagated point field (P4). */
  async loadAsteroids(url: string): Promise<void> {
    this.asteroids = new AsteroidField(await (await fetch(url)).arrayBuffer());
    this.scene.add(this.asteroids.points);
  }
  setAsteroidsVisible(on: boolean): void { this.asteroids?.setVisible(on); }
  setAsteroidCount(n: number): void { this.asteroids?.setDrawCount(n); }
  asteroidCount(): number { return this.asteroids?.count ?? 0; }

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
        this.earthIdx = i;
        // Night lights, terminator-gated: emissive = nightMap * (1 - dayFactor),
        // where dayFactor ramps 0->1 across the terminator from the Sun direction.
        // So cities only light the dark side; the day side gets zero bleed.
        const sunDir = uniform(new THREE.Vector3(1, 0, 0));
        this.sunDirNode = sunDir as unknown as { value: THREE.Vector3 };
        const dayF = smoothstep(-0.25, 0.15, dot(normalWorld, sunDir));
        const em = mat as unknown as THREE.MeshStandardNodeMaterial;
        em.emissiveNode = texture(loadTex('earth_night.jpg')).mul(dayF.oneMinus()).mul(1.6);
        // Clouds: a lit translucent shell just above the surface, alpha from the
        // cloud map's luminance. Child of Earth, so it spins with the surface.
        const clouds = new THREE.Mesh(this.unit, new THREE.MeshStandardMaterial({
          alphaMap: loadTex('earth_clouds.jpg'), transparent: true, color: 0xffffff,
          roughness: 1, metalness: 0, depthWrite: false,
        }));
        clouds.scale.setScalar(1.012);
        mesh.add(clouds);
        this.earthClouds = clouds;
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
    // Spheres of influence: planets only (not the Sun or the Moon). k = (m/M)^(2/5),
    // so r_SOI = k · (planet's distance from the Sun) — computed live in update().
    const gmSun = defs[this.sunIdx].gm, soiGeom = new THREE.SphereGeometry(1, 24, 16);
    defs.forEach((def, i) => {
      if (i === this.sunIdx || def.parent) return; // skip Sun + satellites (Moon)
      const mesh = new THREE.Mesh(soiGeom, new THREE.MeshBasicMaterial({ color: 0x4a90ff, wireframe: true, transparent: true, opacity: 0.12, depthWrite: false }));
      mesh.frustumCulled = false; mesh.visible = false; this.scene.add(mesh);
      this.soi.push({ idx: i, mesh, k: Math.pow(def.gm / gmSun, 0.4) });
    });
  }

  setSoiVisible(on: boolean): void { this.soiVisible = on; for (const s of this.soi) s.mesh.visible = on; }

  // Position + size each planet's SOI sphere (true scale) from live positions.
  private updateSoi(state: Float64Array): void {
    if (!this.soiVisible) return;
    const s = this.sunIdx * 6;
    for (const so of this.soi) {
      const b = so.idx * 6;
      const dist = Math.hypot(state[b] - state[s], state[b + 1] - state[s + 1], state[b + 2] - state[s + 2]);
      so.mesh.position.set(state[b] - this.focusAbs.x, state[b + 1] - this.focusAbs.y, state[b + 2] - this.focusAbs.z);
      so.mesh.scale.setScalar(dist * so.k);
    }
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
    this.focusAbs.set(fx, fy, fz);
    this.sunAbs.set(state[this.sunIdx * 6], state[this.sunIdx * 6 + 1], state[this.sunIdx * 6 + 2]);
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
    // Brighter sunlight at true/near-true scale, where planets are small and read
    // as dim; eased down as the size exaggeration grows.
    const logE = Math.log10(Math.max(1, exaggeration));
    this.sunLight.intensity = 1.5 + 2.2 * Math.max(0, Math.min(1, (2 - logE) / 2));
    if (this.sunDirNode && this.earthIdx >= 0) {
      // Scene-frame direction from Earth to the Sun for the night-side gate.
      this.sunDirNode.value
        .copy(this.bodies[this.sunIdx].mesh.position)
        .sub(this.bodies[this.earthIdx].mesh.position)
        .normalize();
    }
    if (this.earthClouds) {
      // Cloud drift: clouds lead the surface, one extra lap ~every 8 days. Local
      // rotation about the pole, so it composes with Earth's own spin (parent).
      this.spin.setFromAxisAngle(Y_AXIS, (tdb / 691200) * Math.PI * 2);
      this.earthClouds.quaternion.copy(this.spin);
    }
    if (this.asteroids) {
      this.asteroids.uTime.value = tdb;
      (this.asteroids.uSunOffset.value as THREE.Vector3).set(this.sunAbs.x - this.focusAbs.x, this.sunAbs.y - this.focusAbs.y, this.sunAbs.z - this.focusAbs.z);
    }
    this.updateOrbits(state);
    this.updateSoi(state);
    this.updateSatellites(state, tdb);
    this.updateMissions(tdb);
    this.updateVessel(tdb);
    this.updateTransfer();
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
