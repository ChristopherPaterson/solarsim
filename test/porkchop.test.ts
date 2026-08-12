// Porkchop acceptance (build plan §7 P3.5): a 200×200 grid (40k Lambert solves)
// must compute well under 2 s, and the minimum-Δv cell of an Earth→Mars grid
// should land near the Hohmann value (~5.6 km/s).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { porkchop, type StateAt } from '../src/core/orbital/porkchop';
import { AU_M } from '../src/core/units';

const MU = 1.32712440018e20;
// Coplanar circular Earth/Mars (enough to exercise the grid + find the optimum).
const circular = (r: number, phase0: number): StateAt => (t: number) => {
  const w = Math.sqrt(MU / (r * r * r)), th = phase0 + w * t, v = Math.sqrt(MU / r);
  return { r: new Float64Array([r * Math.cos(th), r * Math.sin(th), 0]), v: new Float64Array([-v * Math.sin(th), v * Math.cos(th), 0]) };
};

test('200×200 porkchop grid computes under 2 s', () => {
  const earth = circular(AU_M, 0), mars = circular(1.523679 * AU_M, 0.3);
  const N = 200, DAY = 86400;
  // Span a full synodic period (~780 d) so the launch window is inside the grid.
  const depT = Array.from({ length: N }, (_, i) => (i * 800 / N) * DAY);
  const arrT = Array.from({ length: N }, (_, j) => (180 + j * 800 / N) * DAY);
  const t0 = performance.now();
  const pc = porkchop(earth, mars, MU, depT, arrT);
  const ms = performance.now() - t0;
  // Best (finite) total Δv over the grid.
  let best = Infinity;
  for (const v of pc.dvTotal) if (Number.isFinite(v) && v < best) best = v;
  console.log(`  40k-cell grid in ${ms.toFixed(0)} ms; best Δv ${(best / 1000).toFixed(2)} km/s`);
  assert.ok(ms < 2000, `grid took ${ms.toFixed(0)} ms (>2 s)`);
  assert.ok(best / 1000 < 7 && best / 1000 > 5, `optimum Δv ${(best / 1000).toFixed(2)} km/s near Hohmann`);
});
