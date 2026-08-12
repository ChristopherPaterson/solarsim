// P3.5 acceptance (build plan §7): an Apollo-class vessel cannot reach Jupiter,
// and a 1-g torch Earth–Mars run reports ~49 h and ~1750 km/s.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deltaVBudget, requiredPropellant, massRatio, torchTime, torchDeltaV, torchPeakV } from '../src/core/spacecraft/propulsion';
import { G0, AU_M } from '../src/core/units';

test('rocket equation: an Apollo-class vessel cannot reach Jupiter', () => {
  // Apollo CSM on the SPS engine (Isp 314 s): ~11.9 t dry, ~18.4 t propellant.
  const budget = deltaVBudget(11_900, 18_400, 314);
  // Earth->Jupiter Hohmann heliocentric departure Δv (perihelion of a 1->5.2 AU
  // transfer minus Earth's orbital speed).
  const muSun = 1.32712440018e20, rE = AU_M, rJ = 5.2 * AU_M, aT = (rE + rJ) / 2;
  const vE = Math.sqrt(muSun / rE);
  const vPeri = Math.sqrt(muSun * (2 / rE - 1 / aT));
  const jupiterDeltaV = vPeri - vE;
  console.log(`  Apollo Δv ${(budget / 1000).toFixed(2)} km/s  vs Jupiter needs ${(jupiterDeltaV / 1000).toFixed(2)} km/s`);
  assert.ok(budget < jupiterDeltaV, 'Apollo should fall short of Jupiter');
  assert.ok(budget > 2000 && budget < 4000, `Apollo Δv sanity ${(budget / 1000).toFixed(2)} km/s`);
});

test('rocket equation round-trips (budget <-> required propellant)', () => {
  const prop = requiredPropellant(28_000, 3400, 314);
  assert.ok(Math.abs(deltaVBudget(28_000, prop, 314) - 3400) < 1e-6);
  assert.ok(Math.abs(massRatio(314 * G0, 314) - Math.E) < 1e-9); // Δv=Isp·g₀ -> ratio e
});

test('torch: 1-g Earth-Mars reports ~49 h and ~1750 km/s', () => {
  const d = 0.5 * AU_M; // representative Earth-Mars distance
  const t = torchTime(d, G0), dv = torchDeltaV(d, G0), vpk = torchPeakV(d, G0);
  console.log(`  torch 1g over 0.5 AU: ${(t / 3600).toFixed(1)} h, Δv ${(dv / 1000).toFixed(0)} km/s, peak ${(vpk / 1000).toFixed(0)} km/s`);
  assert.ok(Math.abs(t / 3600 - 49) < 3, `time ${(t / 3600).toFixed(1)} h`);
  assert.ok(Math.abs(dv / 1000 - 1750) < 100, `Δv ${(dv / 1000).toFixed(0)} km/s`);
  assert.ok(Math.abs(vpk - dv / 2) < 1, 'peak = Δv/2');
});
