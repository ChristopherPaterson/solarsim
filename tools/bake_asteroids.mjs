// Bake Minor Planet Center orbital elements into a compact GPU buffer for P4:
// per asteroid [a(m), e, i, Ω, ω, M0, epoch_tdb_s] (Float32, heliocentric
// ecliptic-J2000), sorted brightest-first so a runtime slider = draw count.
// Kepler's equation is solved on the GPU each frame (see the renderer), so this
// is pure data prep. Run: node tools/bake_asteroids.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const N_MAX = 100_000;
const DEG = Math.PI / 180, AU = 1.495978707e11, J2000 = 2451545.0, DAY = 86400;

// Packed MPC date char: '0'-'9' -> 0-9, 'A'-'V' -> 10-31.
const unpk = (c) => (c >= '0' && c <= '9' ? +c : c.charCodeAt(0) - 55);
function epochTdb(s) { // e.g. "K2669" -> 2026-06-09 0h
  const cen = { I: 1800, J: 1900, K: 2000 }[s[0]] ?? 2000;
  const Y = cen + parseInt(s.slice(1, 3), 10), M = unpk(s[3]), D = unpk(s[4]);
  const a = Math.floor((14 - M) / 12), y = Y + 4800 - a, m = M + 12 * a - 3;
  const jd = D + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045 - 0.5;
  return (jd - J2000) * DAY;
}

const lines = readFileSync(new URL('data/mpcorb_head.dat', import.meta.url), 'latin1').split('\n');
let start = lines.findIndex((l) => l.startsWith('----------')) + 1;
const rows = [];
for (let i = start; i < lines.length; i++) {
  const l = lines[i];
  if (l.length < 103) continue;
  const H = parseFloat(l.slice(8, 13));
  const e = parseFloat(l.slice(70, 79));
  const a = parseFloat(l.slice(92, 103));
  if (!(a > 0) || !(e >= 0 && e < 1) || Number.isNaN(H)) continue;
  rows.push({
    H, a: a * AU, e,
    i: parseFloat(l.slice(59, 68)) * DEG,
    Om: parseFloat(l.slice(48, 57)) * DEG,
    w: parseFloat(l.slice(37, 46)) * DEG,
    M0: parseFloat(l.slice(26, 35)) * DEG,
    ep: epochTdb(l.slice(20, 25)),
  });
}
rows.sort((p, q) => p.H - q.H); // brightest first
const take = rows.slice(0, N_MAX);
const buf = Buffer.alloc(4 + take.length * 28);
buf.writeUInt32LE(take.length, 0);
take.forEach((r, k) => {
  const o = 4 + k * 28;
  buf.writeFloatLE(r.a, o); buf.writeFloatLE(r.e, o + 4); buf.writeFloatLE(r.i, o + 8);
  buf.writeFloatLE(r.Om, o + 12); buf.writeFloatLE(r.w, o + 16); buf.writeFloatLE(r.M0, o + 20); buf.writeFloatLE(r.ep, o + 24);
});
writeFileSync(new URL('../public/data/asteroids.bin', import.meta.url), buf);
// distribution report: belt (2.0-3.4 AU) vs Jupiter Trojans (~5.05-5.35 AU)
const belt = take.filter((r) => r.a / AU >= 2 && r.a / AU <= 3.4).length;
const troj = take.filter((r) => r.a / AU >= 5.0 && r.a / AU <= 5.4).length;
console.log(`parsed ${rows.length}, wrote ${take.length} (H ${take[0].H}..${take.at(-1).H})`);
console.log(`  main belt (2-3.4 AU): ${belt}   Jupiter Trojans (~5.2 AU): ${troj}`);
