// P2 acceptance harness for the baked DE440 ephemeris. Two checks:
//   1. Pipeline fidelity — the TS Chebyshev evaluator vs jplephem-chained DE440
//      reference (test/fixtures/de440_ref.json). Must be sub-metre: this proves
//      the bake + reader carry DE440 faithfully.
//   2. Physical accuracy — the evaluator vs JPL Horizons (horizons.json), every
//      body at the quantity DE440s actually carries: true centre for the inner
//      planets + Moon (NAIF 199/299/399/301), system barycentre for Mars and the
//      giants (NAIF 4/5/6/7/8). All must be sub-km — DE440s reproduces Horizons
//      to sub-metre across the 1950–2099 support range (P2 acceptance met).
//
// The giants' body centre differs from the barycentre by their moons (Jupiter/
// Saturn a few hundred km, the ice giants tens of km + a JPL barycentre-frame
// inconsistency). That offset is invisible at 5–30 AU; reaching sub-km on the
// giant *centres* would need the per-planet satellite kernel (599/699/799/899
// rel bary) — see the note in src/core/ephemeris/de440.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { De440 } from '../src/core/ephemeris/de440';
import de440ref from './fixtures/de440_ref.json' with { type: 'json' };
import horizons from './fixtures/horizons.json' with { type: 'json' };

const J2000_JD = 2451545.0;
const buf = readFileSync(new URL('../public/data/ephemeris.bin', import.meta.url));
const eph = new De440(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const out = new Float64Array(6);
const posKm = (body: string, tdb: number): number[] => {
  eph.state(body, tdb, out);
  return [out[0] / 1000, out[1] / 1000, out[2] / 1000]; // m -> km
};

test('TS evaluator is sub-metre-faithful to DE440 (bake + reader)', () => {
  let worst = 0, which = '';
  for (const f of de440ref as { body: string; tdb: number; r: number[] }[]) {
    const r = posKm(f.body, f.tdb);
    const err = Math.hypot(r[0] - f.r[0], r[1] - f.r[1], r[2] - f.r[2]) * 1000; // metres
    if (err > worst) { worst = err; which = f.body; }
  }
  console.log(`  DE440 pipeline fidelity worst ${worst.toExponential(2)} m (${which})`);
  assert.ok(worst < 1, `pipeline drift ${worst.toExponential(2)} m > 1 m (${which})`);
});

// Bodies DE440s carries as true centres; the rest as system barycentre. Either
// way the fixture (fetch_horizons.mjs) matches the carried quantity, so the P2
// sub-km target applies uniformly.
const CENTRE = new Set(['Mercury', 'Venus', 'Earth', 'Moon']);
const P2_TOL_KM = 1;

test('DE440 vs Horizons: sub-km across every body (P2 acceptance)', () => {
  type Fix = { body: string; jdtdb: number; r: number[] };
  const perBody: Record<string, number> = {};
  for (const f of horizons as Fix[]) {
    const tdb = (f.jdtdb - J2000_JD) * 86400;
    const r = posKm(f.body, tdb);
    const err = Math.hypot(r[0] - f.r[0], r[1] - f.r[1], r[2] - f.r[2]);
    perBody[f.body] = Math.max(perBody[f.body] ?? 0, err);
  }
  for (const [body, err] of Object.entries(perBody)) {
    const tag = CENTRE.has(body) ? 'centre' : 'barycentre';
    console.log(`  ${body.padEnd(8)} ${err.toExponential(2)} km  (${tag}, tol ${P2_TOL_KM} km)`);
    assert.ok(err < P2_TOL_KM, `${body}: ${err.toExponential(2)} km > ${P2_TOL_KM} km`);
  }
});
