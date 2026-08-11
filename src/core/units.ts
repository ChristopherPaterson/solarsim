// Branded unit/frame types. These are compile-time only — zero runtime cost —
// and exist so a metres value can never be silently used where seconds are
// expected, nor an ICRF vector where an ecliptic one is. Every unit/frame bug
// in this project traces back to a violation (build plan §4.3).

export type Metres = number & { readonly __unit: 'm' };
export type MetresPerSec = number & { readonly __unit: 'm/s' };
export type Seconds = number & { readonly __unit: 's' };
export type Kilograms = number & { readonly __unit: 'kg' };
export type Radians = number & { readonly __unit: 'rad' };

/** Seconds of TDB past the J2000 epoch. The one internal time coordinate. */
export type TDB = number & { readonly __epoch: 'TDB' };
export type TT = number & { readonly __epoch: 'TT' };

/** Julian Date, tagged by time scale. */
export type JD_UTC = number & { readonly __jd: 'UTC' };
export type JD_TT = number & { readonly __jd: 'TT' };

/** A 3-vector in a named frame. Frames are documented, not enforced per-axis. */
export type ICRFVec = Float64Array & { readonly __frame: 'ICRF' };
export type EclipticVec = Float64Array & { readonly __frame: 'ECL' };

// --- physical constants (SI) ------------------------------------------------
export const G = 6.674e-11; // gravitational constant, m^3 kg^-1 s^-2
export const G0 = 9.80665; // standard gravity, m/s^2 (rocket equation)
export const STEFAN_BOLTZMANN = 5.670374419e-8; // W m^-2 K^-4

// --- display conversions (used ONLY at the display layer, build plan §4.3) --
export const AU_M = 1.495978707e11; // metres per AU
export const DAY_S = 86400; // seconds per day
export const DEG = Math.PI / 180;

export const metresToAu = (m: number): number => m / AU_M;
export const auToMetres = (au: number): Metres => (au * AU_M) as Metres;
export const radToDeg = (r: number): number => r / DEG;
export const degToRad = (d: number): Radians => (d * DEG) as Radians;
