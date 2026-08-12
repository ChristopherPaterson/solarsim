// Izzo's Lambert solver (build plan §7 P3.5 item 9): given two position vectors
// and a time of flight, find the connecting conic's terminal velocities.
// Converges in 2-3 Householder iterations. Reference: Izzo, "Revisiting
// Lambert's problem" (2015); this mirrors the poliastro/hapsira implementation.
// Single-revolution (M=0) — the case porkchop grids and Hohmann transfers need.

const cross = (a: Float64Array, b: Float64Array, o: Float64Array): void => {
  o[0] = a[1] * b[2] - a[2] * b[1]; o[1] = a[2] * b[0] - a[0] * b[2]; o[2] = a[0] * b[1] - a[1] * b[0];
};
const norm = (a: Float64Array): number => Math.hypot(a[0], a[1], a[2]);

// ₂F₁(3,1,5/2,x) series — the Battin region of the time-of-flight equation.
function hyp2f1b(x: number): number {
  if (x >= 1) return Infinity;
  let res = 1, term = 1, i = 0;
  for (;;) {
    term *= ((3 + i) * (1 + i)) / (2.5 + i) * x / (i + 1);
    const next = res + term;
    if (next === res) return next;
    res = next; i++;
    if (i > 10000) return res;
  }
}

const computeY = (x: number, ll: number): number => Math.sqrt(1 - ll * ll * (1 - x * x));

function computePsi(x: number, y: number, ll: number): number {
  if (-1 <= x && x < 1) return Math.acos(x * y + ll * (1 - x * x));       // ellipse
  if (x > 1) return Math.asinh((y - x * ll) * Math.sqrt(x * x - 1));       // hyperbola
  return 0;
}

// T(x) − T0 (nondimensional time of flight minus target), M=0.
function tofEq(x: number, y: number, T0: number, ll: number): number {
  let T_;
  if (Math.sqrt(0.6) < x && x < Math.sqrt(1.4)) {
    const eta = y - ll * x;
    const S1 = (1 - ll - x * eta) * 0.5;
    const Q = (4 / 3) * hyp2f1b(S1);
    T_ = (eta * eta * eta * Q + 4 * ll * eta) * 0.5;
  } else {
    const psi = computePsi(x, y, ll);
    T_ = (((psi + 0) / Math.sqrt(Math.abs(1 - x * x))) - x + ll * y) / (1 - x * x);
  }
  return T_ - T0;
}

const tofP = (x: number, y: number, T: number, ll: number): number =>
  (3 * T * x - 2 + 2 * ll * ll * ll * x / y) / (1 - x * x);
const tofP2 = (x: number, y: number, T: number, dT: number, ll: number): number =>
  (3 * T + 5 * x * dT + 2 * (1 - ll * ll) * ll * ll * ll / (y * y * y)) / (1 - x * x);
const tofP3 = (x: number, y: number, dT: number, ddT: number, ll: number): number =>
  (7 * x * ddT + 8 * dT - 6 * (1 - ll * ll) * ll ** 5 * x / y ** 5) / (1 - x * x);

function initialGuess(T: number, ll: number): number {
  const T0 = tofEq(0, computeY(0, ll), 0, ll); // T at x=0
  const T1 = (2 / 3) * (1 - ll * ll * ll);       // T at x=1
  if (T >= T0) return (T0 / T) ** (2 / 3) - 1;
  if (T < T1) return (5 / 2) * (T1 / T) * (T1 - T) / (1 - ll ** 5) + 1;
  return (T0 / T) ** (Math.log2(T1 / T0)) - 1;
}

function householder(T: number, ll: number): number {
  let x = initialGuess(T, ll);
  for (let it = 0; it < 35; it++) {
    const y = computeY(x, ll);
    const f = tofEq(x, y, T, ll);
    const Tx = f + T;
    const fp = tofP(x, y, Tx, ll);
    const fp2 = tofP2(x, y, Tx, fp, ll);
    const fp3 = tofP3(x, y, fp, fp2, ll);
    const dx = f * (fp * fp - f * fp2 / 2) / (fp * (fp * fp - f * fp2) + fp3 * f * f / 6);
    x -= dx;
    if (Math.abs(dx) < 1e-12) break;
  }
  return x;
}

export interface LambertSolution { v1: Float64Array; v2: Float64Array; }

/** Solve Lambert's problem: velocities at r1 and r2 for a transfer of `tof`
 *  about a body of parameter `mu`. `prograde` picks the transfer sense. */
export function lambert(r1: Float64Array, r2: Float64Array, tof: number, mu: number, prograde = true): LambertSolution {
  const r1n = norm(r1), r2n = norm(r2);
  const c = new Float64Array([r2[0] - r1[0], r2[1] - r1[1], r2[2] - r1[2]]);
  const cn = norm(c);
  const s = (r1n + r2n + cn) / 2;
  const ir1 = new Float64Array([r1[0] / r1n, r1[1] / r1n, r1[2] / r1n]);
  const ir2 = new Float64Array([r2[0] / r2n, r2[1] / r2n, r2[2] / r2n]);
  const ih = new Float64Array(3); cross(ir1, ir2, ih);
  const ihn = norm(ih); ih[0] /= ihn; ih[1] /= ihn; ih[2] /= ihn;
  let ll = Math.sqrt(Math.max(0, 1 - Math.min(1, cn / s)));
  const it1 = new Float64Array(3), it2 = new Float64Array(3);
  if (ih[2] < 0) {
    ll = -ll;
    cross(ir1, ih, it1); cross(ir2, ih, it2);
  } else {
    cross(ih, ir1, it1); cross(ih, ir2, it2);
  }
  if (!prograde) { ll = -ll; for (let k = 0; k < 3; k++) { it1[k] = -it1[k]; it2[k] = -it2[k]; } }

  const T = Math.sqrt((2 * mu) / (s * s * s)) * tof;
  const x = householder(T, ll);
  const y = computeY(x, ll);

  const gamma = Math.sqrt((mu * s) / 2);
  const rho = (r1n - r2n) / cn;
  const sigma = Math.sqrt(1 - rho * rho);
  const Vr1 = gamma * ((ll * y - x) - rho * (ll * y + x)) / r1n;
  const Vr2 = -gamma * ((ll * y - x) + rho * (ll * y + x)) / r2n;
  const Vt1 = (gamma * sigma * (y + ll * x)) / r1n;
  const Vt2 = (gamma * sigma * (y + ll * x)) / r2n;
  const v1 = new Float64Array(3), v2 = new Float64Array(3);
  for (let k = 0; k < 3; k++) {
    v1[k] = Vr1 * ir1[k] + Vt1 * it1[k];
    v2[k] = Vr2 * ir2[k] + Vt2 * it2[k];
  }
  return { v1, v2 };
}
