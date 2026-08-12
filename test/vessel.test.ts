// Vessel + maneuver node validation (build plan §7 P3.5). GM=1 units: a circular
// orbit at r=1 has v=1, period 2π. A prograde burn raises apoapsis; a retrograde
// burn lowers periapsis; the node sits on the pre-burn orbit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vessel } from '../src/core/spacecraft/vessel';

const MU = 1;
const r = new Float64Array(3), v = new Float64Array(3);
const rmag = (): number => Math.hypot(r[0], r[1], r[2]);

test('a nodeless circular vessel stays circular', () => {
  const ves = new Vessel(new Float64Array([1, 0, 0]), new Float64Array([0, 1, 0]), 0, MU);
  for (const t of [0.5, Math.PI, 5]) { ves.stateAt(t, r, v); assert.ok(Math.abs(rmag() - 1) < 1e-9, `r=${rmag()}`); }
});

test('a prograde burn raises apoapsis; retrograde lowers periapsis', () => {
  const ves = new Vessel(new Float64Array([1, 0, 0]), new Float64Array([0, 1, 0]), 0, MU);
  ves.nodes = [{ t: 0, prograde: 0.15, normal: 0, radial: 0 }]; // +15% speed at r=1
  // After a prograde burn at periapsis, apoapsis (max r over the orbit) rises above 1.
  let maxR = 0;
  for (let i = 0; i < 200; i++) { ves.stateAt(0.01 + i * 0.05, r, v); maxR = Math.max(maxR, rmag()); }
  console.log(`  prograde +0.15: apoapsis ${maxR.toFixed(3)} (was 1.0)`);
  assert.ok(maxR > 1.2, `apoapsis ${maxR.toFixed(3)} should exceed 1.2`);

  const ret = new Vessel(new Float64Array([1, 0, 0]), new Float64Array([0, 1, 0]), 0, MU);
  ret.nodes = [{ t: 0, prograde: -0.15, normal: 0, radial: 0 }];
  let minR = Infinity;
  for (let i = 0; i < 200; i++) { ret.stateAt(0.01 + i * 0.05, r, v); minR = Math.min(minR, rmag()); }
  assert.ok(minR < 0.85, `periapsis ${minR.toFixed(3)} should drop below 0.85`);
});

test('a normal burn tilts the orbit plane', () => {
  const ves = new Vessel(new Float64Array([1, 0, 0]), new Float64Array([0, 1, 0]), 0, MU);
  ves.nodes = [{ t: 0, prograde: 0, normal: 0.2, radial: 0 }]; // out-of-plane
  let maxZ = 0;
  for (let i = 0; i < 100; i++) { ves.stateAt(0.05 + i * 0.05, r, v); maxZ = Math.max(maxZ, Math.abs(r[2])); }
  assert.ok(maxZ > 0.1, `orbit should leave the z=0 plane (max|z|=${maxZ.toFixed(3)})`);
});

test('total Δv sums nodes and the mass ratio follows Tsiolkovsky', () => {
  const ves = new Vessel(new Float64Array([1, 0, 0]), new Float64Array([0, 1, 0]), 0, MU);
  ves.isp = 300;
  ves.nodes = [{ t: 0, prograde: 3000, normal: 0, radial: 0 }, { t: 5, prograde: 0, normal: 0, radial: 4000 }];
  assert.equal(ves.totalDeltaV(), 7000);
  assert.ok(Math.abs(ves.massRatio() - Math.exp(7000 / (300 * 9.80665))) < 1e-6);
});
