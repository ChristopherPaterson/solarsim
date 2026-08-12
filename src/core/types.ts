// Body and vessel descriptors (build plan §4.5). Descriptors are data; the
// numeric core reads only physical fields. `Vessel.origin` is a UI filter and
// MUST NOT reach the physics layer — propagation is decided by
// `propulsion.regime` alone (build plan §4.5, trap list).

export interface KeplerElements {
  a: number; // semi-major axis, m
  e: number; // eccentricity
  i: number; // inclination, rad
  raan: number; // longitude of ascending node Ω, rad
  argp: number; // argument of periapsis ω, rad
  m0: number; // mean anomaly at epoch, rad
  epoch: number; // TDB seconds past J2000
}

export interface Body {
  id: string;
  naifId?: number;
  parent?: string; // reference-frame parent id (nested frames, §4.4)
  gm: number; // m^3/s^2
  radius: number; // m (equatorial / mean)
  flattening?: number; // polar oblateness (r_pol = r·(1−f)), for the giants
  triaxial?: [number, number, number]; // axis ratios vs `radius` for lumpy small moons
  atmosphere?: { colour: number; scale: number }; // fresnel rim-glow halo (shell = radius·scale)
  comet?: boolean; // render a coma glow + anti-sunward tail

  j2?: number;
  rotation: { period: number; poleRA: number; poleDec: number; primeMeridian: number };
  ephemeris: {
    source: 'vsop' | 'spk' | 'kepler' | 'integrated';
    spkId?: number;
    elements?: KeplerElements;
  };
  // Moons not in the baked ephemeris: Kepler-propagated about `parent` from this
  // state (barycentric ecliptic-J2000 relative to the parent, SI) at `epoch`.
  relState?: { r0: [number, number, number]; v0: [number, number, number]; epoch: number };
  appearance: {
    colour: number; // used from P0
    albedoMap?: string; // all maps optional, added P5
    normalMap?: string;
    emissiveMap?: string;
    ringInner?: number;
    ringOuter?: number;
    ringMap?: string;
  };
}

export interface Vessel {
  id: string;
  name: string;
  origin: 'historical' | 'operational' | 'concept' | 'fictional' | 'user';
  dryMass: number; // kg
  propellantMass: number; // kg
  propulsion: {
    regime: 'impulsive' | 'lowThrust' | 'torch' | 'exotic';
    isp: number; // s
    thrust: number; // N
    wasteHeat?: number; // W
    throttleable: boolean;
    minThrottle?: number;
  };
  trajectory: { source: 'spk' | 'integrated' | 'onRails'; spkId?: number };
  model?: { gltf: string; lengthMetres: number };
}
