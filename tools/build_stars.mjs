// Build a compact star binary from the HYG catalogue for the P1 star field.
// Input:  tools/data/hyg_v41.csv  (HYG v4.1, from astronexus/HYG-Database)
// Output: public/data/stars.bin   (fetched at runtime, one instanced draw)
//
// Per star (little-endian): 7 x float32
//   dirx,diry,dirz  unit direction, equatorial J2000 (ICRF)
//   mag             apparent V magnitude
//   ci              B-V colour index
//   pmra,pmdec      proper motion, mas/yr (pmra is on-sky, i.e. * cos dec)
// Header: uint32 count.
//
// ponytail: naked-eye limit (mag <= MAG_LIMIT) keeps this ~250 KB and gives the
// recognisable constellations for the Stellarium check. Octahedral/float16
// quantisation (build plan §6) is a payload optimisation for the full 118k
// Hipparcos load; do it if/when payload matters.

import { readFileSync, writeFileSync } from 'node:fs';

const MAG_LIMIT = 6.5;
const SRC = new URL('./data/hyg_v41.csv', import.meta.url);
const OUT = new URL('../public/data/stars.bin', import.meta.url);

const text = readFileSync(SRC, 'utf8');
const lines = text.split('\n');
const header = lines[0].split(',').map((s) => s.replace(/"/g, ''));
const col = (name) => header.indexOf(name);
const RARAD = col('rarad'), DECRAD = col('decrad'), DIST = col('dist');
const MAG = col('mag'), CI = col('ci'), PMRA = col('pmra'), PMDEC = col('pmdec');

// Minimal CSV field split honouring double quotes.
function fields(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const stars = [];
for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line) continue;
  const f = fields(line);
  const mag = parseFloat(f[MAG]);
  const dist = parseFloat(f[DIST]);
  if (!isFinite(mag) || mag > MAG_LIMIT) continue;
  if (!isFinite(dist) || dist <= 0) continue; // skip the Sun (dist 0) and bad rows
  const ra = parseFloat(f[RARAD]);
  const dec = parseFloat(f[DECRAD]);
  if (!isFinite(ra) || !isFinite(dec)) continue;
  const cd = Math.cos(dec);
  stars.push({
    x: cd * Math.cos(ra), y: cd * Math.sin(ra), z: Math.sin(dec),
    mag,
    ci: isFinite(parseFloat(f[CI])) ? parseFloat(f[CI]) : 0.6,
    pmra: isFinite(parseFloat(f[PMRA])) ? parseFloat(f[PMRA]) : 0,
    pmdec: isFinite(parseFloat(f[PMDEC])) ? parseFloat(f[PMDEC]) : 0,
  });
}

const buf = new ArrayBuffer(4 + stars.length * 7 * 4);
new Uint32Array(buf, 0, 1)[0] = stars.length;
const fa = new Float32Array(buf, 4);
stars.forEach((s, i) => {
  const b = i * 7;
  fa[b] = s.x; fa[b + 1] = s.y; fa[b + 2] = s.z;
  fa[b + 3] = s.mag; fa[b + 4] = s.ci; fa[b + 5] = s.pmra; fa[b + 6] = s.pmdec;
});
writeFileSync(OUT, Buffer.from(buf));
console.log(`stars: ${stars.length}, bytes: ${buf.byteLength} (${(buf.byteLength / 1024).toFixed(0)} KB), mag<=${MAG_LIMIT}`);
