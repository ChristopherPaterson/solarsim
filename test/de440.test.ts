// P2 acceptance harness for the baked DE440 ephemeris. Two checks:
//   1. Pipeline fidelity — the TS Chebyshev evaluator vs jplephem-chained DE440
//      reference (test/fixtures/de440_ref.json). Must be sub-metre: this proves
//      the bake + reader carry DE440 faithfully.
//   2. Physical accuracy — the evaluator vs JPL Horizons (horizons.json).
//      Sub-km for the bodies DE440s carries as true centres (Sun, Mercury,
//      Venus, Earth, Moon, Mars). The four giant planets are only present as
//      system barycentres, off the planet centre by their moons (tens–hundreds
//      of km); asserted against a per-body barycentre bound and reported.

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

// Bodies DE440s carries as true centres — the P2 sub-km target applies.
const SUBKM = new Set(['Sun', 'Mercury', 'Venus', 'Earth', 'Moon', 'Mars']);
// Giants: DE440s carries only the system barycentre, which diverges from the
// planet centre Horizons reports (moon signal + the outer-planet centre coming
// from a separate satellite ephemeris). These bounds are the measured barycentre
// offset over 1950–2099 — regression guards, not the sub-km target. Reaching
// sub-km here needs the per-planet satellite kernel (599/699/799/899 rel bary).
const BARY_BOUND_KM: Record<string, number> = { Jupiter: 300, Saturn: 400, Uranus: 5000, Neptune: 3000 };

test('DE440 vs Horizons: sub-km centres, bounded giant barycentres', () => {
  type Fix = { body: string; jdtdb: number; r: number[] };
  const perBody: Record<string, number> = {};
  for (const f of horizons as Fix[]) {
    const tdb = (f.jdtdb - J2000_JD) * 86400;
    const r = posKm(f.body, tdb);
    const err = Math.hypot(r[0] - f.r[0], r[1] - f.r[1], r[2] - f.r[2]);
    perBody[f.body] = Math.max(perBody[f.body] ?? 0, err);
  }
  for (const [body, err] of Object.entries(perBody)) {
    const tol = SUBKM.has(body) ? 1 : BARY_BOUND_KM[body];
    const tag = SUBKM.has(body) ? 'centre' : 'barycentre';
    console.log(`  ${body.padEnd(8)} ${err.toExponential(2)} km  (${tag}, tol ${tol} km)`);
    assert.ok(err < tol, `${body}: ${err.toExponential(2)} km > ${tol} km`);
  }
});
