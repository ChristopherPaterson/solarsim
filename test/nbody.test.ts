// P3 acceptance: the full-system N-body integration (perturb-everything) must
// conserve energy over a long run (build plan §7 P3). The interactive mode uses
// IAS15 — validated to machine precision on two-body (test/ias15.test.ts) — so
// here we seed all bodies from DE440 and check total energy holds over centuries.
//
// (The plan names WHFast for this; that's a speed optimisation for Gyr-scale
// runs. IAS15 meets the accuracy bar with margin, so WHFast is deferred.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { De440 } from '../src/core/ephemeris/de440';
import { IAS15 } from '../src/core/integrate/ias15';
import { SOLAR_SYSTEM } from '../src/data/bodies';

const buf = readFileSync(new URL('../public/data/ephemeris.bin', import.meta.url));
const eph = new De440(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const ids = SOLAR_SYSTEM.map((b) => b.id);
const gm = SOLAR_SYSTEM.map((b) => b.gm);
const N = ids.length;

// Full mutual N-body acceleration (barycentric ICRF; energy is frame-agnostic).
function accel(_t: number, x: Float64Array, a: Float64Array): void {
  a.fill(0);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const dx = x[j * 3] - x[i * 3], dy = x[j * 3 + 1] - x[i * 3 + 1], dz = x[j * 3 + 2] - x[i * 3 + 2];
      const r2 = dx * dx + dy * dy + dz * dz, inv = 1 / (r2 * Math.sqrt(r2));
      a[i * 3] += gm[j] * inv * dx; a[i * 3 + 1] += gm[j] * inv * dy; a[i * 3 + 2] += gm[j] * inv * dz;
      a[j * 3] -= gm[i] * inv * dx; a[j * 3 + 1] -= gm[i] * inv * dy; a[j * 3 + 2] -= gm[i] * inv * dz;
    }
  }
}

// E' = E·G (drop the common 1/G): Σ ½ gm_i v_i² − Σ_{i<j} gm_i gm_j / r_ij.
function energy(ias: IAS15): number {
  let ke = 0, pe = 0;
  for (let i = 0; i < N; i++) {
    ke += 0.5 * gm[i] * (ias.v[i * 3] ** 2 + ias.v[i * 3 + 1] ** 2 + ias.v[i * 3 + 2] ** 2);
    for (let j = i + 1; j < N; j++) {
      const dx = ias.x[j * 3] - ias.x[i * 3], dy = ias.x[j * 3 + 1] - ias.x[i * 3 + 1], dz = ias.x[j * 3 + 2] - ias.x[i * 3 + 2];
      pe -= (gm[i] * gm[j]) / Math.hypot(dx, dy, dz);
    }
  }
  return ke + pe;
}

test('full-system N-body conserves energy over 500 years', () => {
  const ias = new IAS15(N, accel);
  const tmp = new Float64Array(6);
  for (let i = 0; i < N; i++) {
    eph.state(ids[i], 0, tmp); // J2000, barycentric ICRF (m, m/s)
    ias.x.set(tmp.subarray(0, 3), i * 3);
    ias.v.set(tmp.subarray(3, 6), i * 3);
  }
  const E0 = energy(ias);
  const span = 500 * 365.25 * 86400; // 500 years
  let t = 0, dt = 43200; // half a day to start; adaptive
  let steps = 0;
  while (t < span) {
    const h = Math.min(dt, span - t);
    dt = ias.nextDt(dt, ias.step(t, h));
    t += h; steps++;
  }
  const drift = Math.abs((energy(ias) - E0) / E0);
  console.log(`  500-yr N-body: ${steps} steps, dE/E ${drift.toExponential(2)}`);
  assert.ok(drift < 1e-10, `energy drift ${drift.toExponential(2)} over 500 yr`);
});
