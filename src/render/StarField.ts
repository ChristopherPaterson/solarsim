// Hipparcos-class star field (build plan §7 P1). One instanced Points draw,
// additive, depth-test off, rendered behind everything. Stars are treated as
// being at infinity: the Points object is recentred on the camera each frame so
// there is no translation parallax, only correct rotation with the view.
//
// Brightness comes from flux 10^(-0.4·mag), never linear in magnitude. Colour
// comes from B-V via Ballesteros' temperature and a blackbody->sRGB fit.
//
// ponytail: fixed ~2 px sprites (>= the 1.5 px scintillation floor) rather than
// per-star sprite sizing, which needs a custom TSL point material — add that in
// P5 polish. Proper motion is stored and applied on demand (applyEpoch), not
// every frame.

import * as THREE from 'three/webgpu';
import { eqjToEcl } from '../core/frames';

const MAS_TO_RAD = Math.PI / (180 * 3600 * 1000);

/** B-V colour index -> approximate linear sRGB via Ballesteros + blackbody. */
function bvToRGB(bv: number): [number, number, number] {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)); // Kelvin
  // Compact blackbody->sRGB fit (Helland), clamped to [0,1].
  const k = t / 100;
  let r: number, g: number, b: number;
  if (k <= 66) r = 255;
  else r = 329.7 * Math.pow(k - 60, -0.1332);
  if (k <= 66) g = 99.47 * Math.log(k) - 161.12;
  else g = 288.12 * Math.pow(k - 60, -0.0755);
  if (k >= 66) b = 255;
  else if (k <= 19) b = 0;
  else b = 138.52 * Math.log(k - 10) - 305.04;
  const c = (v: number) => Math.min(1, Math.max(0, v / 255));
  return [c(r), c(g), c(b)];
}

export class StarField {
  readonly points: THREE.Points;
  private baseDirEcl: Float32Array; // ecliptic-J2000 unit dirs at J2000
  private baseDirEq: Float32Array; // equatorial unit dirs (for proper motion)
  private pm: Float32Array; // pmra*, pmdec (mas/yr) interleaved
  private count: number;

  constructor(buf: ArrayBuffer) {
    this.count = new Uint32Array(buf, 0, 1)[0];
    const f = new Float32Array(buf, 4);
    this.count = Math.min(this.count, (f.length / 7) | 0);
    const n = this.count;

    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    this.baseDirEq = new Float32Array(n * 3);
    this.baseDirEcl = new Float32Array(n * 3);
    this.pm = new Float32Array(n * 2);

    // Brightest star sets the reference flux so colours land in [0,1].
    let minMag = Infinity;
    for (let i = 0; i < n; i++) minMag = Math.min(minMag, f[i * 7 + 3]);
    const refFlux = Math.pow(10, -0.4 * minMag);

    const v = new Float64Array(3);
    for (let i = 0; i < n; i++) {
      const b = i * 7;
      this.baseDirEq[i * 3] = f[b]; this.baseDirEq[i * 3 + 1] = f[b + 1]; this.baseDirEq[i * 3 + 2] = f[b + 2];
      v[0] = f[b]; v[1] = f[b + 1]; v[2] = f[b + 2];
      eqjToEcl(v, v);
      this.baseDirEcl[i * 3] = v[0]; this.baseDirEcl[i * 3 + 1] = v[1]; this.baseDirEcl[i * 3 + 2] = v[2];
      pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2];

      const mag = f[b + 3], ci = f[b + 4];
      const [r, g, bl] = bvToRGB(ci);
      // Flux fraction, gamma-lifted so faint stars stay visible with additive.
      const flux = Math.pow(10, -0.4 * mag) / refFlux;
      const bright = Math.pow(flux, 0.35);
      col[i * 3] = r * bright; col[i * 3 + 1] = g * bright; col[i * 3 + 2] = bl * bright;
      this.pm[i * 2] = f[b + 5]; this.pm[i * 2 + 1] = f[b + 6];
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 2.0, // px; >= the 1.5px scintillation floor
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.points = new THREE.Points(geom, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = -1; // behind everything
  }

  /** Apply proper motion for `year` (Gregorian), tangent-plane, then eqj->ecl. */
  applyEpoch(year: number): void {
    const dt = year - 2000;
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const v = new Float64Array(3);
    for (let i = 0; i < this.count; i++) {
      let x = this.baseDirEq[i * 3], y = this.baseDirEq[i * 3 + 1], z = this.baseDirEq[i * 3 + 2];
      // Local east (d/dRA) and north (d/dDec) unit vectors.
      const rxy = Math.hypot(x, y) || 1e-9;
      const ex = -y / rxy, ey = x / rxy, ez = 0;
      const nx = -z * (x / rxy), ny = -z * (y / rxy), nz = rxy;
      const dEast = this.pm[i * 2] * MAS_TO_RAD * dt;
      const dNorth = this.pm[i * 2 + 1] * MAS_TO_RAD * dt;
      x += ex * dEast + nx * dNorth; y += ey * dEast + ny * dNorth; z += ez * dEast + nz * dNorth;
      const inv = 1 / Math.hypot(x, y, z);
      v[0] = x * inv; v[1] = y * inv; v[2] = z * inv;
      eqjToEcl(v, v);
      arr[i * 3] = v[0]; arr[i * 3 + 1] = v[1]; arr[i * 3 + 2] = v[2];
    }
    pos.needsUpdate = true;
  }

  /** Recentre on the camera and size to sit inside the far plane. */
  update(camera: THREE.PerspectiveCamera): void {
    this.points.position.copy(camera.position);
    this.points.scale.setScalar(Math.max(1, camera.position.length() * 4.5));
  }
}
