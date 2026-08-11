// Main-thread handle to the sim worker. Owns the SABs, spawns the worker, and
// exposes a coarse API: read the latest state, change rate, jump time. It never
// advances physics itself.

import { createSharedState, readLatest, CTRL_TICK_US, FLOATS_PER_BODY, type SharedState, type SimFrame } from './protocol';

export class SimClient {
  private worker: Worker;
  readonly nBodies: number;

  // SAB mode (cross-origin isolated): shared ring, lock-free reads.
  private shared: SharedState | null = null;
  private ctrl: Int32Array | null = null;
  private dataF64: Float64Array | null = null;

  // Fallback mode (plain http, no isolation): worker posts frames; we cache the latest.
  private latest: Float64Array | null = null;
  private latestTdb = 0;
  private latestTickUs = 0;

  constructor(bodyIds: string[], startTdb: number, rate: number) {
    this.nBodies = bodyIds.length;
    const isolated = globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

    if (isolated) {
      this.shared = createSharedState(this.nBodies);
      this.ctrl = new Int32Array(this.shared.control);
      this.dataF64 = new Float64Array(this.shared.data);
    } else {
      this.latest = new Float64Array(this.nBodies * FLOATS_PER_BODY);
      this.worker.onmessage = (e: MessageEvent<SimFrame>) => {
        const f = e.data;
        if (f.type !== 'frame') return;
        this.latest!.set(f.state);
        this.latestTdb = f.tdb;
        this.latestTickUs = f.tickUs;
      };
    }

    this.worker.postMessage({
      type: 'init',
      control: this.shared?.control ?? null,
      data: this.shared?.data ?? null,
      nBodies: this.nBodies,
      bodyIds,
      tdb: startTdb,
      rate,
      // Resolve against the document base so the worker (own base URL) fetches
      // the right path whether served at root or under a subpath.
      ephUrl: new URL('data/ephemeris.bin', location.href).href,
    });
  }

  /** Copy the latest published state into `out` (nBodies*6 floats). Returns TDB. */
  readLatest(out: Float64Array): number {
    if (this.ctrl && this.dataF64) return readLatest(this.ctrl, this.dataF64, this.nBodies, out);
    out.set(this.latest!);
    return this.latestTdb;
  }

  /** Last worker sim-tick evaluate() duration, milliseconds. */
  tickMs(): number {
    if (this.ctrl) return Atomics.load(this.ctrl, CTRL_TICK_US) / 1000;
    return this.latestTickUs / 1000;
  }

  setRate(rate: number): void {
    this.worker.postMessage({ type: 'setRate', rate });
  }

  jumpTo(tdb: number): void {
    this.worker.postMessage({ type: 'jumpTo', tdb });
  }
}
