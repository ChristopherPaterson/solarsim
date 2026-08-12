// Universal Kepler propagator validation (build plan §7 P3.5). GM=1 units.
// Three independent probes: exact round-trip (+dt then −dt), period closure for
// a bound orbit, and agreement with the machine-precision IAS15 integrator for
// both an ellipse and a hyperbola — one propagator, every conic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propagate, stumpffC, stumpffS } from '../src/core/orbital/kepler';
import { IAS15 } from '../src/core/integrate/ias15';

const MU = 1;
const r = new Float64Array(3), v = new Float64Array(3);

test('Stumpff functions hit their z=0 limits', () => {
  assert.ok(Math.abs(stumpffC(0) - 0.5) < 1e-12);
  assert.ok(Math.abs(stumpffS(0) - 1 / 6) < 1e-12);
  // Elliptic z>0: C(z)=(1−cos√z)/z. Check a concrete value (z=π² -> C=2/π²).
  assert.ok(Math.abs(stumpffC(Math.PI * Math.PI) - 2 / (Math.PI * Math.PI)) < 1e-12);
});

test('round-trip +dt then -dt returns to the start (ellipse + hyperbola)', () => {
  for (const v0 of [[0, 1.1, 0], [0, 1.6, 0]]) { // bound, then unbound (v²>2/r)
    const r0 = [1, 0, 0];
    assert.ok(propagate(r0, v0, MU, 2.3, r, v));
    assert.ok(propagate(r, v, MU, -2.3, r, v));
    assert.ok(Math.hypot(r[0] - 1, r[1], r[2]) < 1e-9, `pos closure ${v0}`);
    assert.ok(Math.hypot(v[0] - v0[0], v[1] - v0[1], v[2] - v0[2]) < 1e-9, `vel closure ${v0}`);
  }
});

test('one full period returns a bound orbit to its start', () => {
  const r0 = [1, 0, 0], v0 = [0, 1.1, 0];
  const a = 1 / (2 / 1 - 1.21); // vis-viva: 1/a = 2/r - v²
  const T = 2 * Math.PI * Math.sqrt(a * a * a / MU);
  assert.ok(propagate(r0, v0, MU, T, r, v));
  assert.ok(Math.hypot(r[0] - 1, r[1], r[2]) < 1e-8, 'period position closure');
});

test('agrees with IAS15 for an ellipse and a hyperbola', () => {
  for (const v0 of [[0, 1.15, 0], [0, 1.5, 0]]) {
    const ias = new IAS15(1, (_t, x, a) => {
      const rm = Math.hypot(x[0], x[1], x[2]), f = -MU / (rm * rm * rm);
      a[0] = f * x[0]; a[1] = f * x[1]; a[2] = f * x[2];
    });
    ias.x.set([1, 0, 0]); ias.v.set(v0);
    let t = 0, dt = 0.02; const T = 1.7;
    while (t < T) { const h = Math.min(dt, T - t); dt = ias.nextDt(dt, ias.step(t, h)); t += h; }
    assert.ok(propagate([1, 0, 0], v0, MU, T, r, v));
    const dpos = Math.hypot(r[0] - ias.x[0], r[1] - ias.x[1], r[2] - ias.x[2]);
    console.log(`  Kepler vs IAS15 (v0=${v0[1]}): ${dpos.toExponential(2)}`);
    assert.ok(dpos < 1e-10, `Kepler-IAS15 mismatch ${dpos.toExponential(2)}`);
  }
});
