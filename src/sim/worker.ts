// Sim worker: the time authority (build plan §4.1). Advances TDB, evaluates
// barycentric state for every body from the baked DE440 ephemeris (P2), converts
// ICRF -> ecliptic-J2000, and publishes into the SAB ring. The main thread never
// advances physics.

import { eqjToEcl } from '../core/frames';
import { De440 } from '../core/ephemeris/de440';
import { IAS15 } from '../core/integrate/ias15';
import { SOLAR_SYSTEM } from '../data/bodies';
import { publish, FLOATS_PER_BODY, CTRL_TICK_US, type SimCommand, type SimFrame, type ParticleFrame } from './protocol';

const TICK_MS = 16; // ~60 Hz sim
const MAX_PARTICLES = 64;
const MAX_SUBSTEPS = 400; // per frame, so extreme warp can't freeze the worker

let ctrl: Int32Array | null = null;
let data: Float64Array | null = null;
let nBodies = 0;
let bodyIds: string[] = [];
let gm: number[] = []; // aligned with bodyIds
let eph: De440 | null = null;
let scratch = new Float64Array(0);

let simTdb = 0; // TDB seconds past J2000
let rate = 0; // sim seconds per real second
let lastReal = performance.now();
const tmp = new Float64Array(6);

// --- test particles (P3): massless, integrated in the moving ephemeris field ---
let ias: IAS15 | null = null;
let nParticles = 0;
let particleTime = 0; // integrator clock (TDB s); tracks simTdb
let particleDt = 3600; // adaptive step, seconds
const massPos = new Float64Array(3 * 32); // massive-body positions (ecliptic), grown as needed

// --- perturb-everything (P3): the whole system integrated off ephemeris rails ---
let perturbing = false;
let sysIas: IAS15 | null = null;
let systemTime = 0;
let systemDt = 43200; // adaptive, seconds (starts at half a day)

// Full mutual N-body acceleration among the massive bodies (ecliptic m).
function systemAccel(_t: number, x: Float64Array, a: Float64Array): void {
  a.fill(0);
  for (let i = 0; i < nBodies; i++) {
    for (let j = i + 1; j < nBodies; j++) {
      const dx = x[j * 3] - x[i * 3], dy = x[j * 3 + 1] - x[i * 3 + 1], dz = x[j * 3 + 2] - x[i * 3 + 2];
      const r2 = dx * dx + dy * dy + dz * dz, inv = 1 / (r2 * Math.sqrt(r2));
      const fi = gm[j] * inv, fj = gm[i] * inv;
      a[i * 3] += fi * dx; a[i * 3 + 1] += fi * dy; a[i * 3 + 2] += fi * dz;
      a[j * 3] -= fj * dx; a[j * 3 + 1] -= fj * dy; a[j * 3 + 2] -= fj * dz;
    }
  }
}

// Seed the system integrator from DE440 (ecliptic m, m/s) at the current epoch.
function startPerturb(): void {
  if (!eph) return;
  sysIas = new IAS15(nBodies, systemAccel);
  for (let i = 0; i < nBodies; i++) {
    eph.state(bodyIds[i], simTdb, tmp);
    eqjToEcl(tmp.subarray(0, 3), tmp.subarray(0, 3));
    eqjToEcl(tmp.subarray(3, 6), tmp.subarray(3, 6));
    sysIas.x.set(tmp.subarray(0, 3), i * 3);
    sysIas.v.set(tmp.subarray(3, 6), i * 3);
  }
  systemTime = simTdb; systemDt = 43200;
  perturbing = true;
  ias = null; nParticles = 0; // test particles don't mix into the N-body run (MVP)
  self.postMessage({ type: 'particles', tdb: simTdb, pos: new Float64Array(0) } as ParticleFrame);
}

function integrateSystem(target: number): void {
  if (!sysIas) return;
  let steps = 0;
  while (systemTime < target - 1e-6 && steps < MAX_SUBSTEPS) {
    const h = Math.min(systemDt, target - systemTime);
    const err = sysIas.step(systemTime, h);
    systemTime += h;
    systemDt = sysIas.nextDt(systemDt, err);
    steps++;
  }
}

// Acceleration on each particle from every massive body at time t (ecliptic m).
function particleAccel(t: number, x: Float64Array, a: Float64Array): void {
  if (!eph) { a.fill(0); return; }
  for (let j = 0; j < nBodies; j++) {
    eph.state(bodyIds[j], t, tmp);
    eqjToEcl(tmp.subarray(0, 3), tmp.subarray(0, 3));
    massPos[j * 3] = tmp[0]; massPos[j * 3 + 1] = tmp[1]; massPos[j * 3 + 2] = tmp[2];
  }
  const count = x.length / 3;
  for (let p = 0; p < count; p++) {
    const px = x[p * 3], py = x[p * 3 + 1], pz = x[p * 3 + 2];
    let ax = 0, ay = 0, az = 0;
    for (let j = 0; j < nBodies; j++) {
      const dx = massPos[j * 3] - px, dy = massPos[j * 3 + 1] - py, dz = massPos[j * 3 + 2] - pz;
      const r2 = dx * dx + dy * dy + dz * dz;
      const inv = gm[j] / (r2 * Math.sqrt(r2));
      ax += inv * dx; ay += inv * dy; az += inv * dz;
    }
    a[p * 3] = ax; a[p * 3 + 1] = ay; a[p * 3 + 2] = az;
  }
}

function addParticle(x: [number, number, number], v: [number, number, number]): void {
  if (nParticles >= MAX_PARTICLES) return;
  const next = new IAS15(nParticles + 1, particleAccel);
  if (ias) { next.x.set(ias.x.subarray(0, nParticles * 3)); next.v.set(ias.v.subarray(0, nParticles * 3)); }
  next.x.set(x, nParticles * 3); next.v.set(v, nParticles * 3);
  ias = next; nParticles++;
  particleTime = simTdb; particleDt = 3600; // (re)seed the shared integrator clock
}

// Advance particles up to `target`, adaptively, bounded so warp can't hang us.
function integrateParticles(target: number): void {
  if (!ias || nParticles === 0) return;
  let steps = 0;
  while (particleTime < target - 1e-6 && steps < MAX_SUBSTEPS) {
    const h = Math.min(particleDt, target - particleTime);
    const err = ias.step(particleTime, h);
    particleTime += h;
    particleDt = ias.nextDt(particleDt, err);
    steps++;
  }
}

function publishParticles(): void {
  if (!ias || nParticles === 0) return;
  const frame: ParticleFrame = { type: 'particles', tdb: particleTime, pos: ias.x.slice(0, nParticles * 3) };
  self.postMessage(frame);
}

// Fill `scratch` with the barycentric state for the current simTdb. No publish.
function computeState(): void {
  if (perturbing && sysIas) {
    // Off ephemeris rails: bodies come from the N-body integrator (ecliptic).
    for (let i = 0; i < nBodies; i++) {
      const b = i * FLOATS_PER_BODY;
      scratch[b] = sysIas.x[i * 3]; scratch[b + 1] = sysIas.x[i * 3 + 1]; scratch[b + 2] = sysIas.x[i * 3 + 2];
      scratch[b + 3] = sysIas.v[i * 3]; scratch[b + 4] = sysIas.v[i * 3 + 1]; scratch[b + 5] = sysIas.v[i * 3 + 2];
    }
    return;
  }
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
  if (rate !== 0) {
    simTdb += dtReal * rate;
    if (perturbing) integrateSystem(simTdb); else integrateParticles(simTdb);
  }
  publishFrame();
  publishParticles();
}

self.onmessage = (e: MessageEvent<SimCommand>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      ctrl = msg.control ? new Int32Array(msg.control) : null;
      data = msg.data ? new Float64Array(msg.data) : null;
      nBodies = msg.nBodies;
      bodyIds = msg.bodyIds;
      gm = bodyIds.map((id) => SOLAR_SYSTEM.find((b) => b.id === id)?.gm ?? 0);
      scratch = new Float64Array(nBodies * FLOATS_PER_BODY);
      simTdb = msg.tdb;
      particleTime = msg.tdb;
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
      // A time jump can't be bridged by integration; carry particles' states to
      // the new epoch (their clock resets) rather than integrating the gap.
      simTdb = msg.tdb;
      particleTime = msg.tdb;
      if (perturbing) startPerturb(); // re-seed the N-body system at the new epoch
      publishFrame();
      publishParticles();
      break;
    case 'perturb':
      if (msg.on) startPerturb();
      else { perturbing = false; sysIas = null; }
      publishFrame();
      break;
    case 'addParticle':
      addParticle(msg.x, msg.v);
      publishParticles();
      break;
    case 'clearParticles':
      ias = null; nParticles = 0;
      self.postMessage({ type: 'particles', tdb: simTdb, pos: new Float64Array(0) } as ParticleFrame);
      break;
  }
};
