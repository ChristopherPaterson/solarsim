// Propulsion maths surfaced honestly (build plan §7 P3.5 items 3, 11, 12): the
// rocket equation and the constant-acceleration "torch" regime. These make the
// sim tell users their fictional drive is impossible until they dial Isp up —
// which is the point.

import { G0 } from '../units';

/** Δv a vessel can produce: Tsiolkovsky, Δv = Isp·g₀·ln(m₀/m_f). */
export function deltaVBudget(dryMass: number, propellantMass: number, isp: number): number {
  return isp * G0 * Math.log((dryMass + propellantMass) / dryMass);
}

/** Mass ratio m₀/m_f required for a given Δv. Surfaced next to Δv in the UI. */
export function massRatio(deltaV: number, isp: number): number {
  return Math.exp(deltaV / (isp * G0));
}

/** Propellant mass to give `dryMass` a Δv at `isp` — grows exponentially. */
export function requiredPropellant(dryMass: number, deltaV: number, isp: number): number {
  return dryMass * (massRatio(deltaV, isp) - 1);
}

// --- Torch regime: constant proper acceleration `a`, flip-and-burn over `d` ---
// Classical (non-relativistic) closed form (build plan §7 P3.5 item 11).
export const torchTime = (distance: number, accel: number): number => 2 * Math.sqrt(distance / accel);
export const torchDeltaV = (distance: number, accel: number): number => 2 * Math.sqrt(distance * accel);
export const torchPeakV = (distance: number, accel: number): number => Math.sqrt(distance * accel);
