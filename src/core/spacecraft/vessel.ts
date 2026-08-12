// Vessel on rails (build plan §7 P3.5 items 3-5): a heliocentric state
// propagated analytically (Kepler), plus a list of impulsive maneuver nodes.
// Each node applies a Δv in the prograde/normal/radial basis at its epoch, so
// the trajectory is a chain of Kepler arcs. Rails => warp is unlimited.

import { propagate } from '../orbital/kepler';
import { deltaVBudget, massRatio } from './propulsion';

export interface ManeuverNode {
  t: number;        // burn epoch, TDB s
  prograde: number; // Δv components, m/s, in the RTN basis at the burn state
  normal: number;
  radial: number;
}

/** Prograde/normal/radial unit vectors for a state (r, v). Radial ⟂ velocity, in-plane. */
export function rtnBasis(r: ArrayLike<number>, v: ArrayLike<number>): { P: number[]; N: number[]; R: number[] } {
  const vn = Math.hypot(v[0], v[1], v[2]) || 1;
  const P = [v[0] / vn, v[1] / vn, v[2] / vn];
  const h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
  const hn = Math.hypot(h[0], h[1], h[2]) || 1;
  const N = [h[0] / hn, h[1] / hn, h[2] / hn];
  const R = [N[1] * P[2] - N[2] * P[1], N[2] * P[0] - N[0] * P[2], N[0] * P[1] - N[1] * P[0]];
  return { P, N, R };
}

// v += Δv expressed in the (prograde, normal, radial) basis of state (r, v).
function applyDv(r: Float64Array, v: Float64Array, n: ManeuverNode): void {
  const { P, N, R } = rtnBasis(r, v);
  for (let k = 0; k < 3; k++) v[k] += n.prograde * P[k] + n.normal * N[k] + n.radial * R[k];
}

const dvMag = (n: ManeuverNode): number => Math.hypot(n.prograde, n.normal, n.radial);

export class Vessel {
  nodes: ManeuverNode[] = [];
  isp = 320;       // s
  dryMass = 1000;  // kg
  private tr = new Float64Array(3);
  private tv = new Float64Array(3);

  constructor(readonly r0: Float64Array, readonly v0: Float64Array, readonly t0: number, readonly mu: number) {}

  /** Heliocentric state at time t, applying every node before t. */
  stateAt(t: number, rOut: Float64Array, vOut: Float64Array): void {
    const ns = [...this.nodes].filter((n) => n.t < t).sort((a, b) => a.t - b.t);
    let cr = this.r0, cv = this.v0, ct = this.t0;
    for (const n of ns) {
      propagate(cr, cv, this.mu, n.t - ct, this.tr, this.tv);
      applyDv(this.tr, this.tv, n);
      cr = this.tr.slice(); cv = this.tv.slice(); ct = n.t;
    }
    propagate(cr, cv, this.mu, t - ct, rOut, vOut);
  }

  /** Sample positions (n×3, heliocentric) from `tStart` to `tEnd` along the plan. */
  sampleTrajectory(tStart: number, tEnd: number, n: number, out: Float64Array): void {
    const r = new Float64Array(3), v = new Float64Array(3);
    for (let i = 0; i < n; i++) {
      this.stateAt(tStart + (tEnd - tStart) * (i / (n - 1)), r, v);
      out[i * 3] = r[0]; out[i * 3 + 1] = r[1]; out[i * 3 + 2] = r[2];
    }
  }

  /** Total planned Δv (m/s) and the rocket-equation cost of affording it. */
  totalDeltaV(): number { return this.nodes.reduce((s, n) => s + dvMag(n), 0); }
  massRatio(): number { return massRatio(this.totalDeltaV(), this.isp); }
  /** Max Δv this vessel can afford given a propellant load (informational). */
  budget(propellantMass: number): number { return deltaVBudget(this.dryMass, propellantMass, this.isp); }
}
