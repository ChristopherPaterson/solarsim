// SharedArrayBuffer ring buffer between the sim worker (producer, time
// authority) and the render loop (consumer). State crosses as Float64 only,
// never objects (build plan §4.1). Triple-buffered: with one producer and one
// consumer, the producer always writes the slot the consumer is not reading,
// so no lock is needed — the consumer just reads whatever slot was last
// published atomically.

export const N_SLOTS = 3;
export const FLOATS_PER_BODY = 6; // x,y,z,vx,vy,vz (SI, ecliptic-J2000, barycentric)

// Control Int32Array indices.
export const CTRL_LATEST = 0; // slot index the consumer should read
export const CTRL_SEQ = 1; // publish counter (monotonic)
export const CTRL_TICK_US = 2; // last sim-tick evaluate() duration, microseconds
export const CTRL_LEN = 3;

/** Float64 per slot: 1 time word (TDB) + one 6-vector per body. */
export const slotFloats = (nBodies: number): number => 1 + nBodies * FLOATS_PER_BODY;

// Commands main -> worker. Low frequency, so plain postMessage (not the ring).
// `control`/`data` are null in the no-SAB fallback (plain-http LAN, no
// cross-origin isolation) — the worker then ships each frame back via postMessage.
export type SimCommand =
  | { type: 'init'; control: SharedArrayBuffer | null; data: SharedArrayBuffer | null; nBodies: number; bodyIds: string[]; tdb: number; rate: number }
  | { type: 'setRate'; rate: number } // sim seconds per real second; 0 = paused
  | { type: 'jumpTo'; tdb: number };

// Worker -> main, no-SAB fallback only. One per sim tick; `state` is a copy
// (nBodies*6 floats), cheap to structured-clone at ~630 B / 60 Hz.
export type SimFrame = { type: 'frame'; tdb: number; tickUs: number; state: Float64Array };

export interface SharedState {
  control: SharedArrayBuffer; // Int32, CTRL_LEN words
  data: SharedArrayBuffer; // Float64, N_SLOTS * slotFloats
  nBodies: number;
}

export function createSharedState(nBodies: number): SharedState {
  return {
    control: new SharedArrayBuffer(CTRL_LEN * Int32Array.BYTES_PER_ELEMENT),
    data: new SharedArrayBuffer(N_SLOTS * slotFloats(nBodies) * Float64Array.BYTES_PER_ELEMENT),
    nBodies,
  };
}

/**
 * Producer-side. Writes tdb + the nBodies*6 state vector into the next slot
 * (the one the consumer is not reading), then publishes it atomically.
 * Returns the slot written.
 */
export function publish(
  ctrl: Int32Array,
  data: Float64Array,
  nBodies: number,
  tdb: number,
  state: Float64Array,
): number {
  const width = slotFloats(nBodies);
  const latest = Atomics.load(ctrl, CTRL_LATEST);
  const slot = (latest + 1) % N_SLOTS;
  const base = slot * width;
  data[base] = tdb;
  data.set(state.subarray(0, nBodies * FLOATS_PER_BODY), base + 1);
  Atomics.store(ctrl, CTRL_LATEST, slot);
  Atomics.add(ctrl, CTRL_SEQ, 1);
  return slot;
}

/**
 * Consumer-side. Copies the latest published state into `outState` and returns
 * its TDB. `outState` must hold at least nBodies*6 floats.
 */
export function readLatest(
  ctrl: Int32Array,
  data: Float64Array,
  nBodies: number,
  outState: Float64Array,
): number {
  const width = slotFloats(nBodies);
  const slot = Atomics.load(ctrl, CTRL_LATEST);
  const base = slot * width;
  outState.set(data.subarray(base + 1, base + width));
  return data[base];
}
