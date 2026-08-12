// Torch / brachistochrone flights (build plan §7 P3.5 items 11-12): a
// constant-acceleration "flip and burn" straight to a moving target. At high g
// gravity is a rounding error, so the path is ~a straight line to where the
// target *will be*; we solve that intercept by iterating the target on rails.

import { propagate } from '../orbital/kepler';
import { torchTime, torchDeltaV, torchPeakV } from './propulsion';
import { G0 } from '../units';

export interface TorchPlan {
  intercept: Float64Array; // target position at arrival (heliocentric m)
  tof: number;             // transit time, s
  dist: number;            // straight-line distance, m
  peakV: number;           // mid-flight speed, m/s
  deltaV: number;          // total flip-and-burn Δv, m/s
}

/** Solve the constant-accel intercept of a target propagated on rails. */
export function torchIntercept(r0: ArrayLike<number>, targetR: Float64Array, targetV: Float64Array, mu: number, accel: number): TorchPlan {
  const tr = new Float64Array(3), tv = new Float64Array(3), intercept = new Float64Array(3);
  let d = Math.hypot(targetR[0] - r0[0], targetR[1] - r0[1], targetR[2] - r0[2]);
  let tof = torchTime(d, accel);
  for (let i = 0; i < 6; i++) {
    propagate(targetR, targetV, mu, tof, tr, tv); // where the target has moved to
    tof = torchTime(Math.hypot(tr[0] - r0[0], tr[1] - r0[1], tr[2] - r0[2]), accel);
  }
  propagate(targetR, targetV, mu, tof, intercept, tv); // intercept at the final tof
  d = Math.hypot(intercept[0] - r0[0], intercept[1] - r0[1], intercept[2] - r0[2]);
  return { intercept, tof, dist: d, peakV: torchPeakV(d, accel), deltaV: torchDeltaV(d, accel) };
}

/** Isp needed to afford `deltaV` at mass ratio `ratio` — the honest cost. */
export const ispForDeltaV = (deltaV: number, ratio: number): number => deltaV / (G0 * Math.log(ratio));

// Reference specific impulses (s), so the UI can name the drive class required.
export const DRIVES: [string, number][] = [
  ['chemical', 450], ['nuclear-thermal', 900], ['ion', 3000],
  ['fusion torch', 1_000_000], ['antimatter', 10_000_000],
];
