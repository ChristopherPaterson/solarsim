import type { Body } from '../core/types';
import moonStates from './moons.json';

// P1 catalogue: Sun, eight planets, Luna. Positions from astronomy-engine
// (VSOP/NOVAS) in P1; P2 swaps `ephemeris.source` to baked SPK. GM values from
// DE440 headers, radii from IAU. `id` matches the astronomy-engine Body name so
// the worker can resolve it without a side table.
//
// ponytail: rotation pole/prime-meridian fields are IAU placeholders here and
// are only consumed for body-fixed orientation in P5 (textures) and the
// surface-observer star check, which uses astronomy-engine's own rotation for
// now. Validate them when P5 lands.

const star = (id: string, gm: number, radius: number, colour: number): Body => ({
  id,
  gm,
  radius,
  rotation: { period: 0, poleRA: 0, poleDec: 90, primeMeridian: 0 },
  ephemeris: { source: 'vsop' },
  appearance: { colour },
});

export const SOLAR_SYSTEM: Body[] = [
  { ...star('Sun', 1.32712440018e20, 6.957e8, 0xffcc33), rotation: { period: 2192832, poleRA: 286.13, poleDec: 63.87, primeMeridian: 84.176 } },
  { ...star('Mercury', 2.2032e13, 2.4397e6, 0x9c8a7a), naifId: 199, rotation: { period: 5067360, poleRA: 281.01, poleDec: 61.45, primeMeridian: 329.5 } },
  { ...star('Venus', 3.24859e14, 6.0518e6, 0xd9b382), naifId: 299, rotation: { period: -20996755, poleRA: 272.76, poleDec: 67.16, primeMeridian: 160.2 } },
  { ...star('Earth', 3.986004418e14, 6.378137e6, 0x4f8fd8), naifId: 399, flattening: 0.0033528, j2: 1.08263e-3, rotation: { period: 86164.0905, poleRA: 0, poleDec: 90, primeMeridian: 190.147 } },
  { ...star('Moon', 4.9048695e12, 1.7374e6, 0xbdbdbd), naifId: 301, parent: 'Earth', rotation: { period: 2360591.5, poleRA: 269.99, poleDec: 66.54, primeMeridian: 38.31 } },
  { ...star('Mars', 4.282837e13, 3.3962e6, 0xc1440e), naifId: 499, flattening: 0.00589, j2: 1.96045e-3, rotation: { period: 88642.66, poleRA: 317.68, poleDec: 52.89, primeMeridian: 176.63 } },
  { ...star('Jupiter', 1.26686534e17, 7.1492e7, 0xd8b48f), naifId: 599, flattening: 0.06487, j2: 1.4736e-2, rotation: { period: 35730, poleRA: 268.06, poleDec: 64.5, primeMeridian: 284.95 } },
  { ...star('Saturn', 3.7931187e16, 6.0268e7, 0xe3d9a1), naifId: 699, flattening: 0.09796, j2: 1.6298e-2, rotation: { period: 38361.6, poleRA: 40.59, poleDec: 83.54, primeMeridian: 38.9 }, appearance: { colour: 0xe3d9a1, ringInner: 7.4e7, ringOuter: 1.4022e8 } },
  { ...star('Uranus', 5.793939e15, 2.5559e7, 0x9fd8e3), naifId: 799, flattening: 0.02293, rotation: { period: -62063.7, poleRA: 257.31, poleDec: -15.18, primeMeridian: 203.81 } },
  { ...star('Neptune', 6.836529e15, 2.4764e7, 0x3f66d8), naifId: 899, flattening: 0.01708, rotation: { period: 57996, poleRA: 299.36, poleDec: 43.46, primeMeridian: 253.18 } },
  // Pluto: DE440 system barycentre (naif 9). Retrograde spin; tan/beige colour.
  { ...star('Pluto', 9.755e11, 1.1883e6, 0xccb39a), naifId: 9, rotation: { period: -551856.7, poleRA: 132.99, poleDec: -6.16, primeMeridian: 302.7 } },
];

// Major moons: massless (gm 0 — visual rails), Kepler-propagated about their
// parent from the baked Horizons state (tools/bake_moons.mjs). name, parent, radius m, colour.
// Phobos/Deimos are markedly non-spherical — triaxial axis ratios vs mean radius.
const TRIAXIAL: Record<string, [number, number, number]> = {
  Phobos: [1.22, 1.01, 0.82], Deimos: [1.21, 0.98, 0.89],
};
const MOON_META: [string, string, number, number][] = [
  ['Phobos', 'Mars', 1.1e4, 0x9a8a7a], ['Deimos', 'Mars', 6.2e3, 0x9a8a7a],
  ['Io', 'Jupiter', 1.8216e6, 0xe6d96a], ['Europa', 'Jupiter', 1.5608e6, 0xd8d2be],
  ['Ganymede', 'Jupiter', 2.6341e6, 0xa89a86], ['Callisto', 'Jupiter', 2.4103e6, 0x74655a],
  ['Titan', 'Saturn', 2.5747e6, 0xd7a642], ['Rhea', 'Saturn', 7.640e5, 0xb0b0b0],
  ['Iapetus', 'Saturn', 7.345e5, 0x9a8a72], ['Enceladus', 'Saturn', 2.521e5, 0xf2f2f2],
  ['Titania', 'Uranus', 7.884e5, 0x9a9a9a], ['Oberon', 'Uranus', 7.614e5, 0x8a8a8a],
  ['Triton', 'Neptune', 1.3534e6, 0xccb0cc], ['Charon', 'Pluto', 6.06e5, 0x9a9a9a],
];
const states = moonStates as unknown as Record<string, { r0: [number, number, number]; v0: [number, number, number]; epoch: number }>;
for (const [id, parent, radius, colour] of MOON_META) {
  const s = states[id];
  if (!s) continue;
  SOLAR_SYSTEM.push({ ...star(id, 0, radius, colour), parent, ephemeris: { source: 'kepler' }, relState: s, triaxial: TRIAXIAL[id] });
}

/** Byte layout helper: 6 Float64 per body (x,y,z,vx,vy,vz), SI, ecliptic-J2000. */
export const FLOATS_PER_BODY = 6;
