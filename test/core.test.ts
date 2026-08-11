// Core numerics run in Node with no browser (build plan §10). astronomy-engine
// is used as an independent oracle to cross-check the hand-rolled time/frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Astro from 'astronomy-engine';

import { J2000_JD, dateToTdb, tdbToDate, dateToJdUtc, jdUtcToJdTt, taiMinusUtc } from '../src/core/time';
import {
  OBLIQUITY_J2000,
  eqjToEcl,
  eclToEqj,
  precessionEqjToDate,
  applyMat3,
  mulMat3,
  transpose3,
  type Mat3,
} from '../src/core/frames';

const DAY = 86400;

test('leap seconds: 37s from 2017 onward, 10s at table start', () => {
  assert.equal(taiMinusUtc(dateToJdUtc(new Date('2026-01-01T00:00:00Z'))), 37);
  assert.equal(taiMinusUtc(dateToJdUtc(new Date('2000-06-01T00:00:00Z'))), 32);
  assert.equal(taiMinusUtc(dateToJdUtc(new Date('1972-02-01T00:00:00Z'))), 10);
});

test('TT matches astronomy-engine within a second (validates leap seconds)', () => {
  // Only near-present/past dates: astronomy-engine extrapolates ΔT into the
  // future and drifts several seconds past ~2020, where our fixed leap count
  // is the correct value. Forgetting leaps would show as a ~32s error here.
  for (const iso of ['2005-03-20T00:00:00Z', '1999-12-31T23:59:59Z', '1985-01-01T00:00:00Z']) {
    const d = new Date(iso);
    const myTtDays = jdUtcToJdTt(dateToJdUtc(d)) - J2000_JD;
    const astroTtDays = Astro.MakeTime(d).tt; // TT days past J2000
    const diffSec = Math.abs(myTtDays - astroTtDays) * DAY;
    assert.ok(diffSec < 1.0, `${iso}: TT diff ${diffSec.toFixed(3)}s`);
  }
});

test('dateToTdb / tdbToDate round-trips to under a millisecond', () => {
  for (const iso of ['2026-08-11T22:48:00Z', '1911-07-04T08:15:00Z', '2099-01-01T00:00:00Z']) {
    const d = new Date(iso);
    const back = tdbToDate(dateToTdb(d));
    // Date has 1ms resolution, so the round-trip can quantise by ±1ms.
    assert.ok(Math.abs(back.getTime() - d.getTime()) <= 1, `${iso} round-trip off by ${back.getTime() - d.getTime()}ms`);
  }
});

test('J2000 is TDB=0 at 2000-01-01 12:00 TT (~11:58:55.816 UTC)', () => {
  // TT noon J2000 in UTC = 12:00:00 - (TAI-UTC + 32.184) = 12:00:00 - 64.184s.
  const utc = new Date('2000-01-01T12:00:00Z').getTime() - 64.184 * 1000;
  const tdb = dateToTdb(new Date(utc));
  assert.ok(Math.abs(tdb) < 0.01, `TDB at J2000 epoch = ${tdb}, expected ~0`);
});

test('eqj<->ecl round-trips and matches the known obliquity tilt', () => {
  const v = new Float64Array([0, 0, 1]); // equatorial pole
  const ecl = new Float64Array(3);
  eqjToEcl(v, ecl);
  assert.ok(Math.abs(ecl[0] - 0) < 1e-12);
  assert.ok(Math.abs(ecl[1] - Math.sin(OBLIQUITY_J2000)) < 1e-12);
  assert.ok(Math.abs(ecl[2] - Math.cos(OBLIQUITY_J2000)) < 1e-12);
  const back = new Float64Array(3);
  eclToEqj(ecl, back);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-12);
});

test('eqj->ecl matches astronomy-engine EQJ->ECL rotation', () => {
  const rm = Astro.Rotation_EQJ_ECL(); // rm.rot[i][j]: source axis i -> target axis j
  const src = new Float64Array([0.3, -0.7, 0.5]);
  const mine = new Float64Array(3);
  eqjToEcl(src, mine);
  // astronomy-engine convention: target[j] = sum_i rot[i][j] * src[i]
  const ref = [0, 0, 0];
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++) ref[j] += rm.rot[i][j] * src[i];
  for (let j = 0; j < 3; j++) assert.ok(Math.abs(mine[j] - ref[j]) < 1e-9, `axis ${j}: ${mine[j]} vs ${ref[j]}`);
});

test('precession is identity at J2000 and orthonormal off-epoch', () => {
  const id = precessionEqjToDate(J2000_JD as never);
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(id[i] - (i % 4 === 0 ? 1 : 0)) < 1e-9);
  const p = precessionEqjToDate((J2000_JD + 36525) as never); // +1 century
  const shouldBeI = mulMat3(p, transpose3(p)) as Mat3;
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(shouldBeI[i] - (i % 4 === 0 ? 1 : 0)) < 1e-9);
  // 50.3"/yr general precession -> ~1.4 deg over a century in the ecliptic; the
  // equatorial matrix should visibly differ from identity.
  const v = new Float64Array([1, 0, 0]);
  const out = new Float64Array(3);
  applyMat3(p, v, out);
  const moved = Math.hypot(out[1], out[2]);
  assert.ok(moved > 0.02 && moved < 0.03, `precession over 1cy moved x-axis by ${moved}`);
});
