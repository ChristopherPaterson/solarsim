// Universal-variable Kepler propagator (build plan §7 P3.5, item 1). One
// analytic propagator for every conic — ellipse, parabola, hyperbola — via the
// universal anomaly χ and Stumpff functions C(z), S(z). Everything on-rails
// (vessels, inserted bodies on escape trajectories) depends on this.
//
// Reference: Vallado, "Fundamentals of Astrodynamics and Applications", and
// Curtis, "Orbital Mechanics for Engineering Students", Alg. 3.4.

/** Stumpff C(z) = (1-cos√z)/z for z>0, (cosh√-z −1)/(−z) for z<0, ½ at 0. */
export function stumpffC(z: number): number {
  if (z > 1e-12) { const s = Math.sqrt(z); return (1 - Math.cos(s)) / z; }
  if (z < -1e-12) { const s = Math.sqrt(-z); return (Math.cosh(s) - 1) / -z; }
  return 0.5 - z / 24; // series near 0 (keeps precision through the parabolic case)
}

/** Stumpff S(z) = (√z−sin√z)/√z³ for z>0, (sinh√−z−√−z)/√−z³ for z<0, ⅙ at 0. */
export function stumpffS(z: number): number {
  if (z > 1e-12) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
  if (z < -1e-12) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
  return 1 / 6 - z / 120;
}

/**
 * Propagate a state (r0, v0) under a point mass `mu` for time `dt` (any sign).
 * Writes the new position into `rOut` and velocity into `vOut`. Returns false if
 * the universal Kepler equation failed to converge.
 */
export function propagate(
  r0: Float64Array | number[], v0: Float64Array | number[], mu: number, dt: number,
  rOut: Float64Array, vOut: Float64Array,
): boolean {
  // Snapshot inputs so the call is alias-safe (rOut/vOut may be r0/v0).
  const r0x = r0[0], r0y = r0[1], r0z = r0[2], v0x = v0[0], v0y = v0[1], v0z = v0[2];
  const r0m = Math.hypot(r0x, r0y, r0z);
  const v0m2 = v0x * v0x + v0y * v0y + v0z * v0z;
  const vr0 = (r0x * v0x + r0y * v0y + r0z * v0z) / r0m;
  const sqrtMu = Math.sqrt(mu);
  const alpha = 2 / r0m - v0m2 / mu; // 1/a: >0 ellipse, <0 hyperbola, ~0 parabola

  // Initial guess for the universal anomaly χ (Curtis 3.66).
  let chi = sqrtMu * Math.abs(alpha) * dt;
  if (Math.abs(alpha) < 1e-12) chi = sqrtMu * dt / r0m; // near-parabolic seed

  // Laguerre-Conway (n=5) rather than plain Newton: its far wider convergence
  // basin handles near-parabolic orbits (e→1, α→0) and large dt, where Newton
  // from this seed diverges intermittently (the "ghost comet" flicker).
  const A = (r0m * vr0) / sqrtMu, B = 1 - alpha * r0m, N = 5;
  let converged = false;
  for (let i = 0; i < 60; i++) {
    const z = alpha * chi * chi;
    const C = stumpffC(z), S = stumpffS(z);
    const chi2 = chi * chi;
    const F = A * chi2 * C + B * chi2 * chi * S + r0m * chi - sqrtMu * dt;
    const dF = A * chi * (1 - z * S) + B * chi2 * C + r0m;                 // F'
    const ddF = A * (1 - z * C) + B * chi * (1 - z * S);                   // F''
    const disc = Math.sqrt(Math.abs((N - 1) * (N - 1) * dF * dF - N * (N - 1) * F * ddF));
    const denom = dF >= 0 ? dF + disc : dF - disc; // pick the larger-magnitude denominator
    const dchi = denom !== 0 ? (N * F) / denom : F / (dF || 1);
    chi -= dchi;
    if (Math.abs(dchi) < 1e-8 * (1 + Math.abs(chi))) { converged = true; break; }
  }
  if (!converged) return false;

  const z = alpha * chi * chi;
  const C = stumpffC(z), S = stumpffS(z);
  // Lagrange coefficients (Curtis 3.69).
  const f = 1 - (chi * chi / r0m) * C;
  const g = dt - (chi * chi * chi / sqrtMu) * S;
  const rx = f * r0x + g * v0x, ry = f * r0y + g * v0y, rz = f * r0z + g * v0z;
  const rm = Math.hypot(rx, ry, rz);
  const fd = (sqrtMu / (rm * r0m)) * (alpha * chi * chi * chi * S - chi);
  const gd = 1 - (chi * chi / rm) * C;
  rOut[0] = rx; rOut[1] = ry; rOut[2] = rz;
  vOut[0] = fd * r0x + gd * v0x;
  vOut[1] = fd * r0y + gd * v0y;
  vOut[2] = fd * r0z + gd * v0z;
  return true;
}
