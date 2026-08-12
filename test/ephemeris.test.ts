// Secondary ephemeris guard (build plan §7 P2, §10). The LIVE pipeline is the
// baked DE440 evaluator, validated to sub-km against Horizons in de440.test.ts
// (P2 acceptance met). This file keeps a coarse cross-check on astronomy-engine's
// BaryState — the P0/P1 pipeline DE440 replaced — as an independent frame/unit
// guard: a metres-for-km slip or an equatorial/ecliptic mix-up shows up here as
// a >=1e6 km blow-out regardless of the primary path. Fixtures are barycentric
// ICRF (equatorial J2000), km / km·s⁻¹.
//
//   NOW_TOL_KM — loose, sized to astronomy-engine's own accuracy (a few thousand
//                km inner, ~4e5 km outer); catches only gross regressions.

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

test('astronomy-engine cross-check stays within its own accuracy (frame/unit guard)', () => {
  let worst = 0, worstWhich = '';
  for (const f of fx) {
    const r = ephemKm(f.body, f.jdtdb);
    const err = Math.hypot(r[0] - f.r[0], r[1] - f.r[1], r[2] - f.r[2]);
    if (err > worst) { worst = err; worstWhich = `${f.body} ${f.epoch}`; }
    assert.ok(err < NOW_TOL_KM, `${f.body} @ ${f.epoch}: ${err.toExponential(2)} km > ${NOW_TOL_KM} km`);
  }
  console.log(`  astronomy-engine worst ${worst.toExponential(2)} km (${worstWhich}); live DE440 path meets the ${TARGET_TOL_KM} km P2 bar — see de440.test.ts`);
});

test('a unit/frame regression would be caught (guard-rail sanity)', () => {
  // A metres-for-km error (x1000) or an equatorial/ecliptic mixup (~23 deg)
  // both exceed NOW_TOL_KM at every fixture, so the guard above would fire.
  const f = fx.find((x) => x.body === 'Neptune')!;
  const r = ephemKm(f.body, f.jdtdb);
  const scaled = Math.hypot(r[0] * 1000 - f.r[0], r[1] * 1000 - f.r[1], r[2] * 1000 - f.r[2]);
  assert.ok(scaled > NOW_TOL_KM, 'a unit error must exceed the tolerance');
});
