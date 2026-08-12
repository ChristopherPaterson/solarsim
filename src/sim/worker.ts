// Sim worker: the time authority (build plan §4.1). Advances TDB, evaluates
// barycentric state for every body from the baked DE440 ephemeris (P2), converts
// ICRF -> ecliptic-J2000, and publishes into the SAB ring. The main thread never
// advances physics.

import { eqjToEcl } from '../core/frames';
import { De440 } from '../core/ephemeris/de440';
import { IAS15 } from '../core/integrate/ias15';
import { porkchop } from '../core/orbital/porkchop';
import { propagate } from '../core/orbital/kepler';
import { SOLAR_SYSTEM } from '../data/bodies';
import { publish, FLOATS_PER_BODY, CTRL_TICK_US, type SimCommand, type SimFrame, type ParticleFrame, type PorkchopResult } from './protocol';

const TICK_MS = 16; // ~60 Hz sim
const MAX_PARTICLES = 64;
const MAX_SUBSTEPS = 400; // per frame, so extreme warp can't freeze the worker
const SOFT2 = 1e7 * 1e7; // Plummer softening (~1e4 km): kills the 1/r² singularity
// when a test particle sits on a body (ghosting) or grazes one; negligible at
// orbital distances (~1e11 m).
const GM_SUN = 1.32712440018e20;

let ctrl: Int32Array | null = null;
let data: Float64Array | null = null;
let nBodies = 0;
let bodyIds: string[] = [];
let gm: number[] = []; // aligned with bodyIds
let eph: De440 | null = null;
let scratch = new Float64Array(0);
// Moons (kepler-rel about a parent) vs everything else (DE440 / N-body).
let moonOf: (null | { parentIdx: number; r0: number[]; v0: number[]; epoch: number; period: number })[] = [];
let moonIdx: number[] = [];   // body indices that are moons
let nonMoon: number[] = [];   // body indices that use DE440 / the N-body system
let nonMoonGm: number[] = [];
const mr = new Float64Array(3), mv = new Float64Array(3);

let simTdb = 0; // TDB seconds past J2000
let rate = 0; // sim seconds per real second
let lastReal = performance.now();
const tmp = new Float64Array(6);

// --- test particles (P3): massless, integrated in the moving ephemeris field ---
let ias: IAS15 | null = null;
let nParticles = 0;
let excludes: number[] = []; // per-particle body index to ignore (ghost skips self), or -1
let particleTime = 0; // integrator clock (TDB s); tracks simTdb
let particleDt = 3600; // adaptive step, seconds
const massPos = new Float64Array(3 * 32); // massive-body positions (ecliptic), grown as needed

// --- perturb-everything (P3): the whole system integrated off ephemeris rails ---
let perturbing = false;
let sysIas: IAS15 | null = null;
let systemTime = 0;
let systemDt = 43200; // adaptive, seconds (starts at half a day)

// Full mutual N-body acceleration among the non-moon bodies (ecliptic m). Moons
// stay on kepler-rails, so they don't force tiny timesteps here.
function systemAccel(_t: number, x: Float64Array, a: Float64Array): void {
  const N = nonMoon.length;
  a.fill(0);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const dx = x[j * 3] - x[i * 3], dy = x[j * 3 + 1] - x[i * 3 + 1], dz = x[j * 3 + 2] - x[i * 3 + 2];
      const r2 = dx * dx + dy * dy + dz * dz, inv = 1 / (r2 * Math.sqrt(r2));
      const fi = nonMoonGm[j] * inv, fj = nonMoonGm[i] * inv;
      a[i * 3] += fi * dx; a[i * 3 + 1] += fi * dy; a[i * 3 + 2] += fi * dz;
      a[j * 3] -= fj * dx; a[j * 3 + 1] -= fj * dy; a[j * 3 + 2] -= fj * dz;
    }
  }
}

// Seed the system integrator (non-moon bodies only) from DE440 at the current epoch.
function startPerturb(): void {
  if (!eph) return;
  sysIas = new IAS15(nonMoon.length, systemAccel);
  for (let j = 0; j < nonMoon.length; j++) {
    eph.state(bodyIds[nonMoon[j]], simTdb, tmp);
    eqjToEcl(tmp.subarray(0, 3), tmp.subarray(0, 3));
    eqjToEcl(tmp.subarray(3, 6), tmp.subarray(3, 6));
    sysIas.x.set(tmp.subarray(0, 3), j * 3);
    sysIas.v.set(tmp.subarray(3, 6), j * 3);
  }
  systemTime = simTdb; systemDt = 43200;
  perturbing = true;
  ias = null; nParticles = 0; excludes = []; // test particles don't mix into the N-body run (MVP)
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
    const skip = excludes[p];
    let ax = 0, ay = 0, az = 0;
    for (let j = 0; j < nBodies; j++) {
      if (j === skip) continue; // a ghost ignores the body it shadows
      const dx = massPos[j * 3] - px, dy = massPos[j * 3 + 1] - py, dz = massPos[j * 3 + 2] - pz;
      const r2 = dx * dx + dy * dy + dz * dz + SOFT2;
      const inv = gm[j] / (r2 * Math.sqrt(r2));
      ax += inv * dx; ay += inv * dy; az += inv * dz;
    }
    a[p * 3] = ax; a[p * 3 + 1] = ay; a[p * 3 + 2] = az;
  }
}

function addParticle(x: [number, number, number], v: [number, number, number], exclude: number): void {
  if (nParticles >= MAX_PARTICLES) return;
  const next = new IAS15(nParticles + 1, particleAccel);
  if (ias) { next.x.set(ias.x.subarray(0, nParticles * 3)); next.v.set(ias.v.subarray(0, nParticles * 3)); }
  next.x.set(x, nParticles * 3); next.v.set(v, nParticles * 3);
  ias = next; excludes[nParticles] = exclude; nParticles++;
  particleTime = simTdb; particleDt = 3600; // (re)seed the shared integrator clock
}

// Advance particles up to `target`, adaptively, bounded so warp can't hang us.
function integrateParticles(target: number): void {
  if (!ias || nParticles === 0) return;
  // Cap the step at a fraction of the innermost particle's dynamical time, so at
  // extreme warp the adaptive controller can't grow dt until it aliases fast
  // perturbations (e.g. the Moon). Scales with distance: inner small, outer large.
  let rmin = Infinity;
  for (let p = 0; p < nParticles; p++) {
    const r = Math.hypot(ias.x[p * 3], ias.x[p * 3 + 1], ias.x[p * 3 + 2]);
    if (r < rmin) rmin = r;
  }
  const dtCap = (2 * Math.PI * Math.sqrt((rmin * rmin * rmin) / GM_SUN)) / 200;
  let steps = 0;
  while (particleTime < target - 1e-6 && steps < MAX_SUBSTEPS) {
    const h = Math.min(particleDt, dtCap, target - particleTime);
    const err = ias.step(particleTime, h);
    particleTime += h;
    particleDt = Math.min(ias.nextDt(particleDt, err), dtCap);
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
  // Non-moon bodies: from the N-body integrator (perturb) or DE440.
  if (perturbing && sysIas) {
    for (let j = 0; j < nonMoon.length; j++) {
      const b = nonMoon[j] * FLOATS_PER_BODY, sj = j * 3;
      scratch[b] = sysIas.x[sj]; scratch[b + 1] = sysIas.x[sj + 1]; scratch[b + 2] = sysIas.x[sj + 2];
      scratch[b + 3] = sysIas.v[sj]; scratch[b + 4] = sysIas.v[sj + 1]; scratch[b + 5] = sysIas.v[sj + 2];
    }
  } else if (eph) {
    for (const i of nonMoon) {
      eph.state(bodyIds[i], simTdb, tmp); // m, m/s, ICRF/equatorial-J2000
      const b = i * FLOATS_PER_BODY;
      eqjToEcl(tmp.subarray(0, 3), tmp.subarray(0, 3)); eqjToEcl(tmp.subarray(3, 6), tmp.subarray(3, 6));
      scratch[b] = tmp[0]; scratch[b + 1] = tmp[1]; scratch[b + 2] = tmp[2];
      scratch[b + 3] = tmp[3]; scratch[b + 4] = tmp[4]; scratch[b + 5] = tmp[5];
    }
  } else return;
  // Moons: Kepler-propagate about the parent's just-computed position (both modes).
  for (const i of moonIdx) {
    const m = moonOf[i]!, pb = m.parentIdx * FLOATS_PER_BODY, b = i * FLOATS_PER_BODY;
    // Propagate over <1 orbit (exact for a closed ellipse). Over the full months-
    // long epoch->now span a short-period moon winds hundreds of revolutions and
    // the universal-variable solver intermittently fails to converge, flinging the
    // moon off its ellipse (the "ghost Phobos" flicker). Skip a tick if it still fails.
    if (!propagate(m.r0, m.v0, gm[m.parentIdx], (simTdb - m.epoch) % m.period, mr, mv)) continue;
    scratch[b] = scratch[pb] + mr[0]; scratch[b + 1] = scratch[pb + 1] + mr[1]; scratch[b + 2] = scratch[pb + 2] + mr[2];
    scratch[b + 3] = scratch[pb + 3] + mv[0]; scratch[b + 4] = scratch[pb + 4] + mv[1]; scratch[b + 5] = scratch[pb + 5] + mv[2];
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
      // Split bodies into moons (kepler-rel) vs the rest (DE440 / N-body).
      moonOf = bodyIds.map((id) => {
        const d = SOLAR_SYSTEM.find((b) => b.id === id);
        if (!d?.relState || !d.parent) return null;
        const pIdx = bodyIds.indexOf(d.parent), mu = gm[pIdx];
        const { r0, v0, epoch } = d.relState;
        // Orbital period from vis-viva; used to reduce the propagation span to
        // under one revolution (see the moon loop).
        const r0m = Math.hypot(r0[0], r0[1], r0[2]);
        const a = 1 / (2 / r0m - (v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2]) / mu);
        return { parentIdx: pIdx, r0, v0, epoch, period: 2 * Math.PI * Math.sqrt((a * a * a) / mu) };
      });
      moonIdx = []; nonMoon = []; nonMoonGm = [];
      moonOf.forEach((m, i) => { if (m) moonIdx.push(i); else { nonMoon.push(i); nonMoonGm.push(gm[i]); } });
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
    case 'porkchop': {
      if (!eph) break;
      const { target, depStart, depStep, arrStart, arrStep, n } = msg;
      const depT = Array.from({ length: n }, (_, i) => depStart + i * depStep);
      const arrT = Array.from({ length: n }, (_, j) => arrStart + j * arrStep);
      const tA = new Float64Array(6), tS = new Float64Array(6);
      const helio = (id: string) => (t: number) => {
        eph!.state(id, t, tA); eph!.state('Sun', t, tS); // heliocentric ICRF (frame-agnostic for Lambert)
        return { r: new Float64Array([tA[0] - tS[0], tA[1] - tS[1], tA[2] - tS[2]]), v: new Float64Array([tA[3] - tS[3], tA[4] - tS[4], tA[5] - tS[5]]) };
      };
      const pc = porkchop(helio('Earth'), helio(target), GM_SUN, depT, arrT);
      let best = Infinity, bi = -1;
      for (let k = 0; k < pc.dvTotal.length; k++) { const v = pc.dvTotal[k]; if (Number.isFinite(v) && v < best) { best = v; bi = k; } }
      self.postMessage({ type: 'porkchop', n: pc.n, m: pc.m, dv: pc.dvTotal, bestIdx: bi, bestDv: best, depStart, depStep, arrStart, arrStep } as PorkchopResult);
      break;
    }
    case 'addParticle':
      addParticle(msg.x, msg.v, msg.exclude);
      publishParticles();
      break;
    case 'ghostBody':
      if (eph) {
        eph.state(bodyIds[msg.index], simTdb, tmp); // this worker's own clock
        eqjToEcl(tmp.subarray(0, 3), tmp.subarray(0, 3));
        eqjToEcl(tmp.subarray(3, 6), tmp.subarray(3, 6));
        addParticle([tmp[0], tmp[1], tmp[2]], [tmp[3], tmp[4], tmp[5]], msg.index);
        publishParticles();
      }
      break;
    case 'clearParticles':
      ias = null; nParticles = 0; excludes = [];
      self.postMessage({ type: 'particles', tdb: simTdb, pos: new Float64Array(0) } as ParticleFrame);
      break;
  }
};
