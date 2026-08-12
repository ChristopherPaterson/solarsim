// Sphere-of-influence radius (build plan §7 P3.5 item 7): r_SOI = a·(m/M)^(2/5).
// Validates the gm data + the formula against published values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOLAR_SYSTEM } from '../src/data/bodies';
import { AU_M } from '../src/core/units';

const gm = (id: string) => SOLAR_SYSTEM.find((b) => b.id === id)!.gm;
const rSOI = (id: string, aAU: number) => aAU * AU_M * Math.pow(gm(id) / gm('Sun'), 0.4) / 1e9; // millions of km

test('SOI radii match published values', () => {
  // (id, semi-major axis AU, published r_SOI in millions of km)
  const cases: [string, number, number][] = [
    ['Earth', 1.0, 0.924], ['Mars', 1.524, 0.576], ['Jupiter', 5.204, 48.2], ['Neptune', 30.07, 86.2],
  ];
  for (const [id, a, expected] of cases) {
    const r = rSOI(id, a);
    console.log(`  ${id.padEnd(8)} r_SOI ${r.toFixed(3)}e6 km (published ${expected})`);
    assert.ok(Math.abs(r - expected) / expected < 0.03, `${id}: ${r.toFixed(2)} vs ${expected} (>3%)`);
  }
});
