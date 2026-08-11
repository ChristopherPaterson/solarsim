// Fetch JPL Horizons barycentric ICRF (equatorial J2000) state vectors for a
// set of bodies at a set of epochs, and write them as a checked-in fixture for
// the ephemeris regression harness (build plan §7 P2, §10). CI compares the
// live ephemeris against these; drift beyond tolerance fails.
//
// Run: node tools/fetch_horizons.mjs   ->  test/fixtures/horizons.json

import { writeFileSync } from 'node:fs';

const BODIES = [
  ['Mercury', 199], ['Venus', 299], ['Earth', 399], ['Mars', 499],
  ['Jupiter', 599], ['Saturn', 699], ['Uranus', 799], ['Neptune', 899],
  ['Moon', 301],
];
// Epochs across the 1900-2100 support range (interpreted by Horizons as TDB).
const EPOCHS = ['1950-Jan-01 00:00', '2000-Jan-01 12:00', '2026-Aug-11 00:00', '2099-Dec-31 00:00'];

async function fetchVector(naif, epoch) {
  const p = new URLSearchParams({
    format: 'text', COMMAND: `'${naif}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'VECTORS'", CENTER: "'@0'", REF_PLANE: "'FRAME'", REF_SYSTEM: "'ICRF'",
    VEC_TABLE: "'2'", OUT_UNITS: "'KM-S'", TLIST: `'${epoch}'`,
  });
  const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${p}`);
  const text = await res.text();
  const block = text.match(/\$\$SOE([\s\S]*?)\$\$EOE/);
  if (!block) throw new Error(`no SOE block for ${naif} @ ${epoch}: ${text.slice(0, 200)}`);
  const jd = block[1].match(/^\s*([\d.]+)\s*=/m);
  // X Y Z VX VY VZ are the six scientific-notation numbers after the JD line.
  const nums = block[1].slice(block[1].indexOf('X')).match(/-?\d+\.\d+E[+-]\d+/g);
  if (!jd || !nums || nums.length < 6) throw new Error(`parse failed for ${naif} @ ${epoch}`);
  return {
    jdtdb: parseFloat(jd[1]),
    r: nums.slice(0, 3).map(Number), // km
    v: nums.slice(3, 6).map(Number), // km/s
  };
}

const out = [];
for (const [name, naif] of BODIES) {
  for (const epoch of EPOCHS) {
    const rec = await fetchVector(naif, epoch);
    out.push({ body: name, naif, epoch, ...rec });
    console.log(`${name.padEnd(8)} ${epoch}  |r|=${Math.hypot(...rec.r).toExponential(3)} km`);
    await new Promise((r) => setTimeout(r, 400)); // be gentle
  }
}
writeFileSync(new URL('../test/fixtures/horizons.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`\nwrote ${out.length} fixtures`);
