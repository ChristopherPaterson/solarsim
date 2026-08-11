import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Astro from 'astronomy-engine';

import { createSharedState, publish, readLatest, N_SLOTS, slotFloats, CTRL_LATEST } from '../src/sim/protocol';
import { AU_M } from '../src/core/units';
import { eqjToEcl } from '../src/core/frames';

test('ring buffer: read gets the latest published state', () => {
  const nBodies = 3;
  const s = createSharedState(nBodies);
  const ctrl = new Int32Array(s.control);
  const data = new Float64Array(s.data);
  const out = new Float64Array(nBodies * 6);

  const stateA = Float64Array.from({ length: nBodies * 6 }, (_, i) => i);
  publish(ctrl, data, nBodies, 100, stateA);
  let tdb = readLatest(ctrl, data, nBodies, out);
  assert.equal(tdb, 100);
  assert.deepEqual([...out], [...stateA]);

  const stateB = Float64Array.from({ length: nBodies * 6 }, (_, i) => i * 10);
  publish(ctrl, data, nBodies, 200, stateB);
  tdb = readLatest(ctrl, data, nBodies, out);
  assert.equal(tdb, 200);
  assert.deepEqual([...out], [...stateB]);
});

test('ring buffer: producer never writes the slot just published (triple buffer)', () => {
  const nBodies = 1;
  const s = createSharedState(nBodies);
  const ctrl = new Int32Array(s.control);
  const data = new Float64Array(s.data);
  const st = new Float64Array(6);
  const written: number[] = [];
  for (let i = 0; i < 10; i++) written.push(publish(ctrl, data, nBodies, i, st));
  for (let i = 1; i < written.length; i++) {
    assert.notEqual(written[i], written[i - 1], 'consecutive writes must use different slots');
    assert.ok(written[i] >= 0 && written[i] < N_SLOTS);
  }
  assert.equal(Atomics.load(ctrl, CTRL_LATEST), written[written.length - 1]);
});

test('data buffer is sized for N_SLOTS slots', () => {
  const s = createSharedState(9);
  assert.equal(new Float64Array(s.data).length, N_SLOTS * slotFloats(9));
});

test('barycentric->ecliptic: Earth sits ~0 in ecliptic z (frame rotation applied)', () => {
  const date = new Date('2026-08-11T00:00:00Z');
  const eq = Astro.BaryState(Astro.Body.Earth, date);
  const v = new Float64Array([eq.x * AU_M, eq.y * AU_M, eq.z * AU_M]);
  const rEq = Math.hypot(v[0], v[1], v[2]);
  eqjToEcl(v, v);
  const rEcl = Math.hypot(v[0], v[1], v[2]);
  assert.ok(Math.abs(rEcl - rEq) / rEq < 1e-12, 'rotation must preserve length');
  // Earth's orbital plane ~ the ecliptic, so |z_ecl| should be a tiny fraction
  // of r. Without the rotation it would be ~sin(23.4°)*|y_eq| ~ 0.4 AU.
  assert.ok(Math.abs(v[2]) / rEcl < 0.001, `ecliptic |z|/r = ${(Math.abs(v[2]) / rEcl).toExponential(2)}`);
  // Sanity: Earth ~1 AU from the barycentre.
  assert.ok(Math.abs(rEcl / AU_M - 1) < 0.02, `Earth r = ${(rEcl / AU_M).toFixed(4)} AU`);
});
