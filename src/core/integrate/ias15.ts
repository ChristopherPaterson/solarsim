// IAS15: 15th-order Gauss-Radau integrator, adaptive timestep (Rein & Spiegel
// 2015, MNRAS 446, 1424; the REBOUND algorithm), reimplemented in TypeScript.
// Machine-precision energy behaviour over huge orbit counts — the reason the
// build plan forbids RK4/Euler here (§7 P3): fixed low-order schemes let energy
// drift eat the system, IAS15 does not.
//
// Generic: advances N particles (3N coords) under an acceleration field
// a(t, x). Gravity is position-only, so no velocity-dependent-force machinery.
// Used for test particles in the moving ephemeris field and (later) full N-body.

export type AccelFn = (t: number, x: Float64Array, aOut: Float64Array) => void;

// Gauss-Radau spacing (nodes), h[0]=0. Substep i evaluates accel at t + h[i]*dt.
const H = [0.0, 0.0562625605369221464656522, 0.1802406917368923649875799,
  0.3526247171131696373739078, 0.5471536263305553830014486,
  0.7342101772154105315232106, 0.8853209468390957680903598,
  0.9775206135612875018911745];

// Predictor-corrector constants: b_i are updated from Δg_n by these c-coeffs
// (lower-triangular, 21 entries; Everhart 1985 / REBOUND integrator_ias15.c).
const C = [
  -0.0562625605369221464656522,
  0.01014080283006362998648180399549641417413495311078, -0.2365032522738145114532321,
  -0.0035758977292516175949344589284567187362040464593728, 0.09353769525946206589574845561035371499343547051116, -0.5891279693869841488271399,
  0.0019565654099472210769005672379668610648179838140913, -0.054755386889068686440808430671055022602028382584495, 0.41588120008230686168862193041156933067050816537030, -1.1362815957175395318285885,
  -0.0014365302363708915424459554194153247134438571962198, 0.042158527721268707707297347813203202980228135395858, -0.36009959650205681228976646105758791805550068085075, 1.2501507118406910258505441186857527694077565516084, -1.8704917729329500633517991,
  0.0012717903090268677492943117622964220889484666147501, -0.038760357915906770369904626849901899108502158354383, 0.36096224345284598322533983078129066420907893718190, -1.4668842084004269643701553461378480148761655599754, 2.9061362593084293014237914371173946705384212479246, -2.7558127197720458314421589,
];

// Which C indices apply when g[n] changes: b[0..n-1] += C[cbase+j]*Δg, b[n] += Δg.
const CBASE = [0, 0, 1, 3, 6, 10, 15];

export class IAS15 {
  readonly n: number; // particle count
  private n3: number;
  readonly x: Float64Array; // positions, 3N
  readonly v: Float64Array; // velocities, 3N
  private accel: AccelFn;
  epsilon = 1e-9; // per-step accuracy target (adaptive-dt controller)

  // Per-step work arrays.
  private a0: Float64Array;
  private at: Float64Array; // accel at current substep
  private xs: Float64Array; // predicted position at current substep
  private b: Float64Array[]; // b[0..6], each 3N
  private g: Float64Array[]; // g[0..6], each 3N
  private csx: Float64Array; // compensated-summation error for x
  private csv: Float64Array;

  constructor(n: number, accel: AccelFn) {
    this.n = n; this.n3 = 3 * n; this.accel = accel;
    this.x = new Float64Array(this.n3);
    this.v = new Float64Array(this.n3);
    this.a0 = new Float64Array(this.n3);
    this.at = new Float64Array(this.n3);
    this.xs = new Float64Array(this.n3);
    this.b = Array.from({ length: 7 }, () => new Float64Array(this.n3));
    this.g = Array.from({ length: 7 }, () => new Float64Array(this.n3));
    this.csx = new Float64Array(this.n3);
    this.csv = new Float64Array(this.n3);
  }

  /** One Gauss-Radau step of size dt from time t. Returns the b6/a0 error ratio
   *  used to size the next step. Cold-starts b each step (robust; a few extra
   *  predictor-corrector sweeps) and iterates until b6 converges. */
  step(t: number, dt: number): number {
    const { n3, x, v, a0, at, xs, b, g } = this;
    for (let k = 0; k < 7; k++) { b[k].fill(0); g[k].fill(0); }
    this.accel(t, x, a0); // acceleration at the step start

    let prevB6 = 0;
    for (let iter = 0; iter < 12; iter++) {
      for (let sub = 1; sub <= 7; sub++) {
        const s = H[sub];
        // Predicted position at substep s. With a(s)=a0+Σ b_k s^{k+1}, position
        // is x0 + dt·s·v0 + dt²·s²·[a0/2 + Σ b_k s^{k+1}/((k+2)(k+3))]. Horner:
        for (let k = 0; k < n3; k++) {
          let I = b[6][k] / 72;
          I = b[5][k] / 56 + s * I; I = b[4][k] / 42 + s * I; I = b[3][k] / 30 + s * I;
          I = b[2][k] / 20 + s * I; I = b[1][k] / 12 + s * I; I = b[0][k] / 6 + s * I;
          I = a0[k] / 2 + s * I;
          xs[k] = x[k] + dt * s * v[k] + dt * dt * s * s * I;
        }
        this.accel(t + s * dt, xs, at);
        // Divided differences -> g[sub-1], then fold Δg into the b coefficients.
        const gi = sub - 1;
        for (let k = 0; k < n3; k++) {
          let tmp = (at[k] - a0[k]) / s;
          for (let j = 0; j < gi; j++) tmp = (tmp - g[j][k]) / (H[sub] - H[j + 1]);
          const dg = tmp - g[gi][k];
          g[gi][k] = tmp;
          const base = CBASE[gi];
          for (let j = 0; j < gi; j++) b[j][k] += C[base + j] * dg;
          b[gi][k] += dg;
        }
      }
      // Convergence: relative change of the last b coefficient.
      let maxB6 = 0, maxA = 0;
      for (let k = 0; k < n3; k++) { const ab = Math.abs(b[6][k]); if (ab > maxB6) maxB6 = ab; const aa = Math.abs(a0[k]); if (aa > maxA) maxA = aa; }
      if (iter > 0 && Math.abs(maxB6 - prevB6) <= 1e-16 * maxA) break;
      prevB6 = maxB6;
    }

    // Final update with compensated summation (kills round-off over long runs).
    const csx = this.csx, csv = this.csv;
    for (let k = 0; k < n3; k++) {
      const dx = dt * v[k] + dt * dt * (a0[k] / 2 + b[0][k] / 6 + b[1][k] / 12 + b[2][k] / 20 +
        b[3][k] / 30 + b[4][k] / 42 + b[5][k] / 56 + b[6][k] / 72);
      const dv = dt * (a0[k] + b[0][k] / 2 + b[1][k] / 3 + b[2][k] / 4 + b[3][k] / 5 +
        b[4][k] / 6 + b[5][k] / 7 + b[6][k] / 8);
      let yx = dx - csx[k]; let sx = x[k] + yx; csx[k] = (sx - x[k]) - yx; x[k] = sx;
      let yv = dv - csv[k]; let sv = v[k] + yv; csv[k] = (sv - v[k]) - yv; v[k] = sv;
    }

    // Error estimate for the adaptive controller: |b6| / |a0|, max over coords.
    let maxB6 = 0, maxA = 0;
    for (let k = 0; k < n3; k++) { const ab = Math.abs(b[6][k]); if (ab > maxB6) maxB6 = ab; const aa = Math.abs(a0[k]); if (aa > maxA) maxA = aa; }
    return maxA > 0 ? maxB6 / maxA : 0;
  }

  /** Optimal next dt from the last step's error ratio (order-15 scaling). */
  nextDt(dt: number, errorRatio: number): number {
    if (errorRatio <= 0) return dt * 4;
    const factor = Math.pow(this.epsilon / errorRatio, 1 / 7);
    return dt * Math.min(4, Math.max(0.2, factor)); // clamp growth/shrink per step
  }
}
