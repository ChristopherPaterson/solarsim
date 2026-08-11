// Sim worker: the time authority (build plan §4.1). Advances TDB, evaluates
// barycentric state for every body from the baked DE440 ephemeris (P2), converts
// ICRF -> ecliptic-J2000, and publishes into the SAB ring. The main thread never
// advances physics.

import { eqjToEcl } from '../core/frames';
import { De440 } from '../core/ephemeris/de440';
import { publish, FLOATS_PER_BODY, CTRL_TICK_US, type SimCommand, type SimFrame } from './protocol';

const TICK_MS = 16; // ~60 Hz sim

let ctrl: Int32Array | null = null;
let data: Float64Array | null = null;
let nBodies = 0;
let bodyIds: string[] = [];
let eph: De440 | null = null;
let scratch = new Float64Array(0);

let simTdb = 0; // TDB seconds past J2000
let rate = 0; // sim seconds per real second
let lastReal = performance.now();
const tmp = new Float64Array(6);

// Fill `scratch` with the barycentric state for the current simTdb. No publish.
function computeState(): void {
  if (!eph) return;
  for (let i = 0; i < nBodies; i++) {
    eph.state(bodyIds[i], simTdb, tmp); // m, m/s, ICRF/equatorial-J2000
    const b = i * FLOATS_PER_BODY;
    eqjToEcl(tmp.subarray(0, 3), tmp.subarray(0, 3)); // position -> ecliptic
    eqjToEcl(tmp.subarray(3, 6), tmp.subarray(3, 6)); // velocity -> ecliptic
    scratch[b] = tmp[0]; scratch[b + 1] = tmp[1]; scratch[b + 2] = tmp[2];
    scratch[b + 3] = tmp[3]; scratch[b + 4] = tmp[4]; scratch[b + 5] = tmp[5];
  }
}

// Compute one frame (timing it) and publish. SAB mode writes the ring; the
// no-isolation fallback posts a copy back to the main thread.
function publishFrame(): void {
  if (!eph) return;
  const t0 = performance.now();
  computeState();
  const tickUs = Math.round((performance.now() - t0) * 1000);
  if (ctrl && data) {
    publish(ctrl, data, nBodies, simTdb, scratch);
    Atomics.store(ctrl, CTRL_TICK_US, tickUs);
  } else {
    const frame: SimFrame = { type: 'frame', tdb: simTdb, tickUs, state: scratch.slice(0, nBodies * FLOATS_PER_BODY) };
    self.postMessage(frame);
  }
}

function tick(): void {
  const now = performance.now();
  const dtReal = (now - lastReal) / 1000;
  lastReal = now;
  if (rate !== 0) simTdb += dtReal * rate;
  publishFrame();
}

self.onmessage = (e: MessageEvent<SimCommand>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      ctrl = msg.control ? new Int32Array(msg.control) : null;
      data = msg.data ? new Float64Array(msg.data) : null;
      nBodies = msg.nBodies;
      bodyIds = msg.bodyIds;
      scratch = new Float64Array(nBodies * FLOATS_PER_BODY);
      simTdb = msg.tdb;
      rate = msg.rate;
      // Load the baked DE440 ephemeris, then start ticking (the main thread just
      // reads zeros until the first frame publishes, same as before).
      fetch(msg.ephUrl)
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          eph = new De440(buf);
          lastReal = performance.now();
          publishFrame(); // first frame as soon as the ephemeris is ready
          setInterval(tick, TICK_MS);
        })
        .catch((err) => console.error('SolarSim: ephemeris load failed', err));
      break;
    case 'setRate':
      rate = msg.rate;
      break;
    case 'jumpTo':
      simTdb = msg.tdb;
      publishFrame();
      break;
  }
};
