import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Astro from 'astronomy-engine';

import { rvToElements, sampleOrbitPathRV } from '../src/core/orbital/elements';
import { eqjToEcl } from '../src/core/frames';
import { AU_M, DAY_S } from '../src/core/units';

const MU_SUN = 1.32712440018e20;

function earthHeliocentricEcl(date: Date) {
  const e = Astro.BaryState(Astro.Body.Earth, date);
  const s = Astro.BaryState(Astro.Body.Sun, date);
  const r = new Float64Array([(e.x - s.x) * AU_M, (e.y - s.y) * AU_M, (e.z - s.z) * AU_M]);
  const k = AU_M / DAY_S;
  const v = new Float64Array([(e.vx - s.vx) * k, (e.vy - s.vy) * k, (e.vz - s.vz) * k]);
  eqjToEcl(r, r);
  eqjToEcl(v, v);
  return { r, v };
}

test("Earth's osculating elements match known values", () => {
  const { r, v } = earthHeliocentricEcl(new Date('2026-08-11T00:00:00Z'));
  const el = rvToElements(r, v, MU_SUN);
  assert.ok(Math.abs(el.a / AU_M - 1.0) < 0.02, `a = ${(el.a / AU_M).toFixed(4)} AU`);
  assert.ok(el.e > 0.01 && el.e < 0.025, `e = ${el.e.toFixed(4)}`);
  assert.ok((el.i * 180) / Math.PI < 0.02, `i = ${((el.i * 180) / Math.PI).toFixed(4)} deg (ecliptic)`);
});

test('sampled ellipse passes through the current position', () => {
  const { r, v } = earthHeliocentricEcl(new Date('2026-08-11T00:00:00Z'));
  const N = 4096; // dense enough that half-chord spacing < the 1e-3 AU tolerance
  const pts = new Float64Array(N * 3);
  assert.ok(sampleOrbitPathRV(r, v, MU_SUN, N, pts));
  let best = Infinity;
  for (let k = 0; k < N; k++) {
    const d = Math.hypot(pts[k * 3] - r[0], pts[k * 3 + 1] - r[1], pts[k * 3 + 2] - r[2]);
    if (d < best) best = d;
  }
  // Nearest sample within ~0.1% of 1 AU of the true position.
  assert.ok(best / AU_M < 1e-3, `closest sample ${(best / AU_M).toExponential(2)} AU away`);
});

test('sampling is uniform in eccentric anomaly, not time', () => {
  // Uniform-in-E spacing is near-constant in arc length for low e; uniform-in-
  // time would bunch points near perihelion. Check max/min chord ratio is small.
  const { r, v } = earthHeliocentricEcl(new Date('2026-08-11T00:00:00Z'));
  const N = 256;
  const pts = new Float64Array(N * 3);
  sampleOrbitPathRV(r, v, MU_SUN, N, pts);
  let min = Infinity, max = 0;
  for (let k = 0; k < N; k++) {
    const a = k * 3, b = ((k + 1) % N) * 3;
    const d = Math.hypot(pts[a] - pts[b], pts[a + 1] - pts[b + 1], pts[a + 2] - pts[b + 2]);
    min = Math.min(min, d); max = Math.max(max, d);
  }
  assert.ok(max / min < 1.1, `chord ratio ${(max / min).toFixed(3)} (should be ~1 for near-circular)`);
});
