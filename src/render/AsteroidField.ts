// P4 asteroid belt: ~100k bodies, one draw call, zero per-frame CPU. Each point
// carries its Keplerian elements as vertex attributes; a TSL vertex shader solves
// Kepler's equation (3 Newton steps) from a time uniform and places the body in
// heliocentric ecliptic-J2000, offset by the Sun each frame. Build plan §7 P4.

import * as THREE from 'three/webgpu';
import { attribute, uniform, float, vec3, sin, cos, sqrt, round, step, mix } from 'three/tsl';

const GM_SUN = 1.32712440018e20;
const TWO_PI = 6.283185307179586;
const AU = 1.495978707e11;

export class AsteroidField {
  readonly points: THREE.Points;
  readonly count: number;
  readonly uTime = uniform(0);
  readonly uSunOffset = uniform(new THREE.Vector3());

  constructor(buffer: ArrayBuffer) {
    const dv = new DataView(buffer);
    const n = dv.getUint32(0, true);
    this.count = n;
    const A = new Float32Array(n), E = new Float32Array(n), I = new Float32Array(n);
    const OM = new Float32Array(n), W = new Float32Array(n), M0 = new Float32Array(n), EP = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = 4 + i * 28;
      A[i] = dv.getFloat32(o, true); E[i] = dv.getFloat32(o + 4, true); I[i] = dv.getFloat32(o + 8, true);
      OM[i] = dv.getFloat32(o + 12, true); W[i] = dv.getFloat32(o + 16, true); M0[i] = dv.getFloat32(o + 20, true); EP[i] = dv.getFloat32(o + 24, true);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); // count only; real pos from the node
    const set = (name: string, arr: Float32Array) => g.setAttribute(name, new THREE.BufferAttribute(arr, 1));
    set('aA', A); set('aE', E); set('aI', I); set('aOm', OM); set('aW', W); set('aM0', M0); set('aEp', EP);
    g.setDrawRange(0, n);

    // --- TSL: position = R(Ω,i,ω)·perifocal(E) + Sun offset ---
    // Cast attributes to the fluent float-node type (TSL's TS types don't infer it).
    const attr = (name: string) => attribute(name) as unknown as ReturnType<typeof float>;
    const aA = attr('aA'), aE = attr('aE'), aI = attr('aI');
    const aOm = attr('aOm'), aW = attr('aW'), aM0 = attr('aM0'), aEp = attr('aEp');
    const nMean = sqrt(float(GM_SUN).div(aA.mul(aA).mul(aA)));
    let M = aM0.add(nMean.mul(this.uTime.sub(aEp)));
    M = M.sub(round(M.div(TWO_PI)).mul(TWO_PI)); // wrap to [-π,π] for Newton convergence
    let Ecc = M.add(aE.mul(sin(M))); // starter
    for (let k = 0; k < 3; k++) Ecc = Ecc.sub(Ecc.sub(aE.mul(sin(Ecc))).sub(M).div(float(1).sub(aE.mul(cos(Ecc)))));
    const cE = cos(Ecc), sE = sin(Ecc);
    const xpf = aA.mul(cE.sub(aE));                          // perifocal x
    const ypf = aA.mul(sqrt(float(1).sub(aE.mul(aE)))).mul(sE); // perifocal y
    const cw = cos(aW), sw = sin(aW), ci = cos(aI), si = sin(aI), cO = cos(aOm), sO = sin(aOm);
    const R11 = cO.mul(cw).sub(sO.mul(sw).mul(ci)), R12 = cO.mul(sw).negate().sub(sO.mul(cw).mul(ci));
    const R21 = sO.mul(cw).add(cO.mul(sw).mul(ci)), R22 = sO.mul(sw).negate().add(cO.mul(cw).mul(ci));
    const R31 = sw.mul(si), R32 = cw.mul(si);
    const pos = vec3(
      R11.mul(xpf).add(R12.mul(ypf)),
      R21.mul(xpf).add(R22.mul(ypf)),
      R31.mul(xpf).add(R32.mul(ypf)),
    ).add(this.uSunOffset);

    const mat = new THREE.PointsNodeMaterial({ transparent: true, opacity: 0.9, depthTest: true });
    mat.positionNode = pos;
    // Colour by orbital family so the Jupiter Trojans (a ≈ 5.05–5.35 AU) stand out
    // as two gold lobes against the tan main belt.
    const isTrojan = step(float(5.0 * AU), aA).mul(step(aA, float(5.4 * AU)));
    mat.colorNode = mix(vec3(0.70, 0.65, 0.55), vec3(1.0, 0.78, 0.28), isTrojan);
    mat.sizeNode = float(1.6); // fixed pixel size
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  /** Draw only the brightest `n` (data is sorted brightest-first). */
  setDrawCount(n: number): void { this.points.geometry.setDrawRange(0, Math.max(0, Math.min(this.count, n))); }
  setVisible(on: boolean): void { this.points.visible = on; }
}
