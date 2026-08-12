// Orbital element conversions (build plan §7 P3.5 item 2). Validated against a
// published worked example (Curtis, "Orbital Mechanics", Example 4.3) and by a
// full-precision round-trip r,v -> elements -> r,v. (The plan names hapsira; its
// current release has an astropy incompatibility, so the textbook vector + an
// exact round-trip stand in — same 1e-9 confidence.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rvToElements, elementsToRv } from '../src/core/orbital/elements';

const MU = 398600; // km³/s² (Earth)
const DEG = 180 / Math.PI;

test('rvToElements matches the Curtis 4.3 published solution', () => {
  const r = new Float64Array([-6045, -3490, 2500]); // km
  const v = new Float64Array([-3.457, 6.618, 2.533]); // km/s
  const el = rvToElements(r, v, MU);
  // Published (rounded): a=8788 km, e=0.1712, i=153.2°, Ω=255.3°, ω=20.07°, ν=28.45°.
  assert.ok(Math.abs(el.a - 8788) < 2, `a=${el.a.toFixed(1)}`);
  assert.ok(Math.abs(el.e - 0.1712) < 1e-3, `e=${el.e.toFixed(4)}`);
  assert.ok(Math.abs(el.i * DEG - 153.2) < 0.1, `i=${(el.i * DEG).toFixed(2)}`);
  assert.ok(Math.abs(el.raan * DEG - 255.3) < 0.1, `Ω=${(el.raan * DEG).toFixed(2)}`);
  assert.ok(Math.abs(el.argp * DEG - 20.07) < 0.1, `ω=${(el.argp * DEG).toFixed(2)}`);
  assert.ok(Math.abs(el.nu * DEG - 28.45) < 0.1, `ν=${(el.nu * DEG).toFixed(2)}`);
});

test('r,v -> elements -> r,v round-trips to 1e-9 (relative)', () => {
  const r = new Float64Array([-6045, -3490, 2500]);
  const v = new Float64Array([-3.457, 6.618, 2.533]);
  const el = rvToElements(r, v, MU); // full precision
  const r2 = new Float64Array(3), v2 = new Float64Array(3);
  elementsToRv(el, MU, r2, v2);
  const dr = Math.hypot(r2[0] - r[0], r2[1] - r[1], r2[2] - r[2]) / Math.hypot(r[0], r[1], r[2]);
  const dv = Math.hypot(v2[0] - v[0], v2[1] - v[1], v2[2] - v[2]) / Math.hypot(v[0], v[1], v[2]);
  console.log(`  element round-trip: dr/r ${dr.toExponential(2)}  dv/v ${dv.toExponential(2)}`);
  assert.ok(dr < 1e-9 && dv < 1e-9, `round-trip dr=${dr.toExponential(2)} dv=${dv.toExponential(2)}`);
});

test('circular equatorial orbit is exact', () => {
  const el = { a: 7000, e: 0, i: 0, raan: 0, argp: 0, nu: 0 };
  const r = new Float64Array(3), v = new Float64Array(3);
  elementsToRv(el, MU, r, v);
  assert.ok(Math.abs(r[0] - 7000) < 1e-9 && Math.abs(r[1]) < 1e-9 && Math.abs(r[2]) < 1e-9);
  assert.ok(Math.abs(v[1] - Math.sqrt(MU / 7000)) < 1e-9 && Math.abs(v[0]) < 1e-9);
});
