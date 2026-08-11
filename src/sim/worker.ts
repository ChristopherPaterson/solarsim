// Sim worker: the time authority (build plan §4.1). Advances TDB, evaluates
// barycentric state for every body (P1: astronomy-engine BaryState), converts
// to SI + ecliptic-J2000, and publishes into the SAB ring. The main thread
// never advances physics.

import * as Astro from 'astronomy-engine';
import { AU_M, DAY_S } from '../core/units';
import { eqjToEcl } from '../core/frames';
import { tdbToDate } from '../core/time';
import { publish, FLOATS_PER_BODY, type SimCommand } from './protocol';

const TICK_MS = 16; // ~60 Hz sim
const AU_PER_DAY_TO_M_S = AU_M / DAY_S;

let ctrl: Int32Array | null = null;
let data: Float64Array | null = null;
let nBodies = 0;
let bodies: Astro.Body[] = [];
let scratch = new Float64Array(0);

let simTdb = 0; // TDB seconds past J2000
let rate = 0; // sim seconds per real second
let lastReal = performance.now();
const tmp = new Float64Array(3);

function evaluate(): void {
  if (!ctrl || !data) return;
  const date = tdbToDate(simTdb as never);
  for (let i = 0; i < nBodies; i++) {
    const s = Astro.BaryState(bodies[i], date); // AU, AU/day, equatorial J2000
    tmp[0] = s.x * AU_M; tmp[1] = s.y * AU_M; tmp[2] = s.z * AU_M;
    eqjToEcl(tmp, tmp);
    const b = i * FLOATS_PER_BODY;
    scratch[b] = tmp[0]; scratch[b + 1] = tmp[1]; scratch[b + 2] = tmp[2];
    tmp[0] = s.vx * AU_PER_DAY_TO_M_S; tmp[1] = s.vy * AU_PER_DAY_TO_M_S; tmp[2] = s.vz * AU_PER_DAY_TO_M_S;
    eqjToEcl(tmp, tmp);
    scratch[b + 3] = tmp[0]; scratch[b + 4] = tmp[1]; scratch[b + 5] = tmp[2];
  }
  publish(ctrl, data, nBodies, simTdb, scratch);
}

function tick(): void {
  const now = performance.now();
  const dtReal = (now - lastReal) / 1000;
  lastReal = now;
  if (rate !== 0) simTdb += dtReal * rate;
  evaluate();
}

self.onmessage = (e: MessageEvent<SimCommand>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      ctrl = new Int32Array(msg.control);
      data = new Float64Array(msg.data);
      nBodies = msg.nBodies;
      bodies = msg.bodyIds.map((id) => (Astro.Body as Record<string, Astro.Body>)[id]);
      scratch = new Float64Array(nBodies * FLOATS_PER_BODY);
      simTdb = msg.tdb;
      rate = msg.rate;
      lastReal = performance.now();
      evaluate(); // publish an initial frame immediately
      setInterval(tick, TICK_MS);
      break;
    case 'setRate':
      rate = msg.rate;
      break;
    case 'jumpTo':
      simTdb = msg.tdb;
      evaluate();
      break;
  }
};
