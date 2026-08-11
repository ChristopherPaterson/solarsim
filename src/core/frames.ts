// Reference frames (build plan §4.6). P1 needs the fixed rotation between the
// ICRF equatorial frame (what ephemerides return) and the J2000 ecliptic frame
// the scene is oriented in (§4.3), plus precession for star-field alignment.
// RTN/LVLH/perifocal/body-fixed are added when P3.5 needs them.

import type { JD_TT } from './units';
import { J2000_JD } from './time';

const ARCSEC = Math.PI / (180 * 3600);

/** Mean obliquity of the ecliptic at J2000: 84381.406" (IAU 2006). */
export const OBLIQUITY_J2000 = 84381.406 * ARCSEC;

/** A 3x3 rotation matrix, row-major Float64. */
export type Mat3 = Float64Array;

export function rotX(theta: number): Mat3 {
  const c = Math.cos(theta), s = Math.sin(theta);
  return new Float64Array([1, 0, 0, 0, c, s, 0, -s, c]);
}
export function rotZ(theta: number): Mat3 {
  const c = Math.cos(theta), s = Math.sin(theta);
  return new Float64Array([c, s, 0, -s, c, 0, 0, 0, 1]);
}

/** out = M * v. out may alias v. */
export function applyMat3(m: Mat3, v: Float64Array, out: Float64Array): void {
  const x = v[0], y = v[1], z = v[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[3] * x + m[4] * y + m[5] * z;
  out[2] = m[6] * x + m[7] * y + m[8] * z;
}

/** out = A * B (row-major). */
export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const o = new Float64Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

export function transpose3(m: Mat3): Mat3 {
  return new Float64Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

// Rotating equatorial->ecliptic tips the frame about the X axis by +obliquity.
const EQJ_TO_ECL = rotX(OBLIQUITY_J2000);
const ECL_TO_EQJ = transpose3(EQJ_TO_ECL);

/** ICRF/equatorial-J2000 vector -> ecliptic-J2000. out may alias v. */
export function eqjToEcl(v: Float64Array, out: Float64Array): void {
  applyMat3(EQJ_TO_ECL, v, out);
}
/** Ecliptic-J2000 vector -> ICRF/equatorial-J2000. out may alias v. */
export function eclToEqj(v: Float64Array, out: Float64Array): void {
  applyMat3(ECL_TO_EQJ, v, out);
}

/**
 * Precession matrix J2000 equatorial -> mean equator/equinox of date
 * (Lieske 1976 ζ, z, θ). Accurate to arcseconds near J2000 — sufficient for
 * star-field alignment across the sim's date range.
 */
export function precessionEqjToDate(jdTt: JD_TT): Mat3 {
  const T = (jdTt - J2000_JD) / 36525; // Julian centuries from J2000
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * ARCSEC;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * ARCSEC;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * ARCSEC;
  // R = Rz(-z) * Ry(theta) * Rz(-zeta)
  const rotY = (a: number): Mat3 => {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float64Array([c, 0, -s, 0, 1, 0, s, 0, c]);
  };
  return mulMat3(rotZ(-z), mulMat3(rotY(theta), rotZ(-zeta)));
}
