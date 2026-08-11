// Ephemeris regression harness (build plan §7 P2, §10). Compares the live
// ephemeris against checked-in JPL Horizons reference vectors and fails on
// drift. Fixtures are barycentric ICRF (equatorial J2000), km / km·s⁻¹.
//
// Two tolerances:
//   NOW_TOL_KM    — loose, sized to the current astronomy-engine pipeline
//                   (a few thousand km inner, ~4e5 km outer). Its job is to
//                   catch gross frame/unit regressions (those are >=1e6 km).
//   TARGET_TOL_KM — the P2 acceptance (1 km). Met only once the DE440 SPK bake
//                   replaces astronomy-engine. Reported, not asserted, so
//                   progress toward it is visible without failing CI today.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Astro from 'astronomy-engine';
import fixtures from './fixtures/horizons.json' with { type: 'json' };
import { tdbToDate } from '../src/core/time';
import { AU_M } from '../src/core/units';

const J2000_JD = 2451545.0;
const NOW_TOL_KM = 1e6;
const TARGET_TOL_KM = 1;

type Fix = { body: string; naif: number; epoch: string; jdtdb: number; r: number[]; v: number[] };
const fx = fixtures as Fix[];

function ephemKm(body: string, jdtdb: number): number[] {
  const tdb = (jdtdb - J2000_JD) * 86400;
  const d = tdbToDate(tdb as never);
  const s = Astro.BaryState((Astro.Body as Record<string, Astro.Body>)[body], d);
  return [s.x, s.y, s.z].map((c) => (c * AU_M) / 1000); // km, equatorial ICRF
}

test('harness has fixtures across the support range', () => {
  assert.ok(fx.length >= 24, `only ${fx.length} fixtures`);
  const years = new Set(fx.map((f) => f.epoch.slice(0, 4)));
  assert.ok(years.size >= 3, 'fixtures should span several epochs');
});

test('live ephemeris matches Horizons within the current-pipeline tolerance', () => {
  let worst = 0, worstWhich = '';
  for (const f of fx) {
    const r = ephemKm(f.body, f.jdtdb);
    const err = Math.hypot(r[0] - f.r[0], r[1] - f.r[1], r[2] - f.r[2]);
    if (err > worst) { worst = err; worstWhich = `${f.body} ${f.epoch}`; }
    assert.ok(err < NOW_TOL_KM, `${f.body} @ ${f.epoch}: ${err.toExponential(2)} km > ${NOW_TOL_KM} km`);
  }
  console.log(`  ephemeris worst error ${worst.toExponential(2)} km (${worstWhich}); P2 target ${TARGET_TOL_KM} km needs the SPK bake`);
});

test('a unit/frame regression would be caught (guard-rail sanity)', () => {
  // A metres-for-km error (x1000) or an equatorial/ecliptic mixup (~23 deg)
  // both exceed NOW_TOL_KM at every fixture, so the guard above would fire.
  const f = fx.find((x) => x.body === 'Neptune')!;
  const r = ephemKm(f.body, f.jdtdb);
  const scaled = Math.hypot(r[0] * 1000 - f.r[0], r[1] * 1000 - f.r[1], r[2] * 1000 - f.r[2]);
  assert.ok(scaled > NOW_TOL_KM, 'a unit error must exceed the tolerance');
});
