// Bake real Phobos & Deimos shape models (Thomas, PDS SBN) into compact binary
// meshes for the renderer. Source .tab files are lat/lon/radius grids (km,
// body-fixed): each line "lat lon radius", lat-major. We triangulate the grid
// into a displaced sphere, normalise by mean radius (so the renderer's uniform
// scale by body radius reproduces true size + lumpiness), and write:
//   uint32 nVerts, uint32 nIndices, Float32[nVerts*3] pos,
//   Float32[nVerts*2] uv (equirectangular from lon/lat), Uint32[nIndices] idx
// Usage: node tools/bake_moon_shapes.mjs
import { writeFile, mkdir } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BASE = 'https://sbnarchive.psi.edu/pds4/non_mission/ast-sat.thomas.shape-models_V1_0/data';
const MOONS = [['phobos', 'm1phobos.tab'], ['deimos', 'm2deimos.tab']];

const dir = new URL('../public/data/shapes/', import.meta.url);
await mkdir(dir, { recursive: true });

for (const [name, file] of MOONS) {
  const txt = await (await fetch(`${BASE}/${file}`, { headers: { 'User-Agent': UA } })).text();
  const rows = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(/\s+/).map(Number)); // [lat, lon, r]

  // Grid dims: lon varies fastest (lat constant within a row). Count the run.
  let nLon = 0; const lat0 = rows[0][0];
  while (nLon < rows.length && rows[nLon][0] === lat0) nLon++;
  const nLat = rows.length / nLon;
  if (!Number.isInteger(nLat)) throw new Error(`${name}: grid not rectangular (${rows.length}/${nLon})`);

  const meanR = rows.reduce((s, r) => s + r[2], 0) / rows.length;
  const D = Math.PI / 180;
  const pos = new Float32Array(rows.length * 3);
  const uv = new Float32Array(rows.length * 2);
  for (let k = 0; k < rows.length; k++) {
    const [lat, lon, r] = rows[k], rn = r / meanR, cl = Math.cos(lat * D);
    pos[k * 3] = rn * cl * Math.cos(lon * D);
    pos[k * 3 + 1] = rn * Math.sin(lat * D); // +Y = north pole (matches renderer spin axis)
    pos[k * 3 + 2] = rn * cl * Math.sin(lon * D);
    uv[k * 2] = lon / 360;          // equirectangular u
    uv[k * 2 + 1] = (lat + 90) / 180; // v (south pole 0 -> north 1)
  }
  // Two triangles per grid quad (skip the wrap-around last lon column: seam is duplicated).
  const idx = [];
  for (let i = 0; i < nLat - 1; i++) {
    for (let j = 0; j < nLon - 1; j++) {
      const a = i * nLon + j, b = a + 1, c = a + nLon, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const indices = new Uint32Array(idx);
  const buf = new ArrayBuffer(8 + pos.byteLength + uv.byteLength + indices.byteLength);
  new Uint32Array(buf, 0, 2).set([rows.length, indices.length]);
  new Float32Array(buf, 8, pos.length).set(pos);
  new Float32Array(buf, 8 + pos.byteLength, uv.length).set(uv);
  new Uint32Array(buf, 8 + pos.byteLength + uv.byteLength, indices.length).set(indices);
  await writeFile(new URL(`${name}.bin`, dir), Buffer.from(buf));
  console.log(`${name}: ${nLat}×${nLon} grid, ${rows.length} verts, ${indices.length / 3} tris, mean radius ${meanR.toFixed(2)} km`);
}
