// Fetch major-moon state vectors from JPL Horizons (relative to their planet's
// centre, ecliptic-J2000) at a reference epoch -> src/data/moons.json. The sim
// Kepler-propagates each moon about its parent from this state (worker). Moons
// are close to their planet, so a fixed Kepler orbit reads correctly for years.
// Run: node tools/bake_moons.mjs

import { writeFileSync } from 'node:fs';

const J2000 = 2451545.0, DAY = 86400, EPOCH = "'2026-01-01 00:00'";
// name, moon NAIF id, parent-centre id
const MOONS = [
  ['Phobos', 401, 499], ['Deimos', 402, 499],
  ['Io', 501, 599], ['Europa', 502, 599], ['Ganymede', 503, 599], ['Callisto', 504, 599],
  ['Titan', 606, 699], ['Rhea', 605, 699], ['Iapetus', 608, 699], ['Enceladus', 602, 699],
  ['Titania', 703, 799], ['Oberon', 704, 799],
  ['Triton', 801, 899], ['Charon', 901, 999],
];

async function fetchState(id, center) {
  const p = new URLSearchParams({
    format: 'text', COMMAND: `'${id}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'VECTORS'", CENTER: `'@${center}'`, REF_PLANE: "'ECLIPTIC'", VEC_TABLE: "'2'",
    OUT_UNITS: "'KM-S'", TLIST: EPOCH,
  });
  const text = await (await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${p}`)).text();
  const blk = text.match(/\$\$SOE([\s\S]*?)\$\$EOE/);
  if (!blk) throw new Error(`no data ${id}: ${text.slice(0, 200)}`);
  const jd = parseFloat(blk[1].match(/([\d.]+) = A\.D\./)[1]);
  const num = blk[1].match(/-?\d+\.\d+E[+-]\d+/g).map(Number);
  return { epoch: (jd - J2000) * DAY, r0: num.slice(0, 3).map((x) => x * 1000), v0: num.slice(3, 6).map((x) => x * 1000) };
}

const out = {};
for (const [name, id, center] of MOONS) {
  try {
    out[name] = await fetchState(id, center);
    console.log(`${name.padEnd(10)} |r|=${(Math.hypot(...out[name].r0) / 1000).toFixed(0)} km`);
  } catch (e) { console.log(`${name.padEnd(10)} FAILED: ${e.message.slice(0, 70)}`); }
  await new Promise((r) => setTimeout(r, 500));
}
writeFileSync(new URL('../src/data/moons.json', import.meta.url), JSON.stringify(out, null, 0));
console.log(`wrote ${Object.keys(out).length} moon states`);
