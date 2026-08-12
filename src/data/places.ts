// Earth surface labels shown at close zoom: the largest metro areas plus a few
// requested cities, and the major orbital launch complexes. lat/lon in degrees
// (N/E positive). launch=true renders in the launch-site style.

export interface Place { name: string; lat: number; lon: number; launch?: boolean; }

export const PLACES: Place[] = [
  // Largest metros (+ Sydney/Melbourne/Auckland).
  { name: 'Tokyo', lat: 35.68, lon: 139.69 },
  { name: 'Delhi', lat: 28.61, lon: 77.21 },
  { name: 'Shanghai', lat: 31.23, lon: 121.47 },
  { name: 'São Paulo', lat: -23.55, lon: -46.63 },
  { name: 'Mexico City', lat: 19.43, lon: -99.13 },
  { name: 'Cairo', lat: 30.04, lon: 31.24 },
  { name: 'Mumbai', lat: 19.08, lon: 72.88 },
  { name: 'Beijing', lat: 39.90, lon: 116.41 },
  { name: 'Dhaka', lat: 23.81, lon: 90.41 },
  { name: 'Osaka', lat: 34.69, lon: 135.50 },
  { name: 'New York', lat: 40.71, lon: -74.01 },
  { name: 'Karachi', lat: 24.86, lon: 67.00 },
  { name: 'Buenos Aires', lat: -34.60, lon: -58.38 },
  { name: 'Istanbul', lat: 41.01, lon: 28.98 },
  { name: 'Lagos', lat: 6.52, lon: 3.38 },
  { name: 'Los Angeles', lat: 34.05, lon: -118.24 },
  { name: 'Moscow', lat: 55.76, lon: 37.62 },
  { name: 'London', lat: 51.51, lon: -0.13 },
  { name: 'Paris', lat: 48.86, lon: 2.35 },
  { name: 'Singapore', lat: 1.35, lon: 103.82 },
  { name: 'Sydney', lat: -33.87, lon: 151.21 },
  { name: 'Melbourne', lat: -37.81, lon: 144.96 },
  { name: 'Auckland', lat: -36.85, lon: 174.76 },
  // Major orbital launch complexes.
  { name: 'Kennedy / Cape Canaveral', lat: 28.57, lon: -80.65, launch: true },
  { name: 'Starbase (SpaceX)', lat: 25.997, lon: -97.157, launch: true },
  { name: 'Vandenberg SFB', lat: 34.74, lon: -120.57, launch: true },
  { name: 'Baikonur Cosmodrome', lat: 45.96, lon: 63.31, launch: true },
  { name: 'Guiana Space Centre', lat: 5.17, lon: -52.68, launch: true },
  { name: 'Satish Dhawan (Sriharikota)', lat: 13.72, lon: 80.23, launch: true },
  { name: 'Jiuquan', lat: 40.96, lon: 100.29, launch: true },
  { name: 'Tanegashima', lat: 30.40, lon: 130.97, launch: true },
  { name: 'Plesetsk Cosmodrome', lat: 62.93, lon: 40.57, launch: true },
  { name: 'Wallops', lat: 37.94, lon: -75.47, launch: true },
  { name: 'Rocket Lab LC-1 (Māhia)', lat: -39.26, lon: 177.86, launch: true },
];

/** Unit direction on the sphere in the body-fixed (texture) frame for a lat/lon.
 *  Matches three.js SphereGeometry UV: Greenwich (lon 0) -> local +X, east -> -Z. */
export function placeDir(lat: number, lon: number): [number, number, number] {
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
}
