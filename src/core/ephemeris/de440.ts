// Runtime DE440 ephemeris: reads the baked coefficient file (tools/bake_
// ephemeris.py) and evaluates Chebyshev polynomials to barycentric ICRF state
// (equatorial J2000). Drop-in replacement for astronomy-engine's BaryState in
// P2 — sub-metre-faithful to DE440 (the bake self-checks against jplephem).
//
// Frame: ICRF ≈ equatorial J2000; the sim worker rotates to ecliptic-J2000.
// Bodies present as their true centre (Mercury/Venus/Earth/Moon), or as the
// system barycentre where DE440s carries no centre (Mars ≈ centre to <1 m;
// the giant planets differ from centre by their moons — tens–hundreds of km).
// Accuracy is sub-metre vs Horizons at the carried quantity (see de440.test.ts).
// ponytail: giant *body-centre* to sub-km would need the per-planet satellite
// kernel segments (5,599)/(6,699)/(7,799)/(8,899) added to tools/bake_ephemeris.py;
// deferred — the offset is invisible (~0.05–0.3″) at 5–30 AU.

interface Seg { center: number; target: number; init: number; intlen: number; deg1: number; nrec: number; off: number; }
interface Header { segs: Seg[]; bodies: Record<string, [number, number][]>; }

export class De440 {
  private data: Float64Array;
  private header: Header;
  private segByKey = new Map<string, Seg>();
  // Scratch Chebyshev bases, sized to the largest degree seen.
  private T: Float64Array;
  private dT: Float64Array;

  constructor(buffer: ArrayBuffer) {
    const dv = new DataView(buffer);
    const hlen = dv.getUint32(0, true);
    this.header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, hlen)));
    // Payload is float64, 8-byte aligned after the 4-byte length + header.
    this.data = new Float64Array(buffer, 4 + hlen);
    let maxDeg = 0;
    for (const s of this.header.segs) { this.segByKey.set(`${s.center},${s.target}`, s); maxDeg = Math.max(maxDeg, s.deg1); }
    this.T = new Float64Array(maxDeg);
    this.dT = new Float64Array(maxDeg);
  }

  has(body: string): boolean { return body in this.header.bodies; }

  /**
   * Barycentric state of `body` at `tdb` (SI seconds past J2000 TDB). Writes
   * position (m) into out[o..o+2] and velocity (m/s) into out[o+3..o+5],
   * ICRF/equatorial-J2000. Returns false if the body is unknown.
   */
  state(body: string, tdb: number, out: Float64Array, o = 0): boolean {
    const chain = this.header.bodies[body];
    if (!chain) return false;
    let px = 0, py = 0, pz = 0, vx = 0, vy = 0, vz = 0;
    for (const [c, t] of chain) {
      const s = this.segByKey.get(`${c},${t}`)!;
      // Record + normalised time τ ∈ [-1,1] within it.
      let rec = Math.floor((tdb - s.init) / s.intlen);
      if (rec < 0) rec = 0; else if (rec >= s.nrec) rec = s.nrec - 1;
      const t0 = s.init + rec * s.intlen;
      const tau = (2 * (tdb - t0)) / s.intlen - 1;
      const d = s.deg1;
      const T = this.T, dT = this.dT;
      T[0] = 1; dT[0] = 0;
      if (d > 1) { T[1] = tau; dT[1] = 1; }
      for (let i = 2; i < d; i++) {
        T[i] = 2 * tau * T[i - 1] - T[i - 2];
        dT[i] = 2 * T[i - 1] + 2 * tau * dT[i - 1] - dT[i - 2];
      }
      // Record layout: [x0..xd, y0..yd, z0..zd], km. Velocity scale: d/dtdb.
      const base = s.off + rec * 3 * d;
      const vscale = 2 / s.intlen;
      let sx = 0, sy = 0, sz = 0, dvx = 0, dvy = 0, dvz = 0;
      for (let k = 0; k < d; k++) {
        const cx = this.data[base + k], cy = this.data[base + d + k], cz = this.data[base + 2 * d + k];
        sx += cx * T[k]; sy += cy * T[k]; sz += cz * T[k];
        dvx += cx * dT[k]; dvy += cy * dT[k]; dvz += cz * dT[k];
      }
      px += sx; py += sy; pz += sz;
      vx += dvx * vscale; vy += dvy * vscale; vz += dvz * vscale;
    }
    // km, km/s -> m, m/s.
    out[o] = px * 1000; out[o + 1] = py * 1000; out[o + 2] = pz * 1000;
    out[o + 3] = vx * 1000; out[o + 4] = vy * 1000; out[o + 5] = vz * 1000;
    return true;
  }
}
