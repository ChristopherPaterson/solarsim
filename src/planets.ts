import { Body } from 'astronomy-engine';

// P0 flat-colour catalogue. Real radii (km) are kept for relative sizing only;
// P0 exaggerates size for visibility — real-scale is a P1 concern.
export interface P0Body {
  name: string;
  body: Body;
  colour: number;
  radiusKm: number;
}

export const SUN: P0Body = { name: 'Sun', body: Body.Sun, colour: 0xffcc33, radiusKm: 696340 };

export const PLANETS: P0Body[] = [
  { name: 'Mercury', body: Body.Mercury, colour: 0x9c8a7a, radiusKm: 2439.7 },
  { name: 'Venus', body: Body.Venus, colour: 0xd9b382, radiusKm: 6051.8 },
  { name: 'Earth', body: Body.Earth, colour: 0x4f8fd8, radiusKm: 6371.0 },
  { name: 'Mars', body: Body.Mars, colour: 0xc1440e, radiusKm: 3389.5 },
  { name: 'Jupiter', body: Body.Jupiter, colour: 0xd8b48f, radiusKm: 69911 },
  { name: 'Saturn', body: Body.Saturn, colour: 0xe3d9a1, radiusKm: 58232 },
  { name: 'Uranus', body: Body.Uranus, colour: 0x9fd8e3, radiusKm: 25362 },
  { name: 'Neptune', body: Body.Neptune, colour: 0x3f66d8, radiusKm: 24622 },
];
