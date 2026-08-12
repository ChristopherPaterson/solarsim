// Bake real spacecraft trajectories from JPL Horizons into compact polylines
// ([tdb_s, x, y, z] per sample, m, barycentric ecliptic-J2000) — same format as
// the Voyager 1 SPK bake, in public/data/missions/. Horizons carries the craft
// ephemerides directly (by negative NAIF id), so no SPK kernels to wrangle.
//
// Run: node tools/bake_missions.mjs

import { writeFileSync, mkdirSync } from 'node:fs';

const J2000 = 2451545.0, DAY = 86400;
// name, NAIF id, launch/start, stop, step (chosen for a few hundred points).
const MISSIONS = [
  ['voyager1', '-31', '1977-09-06', '2050-01-01', '10d'], // fine step keeps the Jupiter/Saturn flybys
  ['voyager2', '-32', '1977-08-22', '2050-01-01', '20d'],
  ['newhorizons', '-98', '2006-01-20', '2035-01-01', '20d'],
  ['parker', '-96', '2018-08-13', '2025-08-01', '3d'],
  ['juno', '-61', '2011-08-06', '2025-08-01', '10d'],
  ['cassini', '-82', '1997-10-16', '2017-09-15', '15d'],
  ['jwst', '-170', '2022-01-25', '2025-08-01', '6d'],
];

async function fetchTraj(id, start, stop, step) {
  const p = new URLSearchParams({
    format: 'text', COMMAND: `'${id}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'VECTORS'", CENTER: "'@0'", REF_PLANE: "'ECLIPTIC'", VEC_TABLE: "'1'",
    OUT_UNITS: "'KM-S'", START_TIME: `'${start}'`, STOP_TIME: `'${stop}'`, STEP_SIZE: `'${step}'`,
  });
  const text = await (await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${p}`)).text();
  const block = text.match(/\$\$SOE([\s\S]*?)\$\$EOE/);
  if (!block) throw new Error(`no data for ${id}: ${text.slice(0, 300)}`);
  const rows = [];
  const re = /([\d.]+) = A\.D\.[\s\S]*?X =\s*(-?[\d.E+]+)\s*Y =\s*(-?[\d.E+]+)\s*Z =\s*(-?[\d.E+]+)/g;
  let m;
  while ((m = re.exec(block[1]))) {
    rows.push([(parseFloat(m[1]) - J2000) * DAY, +m[2] * 1000, +m[3] * 1000, +m[4] * 1000]);
  }
  return rows;
}

mkdirSync(new URL('../public/data/missions/', import.meta.url), { recursive: true });
const AU = 1.495978707e11;
for (const [name, id, start, stop, step] of MISSIONS) {
  try {
    const rows = await fetchTraj(id, start, stop, step);
    const buf = Buffer.alloc(4 + rows.length * 32);
    buf.writeUInt32LE(rows.length, 0);
    rows.forEach((r, i) => { for (let k = 0; k < 4; k++) buf.writeDoubleLE(r[k], 4 + i * 32 + k * 8); });
    writeFileSync(new URL(`../public/data/missions/${name}.bin`, import.meta.url), buf);
    const d = (r) => Math.hypot(r[1], r[2], r[3]) / AU;
    console.log(`${name.padEnd(12)} ${rows.length} samples  ${d(rows[0]).toFixed(2)} -> ${d(rows.at(-1)).toFixed(1)} AU`);
  } catch (e) { console.log(`${name.padEnd(12)} FAILED: ${e.message.slice(0, 80)}`); }
  await new Promise((r) => setTimeout(r, 600)); // be gentle to Horizons
}
