// Izzo Lambert validation (build plan §7 P3.5). Two probes: a published worked
// example (Curtis, "Orbital Mechanics", Example 5.2) and the acceptance —
// a Hohmann transfer to Mars whose Δv matches the textbook value within 1%.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lambert } from '../src/core/orbital/lambert';
import { propagate } from '../src/core/orbital/kepler';
import { AU_M } from '../src/core/units';

test('Lambert matches Curtis Example 5.2', () => {
  const mu = 398600; // km³/s²
  const r1 = new Float64Array([5000, 10000, 2100]);
  const r2 = new Float64Array([-14600, 2500, 7000]);
  const { v1, v2 } = lambert(r1, r2, 3600, mu, true);
  // Published: v1=(-5.9925, 1.9254, 3.2456), v2=(-3.3125, -4.1966, -0.38529) km/s.
  const e1 = Math.hypot(v1[0] + 5.9925, v1[1] - 1.9254, v1[2] - 3.2456);
  const e2 = Math.hypot(v2[0] + 3.3125, v2[1] + 4.1966, v2[2] + 0.38529);
  console.log(`  Curtis 5.2: v1 err ${e1.toExponential(2)}  v2 err ${e2.toExponential(2)} km/s`);
  assert.ok(e1 < 1e-3 && e2 < 1e-3, `v1 ${e1.toExponential(2)} v2 ${e2.toExponential(2)}`);
  // Consistency: propagating r1,v1 for the tof must land on r2.
  const rp = new Float64Array(3), vp = new Float64Array(3);
  propagate(r1, v1, mu, 3600, rp, vp);
  assert.ok(Math.hypot(rp[0] - r2[0], rp[1] - r2[1], rp[2] - r2[2]) < 1e-6, 'propagate lands on r2');
});

test('Hohmann to Mars: Lambert Δv matches published ~5.6 km/s within 1%', () => {
  const mu = 1.32712440018e20; // Sun, m³/s²
  const rE = AU_M, rM = 1.523679 * AU_M;
  // Near-180° coplanar transfer (a hair off to keep the transfer plane defined).
  const th = Math.PI * (1 - 1e-3);
  const r1 = new Float64Array([rE, 0, 0]);
  const r2 = new Float64Array([rM * Math.cos(th), rM * Math.sin(th), 0]);
  const aT = (rE + rM) / 2;
  const tof = Math.PI * Math.sqrt((aT * aT * aT) / mu); // half the transfer ellipse period
  const { v1, v2 } = lambert(r1, r2, tof, mu, true);
  // Circular planet velocities (prograde) at r1 and r2.
  const vE = Math.sqrt(mu / rE), vM = Math.sqrt(mu / rM);
  const dvDep = Math.hypot(v1[0] - 0, v1[1] - vE, v1[2]);
  const vMvec = [-vM * Math.sin(th), vM * Math.cos(th), 0];
  const dvArr = Math.hypot(v2[0] - vMvec[0], v2[1] - vMvec[1], v2[2] - vMvec[2]);
  const total = (dvDep + dvArr) / 1000;
  console.log(`  Hohmann->Mars: dep ${(dvDep / 1000).toFixed(3)} + arr ${(dvArr / 1000).toFixed(3)} = ${total.toFixed(3)} km/s`);
  assert.ok(Math.abs(total - 5.59) / 5.59 < 0.01, `total Δv ${total.toFixed(3)} km/s vs 5.59 (>1%)`);
});
