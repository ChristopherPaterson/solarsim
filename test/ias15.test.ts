// IAS15 validation against the analytic two-body problem (build plan §7 P3
// acceptance: reproduce a published orbit; resolve a close periapsis a fixed
// low-order step would miss). GM=1 units: a circular orbit at r=1 has v=1 and
// period 2π. Energy E = v²/2 - GM/r and angular momentum L = r×v are exact
// invariants, so their drift is a direct, unforgiving correctness probe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IAS15 } from '../src/core/integrate/ias15';

const GM = 1;
const central: (t: number, x: Float64Array, a: Float64Array) => void = (_t, x, a) => {
  const r = Math.hypot(x[0], x[1], x[2]);
  const f = -GM / (r * r * r);
  a[0] = f * x[0]; a[1] = f * x[1]; a[2] = f * x[2];
};

function make(r0: number[], v0: number[]): IAS15 {
  const ias = new IAS15(1, central);
  ias.x.set(r0); ias.v.set(v0);
  return ias;
}
function energy(ias: IAS15): number {
  const r = Math.hypot(ias.x[0], ias.x[1], ias.x[2]);
  const v2 = ias.v[0] ** 2 + ias.v[1] ** 2 + ias.v[2] ** 2;
  return v2 / 2 - GM / r;
}
function angMom(ias: IAS15): number {
  const [x, y, z] = ias.x, [vx, vy, vz] = ias.v;
  return Math.hypot(y * vz - z * vy, z * vx - x * vz, x * vy - y * vx);
}
// Adaptive drive from t0 to t1 with independent dt evolution.
function run(ias: IAS15, t0: number, t1: number, dt0: number): void {
  let t = t0, dt = dt0;
  while (t < t1 - 1e-12) {
    const h = Math.min(dt, t1 - t);
    const err = ias.step(t, h);
    t += h;
    dt = ias.nextDt(dt, err);
  }
}

test('circular orbit returns to its start after one period', () => {
  const ias = make([1, 0, 0], [0, 1, 0]);
  run(ias, 0, 2 * Math.PI, 0.05);
  const dr = Math.hypot(ias.x[0] - 1, ias.x[1], ias.x[2]);
  const dv = Math.hypot(ias.v[0], ias.v[1] - 1, ias.v[2]);
  assert.ok(dr < 1e-9, `position closure ${dr.toExponential(2)}`);
  assert.ok(dv < 1e-9, `velocity closure ${dv.toExponential(2)}`);
});

test('eccentric orbit conserves energy + L over 1000 orbits', () => {
  // a=1, e=0.5: at apoapsis r=1.5, v=sqrt(GM(2/r-1/a)) perpendicular.
  const ra = 1.5, va = Math.sqrt(GM * (2 / ra - 1));
  const ias = make([ra, 0, 0], [0, va, 0]);
  const E0 = energy(ias), L0 = angMom(ias);
  run(ias, 0, 1000 * 2 * Math.PI, 0.05);
  const dE = Math.abs((energy(ias) - E0) / E0);
  const dL = Math.abs((angMom(ias) - L0) / L0);
  console.log(`  1000-orbit e=0.5: dE/E ${dE.toExponential(2)}  dL/L ${dL.toExponential(2)}`);
  assert.ok(dE < 1e-12, `energy drift ${dE.toExponential(2)}`);
  assert.ok(dL < 1e-12, `ang.mom drift ${dL.toExponential(2)}`);
});

test('resolves a close periapsis (e=0.95) without energy loss', () => {
  // r_peri = 0.05: a steep, fast pass a fixed step would jump over.
  const ra = 1.95, va = Math.sqrt(GM * (2 / ra - 1));
  const ias = make([ra, 0, 0], [0, va, 0]);
  const E0 = energy(ias);
  run(ias, 0, 50 * 2 * Math.PI, 0.02);
  const dE = Math.abs((energy(ias) - E0) / E0);
  console.log(`  50-orbit e=0.95: dE/E ${dE.toExponential(2)}`);
  assert.ok(dE < 1e-10, `energy drift through periapsis ${dE.toExponential(2)}`);
});
