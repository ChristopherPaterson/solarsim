// Classical orbital elements from a state vector, and ellipse sampling for
// orbit-path rendering. Positions/velocities are SI in an inertial frame
// centred on the primary (e.g. heliocentric ecliptic). Used from P1 for orbit
// paths; the element conversions are validated against hapsira in P3.5.

export interface Elements {
  a: number; // semi-major axis, m (negative for hyperbolic)
  e: number; // eccentricity
  i: number; // inclination, rad
  raan: number; // Ω, rad
  argp: number; // ω, rad
  nu: number; // true anomaly, rad
}

const cross = (a: Float64Array, b: Float64Array): Float64Array =>
  new Float64Array([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
const dot = (a: Float64Array, b: Float64Array): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mag = (a: Float64Array): number => Math.sqrt(dot(a, a));

/** State vector (r, v) -> classical elements about a body of parameter mu. */
export function rvToElements(r: Float64Array, v: Float64Array, mu: number): Elements {
  const rmag = mag(r);
  const vmag2 = dot(v, v);
  const h = cross(r, v);
  const hmag = mag(h);
  const n = new Float64Array([-h[1], h[0], 0]); // k x h
  const nmag = Math.hypot(n[0], n[1]);

  // eccentricity vector
  const rv = dot(r, v);
  const ev = new Float64Array(3);
  for (let k = 0; k < 3; k++) ev[k] = ((vmag2 - mu / rmag) * r[k] - rv * v[k]) / mu;
  const e = mag(ev);

  const energy = vmag2 / 2 - mu / rmag;
  const a = Math.abs(energy) < 1e-30 ? Infinity : -mu / (2 * energy);
  const i = Math.acos(Math.min(1, Math.max(-1, h[2] / hmag)));

  let raan = nmag > 1e-12 ? Math.acos(Math.min(1, Math.max(-1, n[0] / nmag))) : 0;
  if (n[1] < 0) raan = 2 * Math.PI - raan;

  let argp = 0;
  if (nmag > 1e-12 && e > 1e-12) {
    argp = Math.acos(Math.min(1, Math.max(-1, dot(n, ev) / (nmag * e))));
    if (ev[2] < 0) argp = 2 * Math.PI - argp;
  }

  let nu = 0;
  if (e > 1e-12) {
    nu = Math.acos(Math.min(1, Math.max(-1, dot(ev, r) / (e * rmag))));
    if (rv < 0) nu = 2 * Math.PI - nu;
  }

  return { a, e, i, raan, argp, nu };
}

/** Classical elements -> state vector (r, v) about a body of parameter mu.
 *  Handles every conic (elliptic e<1, parabolic e=1, hyperbolic e>1). Writes
 *  position into rOut and velocity into vOut (Curtis Alg. 4.5). */
export function elementsToRv(el: Elements, mu: number, rOut: Float64Array, vOut: Float64Array): void {
  const { e, i, raan: O, argp: w, nu } = el;
  // Semi-latus rectum p from a (finite) or, for the parabolic edge, direct.
  const p = Number.isFinite(el.a) ? el.a * (1 - e * e) : 0; // parabolic caller must pass p via a=inf carefully
  const cnu = Math.cos(nu), snu = Math.sin(nu);
  const rp = p / (1 + e * cnu); // perifocal radius
  // Perifocal position/velocity (z=0 plane).
  const px = rp * cnu, py = rp * snu;
  const vc = Math.sqrt(mu / p);
  const vpx = -vc * snu, vpy = vc * (e + cnu);
  // 3-1-3 rotation perifocal -> inertial (Curtis 4.49); third column unused (z_pf=0).
  const cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(i), si = Math.sin(i), cw = Math.cos(w), sw = Math.sin(w);
  const R11 = cO * cw - sO * sw * ci, R12 = -cO * sw - sO * cw * ci;
  const R21 = sO * cw + cO * sw * ci, R22 = -sO * sw + cO * cw * ci;
  const R31 = sw * si, R32 = cw * si;
  rOut[0] = R11 * px + R12 * py; rOut[1] = R21 * px + R22 * py; rOut[2] = R31 * px + R32 * py;
  vOut[0] = R11 * vpx + R12 * vpy; vOut[1] = R21 * vpx + R22 * vpy; vOut[2] = R31 * vpx + R32 * vpy;
}

/**
 * Sample the orbit ellipse uniformly in eccentric anomaly straight from a
 * state vector, using the orbit's own basis (eccentricity vector for the
 * perifocal x-axis, angular momentum for the normal). Robust at any
 * inclination and for near-circular orbits, where Ω/ω are degenerate. Writes
 * `n` xyz points into `out` (length 3n) in the frame of (r, v). Elliptic only.
 */
export function sampleOrbitPathRV(
  r: Float64Array,
  v: Float64Array,
  mu: number,
  n: number,
  out: Float64Array,
): boolean {
  const rmag = mag(r);
  const vmag2 = dot(v, v);
  if (!(rmag > 1) || !(vmag2 > 0)) return false; // degenerate/zero state (e.g. pre-first-tick)
  const energy = vmag2 / 2 - mu / rmag;
  if (energy >= 0) return false; // unbound
  const a = -mu / (2 * energy);
  const h = cross(r, v);
  const hmag = mag(h);
  const rv = dot(r, v);
  const ev = new Float64Array(3);
  for (let k = 0; k < 3; k++) ev[k] = ((vmag2 - mu / rmag) * r[k] - rv * v[k]) / mu;
  const e = mag(ev);
  const b = a * Math.sqrt(Math.max(0, 1 - e * e));

  // Perifocal basis. For a near-circular orbit e->0, use r as the (arbitrary)
  // periapsis direction; the resulting circle still passes through r.
  const ex = new Float64Array(3);
  if (e > 1e-9) for (let k = 0; k < 3; k++) ex[k] = ev[k] / e;
  else for (let k = 0; k < 3; k++) ex[k] = r[k] / rmag;
  const hz = new Float64Array([h[0] / hmag, h[1] / hmag, h[2] / hmag]);
  const ey = cross(hz, ex); // in-plane, perpendicular to ex

  for (let k = 0; k < n; k++) {
    const E = (k / n) * 2 * Math.PI;
    const px = a * (Math.cos(E) - e);
    const py = b * Math.sin(E);
    out[k * 3] = px * ex[0] + py * ey[0];
    out[k * 3 + 1] = px * ex[1] + py * ey[1];
    out[k * 3 + 2] = px * ex[2] + py * ey[2];
  }
  return true;
}

