// Torch/brachistochrone intercept (build plan §7 P3.5 items 11-12).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { torchIntercept, ispForDeltaV } from '../src/core/spacecraft/torch';
import { propagate } from '../src/core/orbital/kepler';
import { AU_M, G0 } from '../src/core/units';

const MU = 1.32712440018e20;

test('1-g Earth->Mars torch: days, not months, and a self-consistent intercept', () => {
  const earth = new Float64Array([AU_M, 0, 0]);
  const vE = Math.sqrt(MU / AU_M);
  const marsR = new Float64Array([0, 1.523679 * AU_M, 0]); // 90° ahead
  const vM = Math.sqrt(MU / (1.523679 * AU_M));
  const marsV = new Float64Array([-vM, 0, 0]);
  const plan = torchIntercept(earth, marsR, marsV, MU, G0);
  console.log(`  Earth->Mars @1g: ${(plan.tof / 86400).toFixed(1)} d, peak ${(plan.peakV / 1000).toFixed(0)} km/s, Δv ${(plan.deltaV / 1000).toFixed(0)} km/s`);
  assert.ok(plan.tof / 86400 > 1 && plan.tof / 86400 < 6, `tof ${(plan.tof / 86400).toFixed(1)} d`);
  // Intercept must be where Mars actually is at arrival (fixed point of the iteration).
  const r = new Float64Array(3), v = new Float64Array(3);
  propagate(marsR, marsV, MU, plan.tof, r, v);
  assert.ok(Math.hypot(r[0] - plan.intercept[0], r[1] - plan.intercept[1], r[2] - plan.intercept[2]) < 1e-3, 'intercept consistent');
});

test('honest physics: a 1-g Earth->Jupiter torch needs an absurd Isp', () => {
  const earth = new Float64Array([AU_M, 0, 0]);
  const jupR = new Float64Array([0, 5.2 * AU_M, 0]);
  const vJ = Math.sqrt(MU / (5.2 * AU_M));
  const plan = torchIntercept(earth, jupR, new Float64Array([-vJ, 0, 0]), MU, G0);
  const isp = ispForDeltaV(plan.deltaV, 3); // Isp needed at mass ratio 3
  console.log(`  Earth->Jupiter @1g: ${(plan.tof / 86400).toFixed(1)} d, needs Isp ${(isp / 1000).toFixed(0)}k s (chemical is 0.45k)`);
  assert.ok(isp > 1e5, `required Isp ${isp.toExponential(2)} s should dwarf chemical`);
});
