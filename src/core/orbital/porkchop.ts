// Porkchop grid (build plan §7 P3.5 item 10): one Lambert solve per
// departure×arrival cell, coloured by C3 (departure energy) or total Δv.
// Embarrassingly parallel; 200×200 = 40k solves must compute well under 2 s.

import { lambert } from './lambert';

export interface Ephem { r: Float64Array; v: Float64Array; } // at a given epoch
export type StateAt = (t: number) => Ephem; // barycentric/primary-centred state

export interface Porkchop {
  n: number; m: number;
  c3: Float64Array;      // departure C3 = |v∞_dep|² (km²/s² if inputs are km-based)
  dvTotal: Float64Array; // |Δv_dep| + |Δv_arr|
}

/**
 * Grid Lambert transfers from `dep` to `arr`. `depT[i]` × `arrT[j]` (seconds),
 * cells with arr<=dep or a non-finite solve are NaN. C3 uses the departure body's
 * velocity; total Δv adds the arrival match. Units follow the inputs' (mu, r, v).
 */
export function porkchop(dep: StateAt, arr: StateAt, mu: number, depT: number[], arrT: number[]): Porkchop {
  const n = depT.length, m = arrT.length;
  const c3 = new Float64Array(n * m), dvTotal = new Float64Array(n * m);
  const depStates = depT.map(dep), arrStates = arrT.map(arr); // evaluate ephemeris once per axis
  for (let i = 0; i < n; i++) {
    const d = depStates[i];
    for (let j = 0; j < m; j++) {
      const tof = arrT[j] - depT[i];
      const idx = i * m + j;
      if (tof <= 0) { c3[idx] = NaN; dvTotal[idx] = NaN; continue; }
      const a = arrStates[j];
      const { v1, v2 } = lambert(d.r, a.r, tof, mu, true);
      const dvx = v1[0] - d.v[0], dvy = v1[1] - d.v[1], dvz = v1[2] - d.v[2];
      const c3v = dvx * dvx + dvy * dvy + dvz * dvz;
      const arrDv = Math.hypot(v2[0] - a.v[0], v2[1] - a.v[1], v2[2] - a.v[2]);
      c3[idx] = c3v;
      dvTotal[idx] = Math.sqrt(c3v) + arrDv;
    }
  }
  return { n, m, c3, dvTotal };
}
