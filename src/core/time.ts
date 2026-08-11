// The single time authority (build plan §4.3, trap: "ad hoc Julian date
// arithmetic in twelve places"). Internal time is TDB seconds past J2000.
// Everything else converts through here.
//
// Scale chain:  UTC --(leap seconds)--> TAI --(+32.184s)--> TT --(periodic)--> TDB
//
// J2000 = 2000-01-01 12:00:00 TT = JD 2451545.0 (TT).

import type { TDB, JD_UTC, JD_TT } from './units';

export const J2000_JD = 2451545.0;
export const UNIX_EPOCH_JD = 2440587.5; // JD at 1970-01-01T00:00:00Z
export const TT_MINUS_TAI = 32.184; // seconds, fixed by definition

// Cumulative TAI-UTC (leap seconds), keyed by the UTC JD at which each takes
// effect. IERS table, complete through 2017-01-01 (no leaps since). Star-field
// alignment needs this: Earth turns ~15"/s, so the 37s offset is ~9' of arc.
const LEAP_SECONDS: ReadonlyArray<[jdUtc: number, taiMinusUtc: number]> = [
  [2441317.5, 10], // 1972-01-01
  [2441499.5, 11], // 1972-07-01
  [2441683.5, 12], // 1973-01-01
  [2442048.5, 13], // 1974-01-01
  [2442413.5, 14], // 1975-01-01
  [2442778.5, 15], // 1976-01-01
  [2443144.5, 16], // 1977-01-01
  [2443509.5, 17], // 1978-01-01
  [2443874.5, 18], // 1979-01-01
  [2444239.5, 19], // 1980-01-01
  [2444786.5, 20], // 1981-07-01
  [2445151.5, 21], // 1982-07-01
  [2445516.5, 22], // 1983-07-01
  [2446247.5, 23], // 1985-07-01
  [2447161.5, 24], // 1988-01-01
  [2447892.5, 25], // 1990-01-01
  [2448257.5, 26], // 1991-01-01
  [2448804.5, 27], // 1992-07-01
  [2449169.5, 28], // 1993-07-01
  [2449534.5, 29], // 1994-07-01
  [2450083.5, 30], // 1996-01-01
  [2450630.5, 31], // 1997-07-01
  [2451179.5, 32], // 1999-01-01
  [2453736.5, 33], // 2006-01-01
  [2454832.5, 34], // 2009-01-01
  [2456109.5, 35], // 2012-07-01
  [2457204.5, 36], // 2015-07-01
  [2457754.5, 37], // 2017-01-01
];

/** TAI-UTC in seconds at the given UTC Julian Date. */
export function taiMinusUtc(jdUtc: number): number {
  // ponytail: pre-1972 uses the earliest table value (10s) rather than the
  // fractional TAI-UTC drift. Fine for planet positions (sub-second is
  // negligible there); upgrade to a ΔT model if pre-1972 surface-observer
  // star alignment is ever needed.
  let v = LEAP_SECONDS[0][1];
  for (const [jd, s] of LEAP_SECONDS) {
    if (jdUtc >= jd) v = s;
    else break;
  }
  return v;
}

/** JS Date (POSIX/UTC) -> UTC Julian Date. */
export function dateToJdUtc(date: Date): JD_UTC {
  return (date.getTime() / 86400000 + UNIX_EPOCH_JD) as JD_UTC;
}

/** UTC Julian Date -> JS Date. */
export function jdUtcToDate(jd: JD_UTC): Date {
  return new Date((jd - UNIX_EPOCH_JD) * 86400000);
}

/** TT Julian Date from a UTC Julian Date. */
export function jdUtcToJdTt(jdUtc: JD_UTC): JD_TT {
  return (jdUtc + (taiMinusUtc(jdUtc) + TT_MINUS_TAI) / 86400) as JD_TT;
}

/**
 * TDB - TT in seconds. Fairhead & Bretagnon leading periodic term (<2 ms),
 * ample for this project. g is Earth's mean anomaly.
 */
export function tdbMinusTt(jdTt: JD_TT): number {
  const g = (357.53 + 0.9856003 * (jdTt - J2000_JD)) * (Math.PI / 180);
  return 0.001658 * Math.sin(g) + 0.000014 * Math.sin(2 * g);
}

/** JS Date -> TDB seconds past J2000, the internal time coordinate. */
export function dateToTdb(date: Date): TDB {
  const jdUtc = dateToJdUtc(date);
  const jdTt = jdUtcToJdTt(jdUtc);
  const tdbJd = jdTt + tdbMinusTt(jdTt) / 86400;
  return ((tdbJd - J2000_JD) * 86400) as TDB;
}

/** TDB seconds past J2000 -> JS Date (for display). Inverts dateToTdb. */
export function tdbToDate(tdb: TDB): Date {
  const tdbJd = J2000_JD + tdb / 86400;
  // TDB->TT: the periodic term depends on TT, but TDB~TT to <2ms so evaluating
  // it at tdbJd is exact to well under the millisecond Date can represent.
  const jdTt = (tdbJd - tdbMinusTt(tdbJd as JD_TT) / 86400) as JD_TT;
  // Invert TT->UTC: subtract (TAI-UTC + 32.184). TAI-UTC steps only at leap
  // boundaries, so one settle pass suffices.
  let jdUtc = jdTt - TT_MINUS_TAI / 86400;
  jdUtc -= taiMinusUtc(jdUtc) / 86400;
  return jdUtcToDate(jdUtc as JD_UTC);
}

/** TT Julian Date from internal TDB (for ephemeris/precession routines). */
export function tdbToJdTt(tdb: TDB): JD_TT {
  return (J2000_JD + tdb / 86400) as JD_TT;
}
