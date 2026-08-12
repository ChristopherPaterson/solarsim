// Fetch a broad set of *named* CelesTrak satellite groups into public/data/tles.txt
// for the mixed "SATELLITES" toggle. Deliberately excludes Starlink (its own huge
// group / separate toggle) and other unnamed mega-constellations. Dedup by NORAD id.
// Usage: node tools/fetch_tles.mjs
import { writeFile } from 'node:fs/promises';

// Notable, mostly-named groups. No starlink/oneweb/planet mega-swarms.
const GROUPS = [
  'stations', 'visual', 'science', 'geo', 'intelsat', 'ses', 'iridium-NEXT',
  'orbcomm', 'globalstar', 'amateur', 'cubesat', 'gps-ops', 'galileo',
  'glo-ops', 'beidou', 'sbas', 'weather', 'noaa', 'goes', 'resource',
  'sarsat', 'dmc', 'tdrss', 'argos', 'geodetic', 'engineering', 'education',
  'military', 'radar', 'other-comm',
];
const url = (g) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`;

const seen = new Map(); // NORAD id -> [name, l1, l2]
for (const g of GROUPS) {
  try {
    const txt = await (await fetch(url(g))).text();
    if (txt.startsWith('<') || /No GP data/i.test(txt)) { console.warn(`skip ${g}: no data`); continue; }
    const L = txt.split(/\r?\n/);
    let added = 0;
    for (let i = 0; i + 2 < L.length; i++) {
      if (L[i + 1]?.startsWith('1 ') && L[i + 2]?.startsWith('2 ')) {
        const id = L[i + 1].slice(2, 7);
        if (!seen.has(id)) { seen.set(id, [L[i].trimEnd(), L[i + 1], L[i + 2]]); added++; }
        i += 2;
      }
    }
    console.log(`${g}: +${added} (total ${seen.size})`);
  } catch (e) { console.warn(`skip ${g}:`, e.message); }
}
const out = [...seen.values()].map((t) => t.join('\n')).join('\n') + '\n';
await writeFile(new URL('../public/data/tles.txt', import.meta.url), out);
console.log(`wrote ${seen.size} satellites to public/data/tles.txt`);
