// Fetch named CelesTrak satellite groups, bucketed into a handful of display
// CATEGORIES so the sim can colour-code by type (GPS, comms, stations, ...).
// One file per category in public/data/sats/. Deliberately excludes Starlink
// (its own huge toggle). Dedup by NORAD id across all categories (first wins,
// in the order below — a GPS bird stays Navigation even if it's also "visual").
// Usage: node tools/fetch_tles.mjs
import { writeFile, mkdir } from 'node:fs/promises';

// category -> CelesTrak groups. Order matters for dedup priority.
const CATEGORIES = {
  stations: ['stations'],
  navigation: ['gps-ops', 'galileo', 'glo-ops', 'beidou', 'sbas'],
  communications: ['geo', 'intelsat', 'ses', 'iridium-NEXT', 'orbcomm', 'globalstar', 'tdrss', 'other-comm'],
  weather: ['weather', 'noaa', 'goes', 'resource', 'sarsat', 'dmc', 'argos', 'geodetic'],
  science: ['science'],
  other: ['visual', 'amateur', 'cubesat', 'engineering', 'education', 'military', 'radar'],
};
const url = (g) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`;

const seen = new Set(); // NORAD ids already claimed by an earlier category
const dir = new URL('../public/data/sats/', import.meta.url);
await mkdir(dir, { recursive: true });

for (const [cat, groups] of Object.entries(CATEGORIES)) {
  const rows = []; // [name,l1,l2]
  for (const g of groups) {
    try {
      const txt = await (await fetch(url(g))).text();
      if (txt.startsWith('<') || /No GP data/i.test(txt)) { console.warn(`  skip ${g}: no data`); continue; }
      const L = txt.split(/\r?\n/);
      for (let i = 0; i + 2 < L.length; i++) {
        if (L[i + 1]?.startsWith('1 ') && L[i + 2]?.startsWith('2 ')) {
          const id = L[i + 1].slice(2, 7);
          if (!seen.has(id)) { seen.add(id); rows.push([L[i].trimEnd(), L[i + 1], L[i + 2]]); }
          i += 2;
        }
      }
    } catch (e) { console.warn(`  skip ${g}:`, e.message); }
  }
  await writeFile(new URL(`${cat}.txt`, dir), rows.map((r) => r.join('\n')).join('\n') + '\n');
  console.log(`${cat}: ${rows.length} sats`);
}
console.log(`total ${seen.size} satellites across ${Object.keys(CATEGORIES).length} categories`);
