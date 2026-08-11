// Main-thread handle to the sim worker. Owns the SABs, spawns the worker, and
// exposes a coarse API: read the latest state, change rate, jump time. It never
// advances physics itself.

import { createSharedState, readLatest, type SharedState } from './protocol';

export class SimClient {
  private worker: Worker;
  private shared: SharedState;
  private ctrl: Int32Array;
  private dataF64: Float64Array;
  readonly nBodies: number;

  constructor(bodyIds: string[], startTdb: number, rate: number) {
    this.nBodies = bodyIds.length;
    this.shared = createSharedState(this.nBodies);
    this.ctrl = new Int32Array(this.shared.control);
    this.dataF64 = new Float64Array(this.shared.data);
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.postMessage({
      type: 'init',
      control: this.shared.control,
      data: this.shared.data,
      nBodies: this.nBodies,
      bodyIds,
      tdb: startTdb,
      rate,
    });
  }

  /** Copy the latest published state into `out` (nBodies*6 floats). Returns TDB. */
  readLatest(out: Float64Array): number {
    return readLatest(this.ctrl, this.dataF64, this.nBodies, out);
  }

  setRate(rate: number): void {
    this.worker.postMessage({ type: 'setRate', rate });
  }

  jumpTo(tdb: number): void {
    this.worker.postMessage({ type: 'jumpTo', tdb });
  }
}
