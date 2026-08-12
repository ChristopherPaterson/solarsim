import { Renderer } from './render/Renderer';
import { SimClient } from './sim/simClient';
import { SOLAR_SYSTEM } from './data/bodies';
import { dateToTdb, tdbToDate } from './core/time';
import { readState, writeState } from './ui/urlState';
import './style.css';

const app = document.getElementById('app')!;

// The sim core prefers a SharedArrayBuffer ring, which needs a cross-origin
// isolated secure context (https / localhost). Over plain http (LAN IP) that
// isn't available, so SimClient transparently falls back to postMessage frames.
if (!globalThis.crossOriginIsolated) {
  console.info('SolarSim: no cross-origin isolation; sim running in postMessage-frame mode (HTTP fallback).');
}

const bodyIds = SOLAR_SYSTEM.map((b) => b.id);
const nBodies = bodyIds.length;

// --- initial state from URL (or now) ---------------------------------------
const url = readState();
let focusIdx = Math.max(0, bodyIds.indexOf(url.focus ?? 'Earth'));
let exaggeration = url.scale ?? 1500;
const startTdb = url.t ?? dateToTdb(new Date());
let rate = url.rate ?? 0;

const sim = new SimClient(bodyIds, startTdb, rate);
const renderer = new Renderer(app);
await renderer.init();
renderer.setBodies(SOLAR_SYSTEM);
renderer.loadStars('data/stars.bin', tdbToDate(startTdb as never).getFullYear()).catch((e) => console.warn('stars:', e));

const state = new Float64Array(nBodies * 6);
let curTdb = startTdb;

// --- HUD --------------------------------------------------------------------
const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML = `
  <div class="row"><span class="badge" id="backend">…</span><span class="badge" id="fps">-- FPS</span></div>
  <label>FOCUS <select id="focus">${SOLAR_SYSTEM.map((b, i) => `<option value="${i}">${b.id.toUpperCase()}</option>`).join('')}</select></label>
  <label>DATE <input type="datetime-local" id="date" step="1"></label>
  <label>RATE <input type="range" id="rate" min="0" max="8" step="0.05"></label>
  <div class="row"><span id="ratelabel">PAUSED</span><button id="now">NOW</button></div>
  <label>SCALE <input type="range" id="scale" min="0" max="4" step="0.01"></label>
  <label class="row"><span>TRUE SCALE</span><input type="checkbox" id="truescale"></label>
  <label class="row"><span>FLY (WASD+drag)</span><input type="checkbox" id="fly"></label>
  <label class="row"><span>INSERT (click+drag)</span><input type="checkbox" id="insert"></label>
  <div class="row"><button id="clearp">CLEAR PARTICLES</button></div>
  <label class="row"><span>DEBUG</span><input type="checkbox" id="debug"></label>
  <div class="mono" id="readout"></div>
`;
app.appendChild(hud);

const $ = <T extends HTMLElement>(sel: string) => hud.querySelector<T>(sel)!;
const dateInput = $<HTMLInputElement>('#date');
const rateInput = $<HTMLInputElement>('#rate');
const rateLabel = $<HTMLSpanElement>('#ratelabel');
const scaleInput = $<HTMLInputElement>('#scale');
const trueScale = $<HTMLInputElement>('#truescale');
const focusSel = $<HTMLSelectElement>('#focus');
const readout = $<HTMLDivElement>('#readout');
const debugChk = $<HTMLInputElement>('#debug');

$<HTMLSpanElement>('#backend').textContent = renderer.isWebGPU ? 'WEBGPU' : 'WEBGL2';
focusSel.value = String(focusIdx);
scaleInput.value = String(Math.log10(exaggeration));
rateInput.value = rate === 0 ? '0' : String(Math.log10(rate));
setRateLabel(rate);

function setRateLabel(r: number) {
  rateLabel.textContent = r === 0 ? 'PAUSED' : `×${r.toExponential(0)}`;
}
function pad(n: number) { return String(n).padStart(2, '0'); }
function syncDatePicker(d: Date) {
  dateInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

dateInput.addEventListener('change', () => {
  const parsed = new Date(dateInput.value);
  if (!isNaN(parsed.getTime())) { const t = dateToTdb(parsed); sim.jumpTo(t); renderer.starField?.applyEpoch(parsed.getFullYear()); persist(t); }
});
rateInput.addEventListener('input', () => {
  const v = parseFloat(rateInput.value);
  rate = v === 0 ? 0 : Math.pow(10, v);
  sim.setRate(rate); setRateLabel(rate); persist();
});
$<HTMLButtonElement>('#now').addEventListener('click', () => {
  const t = dateToTdb(new Date()); sim.jumpTo(t); syncDatePicker(new Date()); persist(t);
});
scaleInput.addEventListener('input', () => {
  exaggeration = Math.pow(10, parseFloat(scaleInput.value));
  trueScale.checked = false; persist();
});
trueScale.addEventListener('change', () => {
  if (trueScale.checked) exaggeration = 1;
  else exaggeration = Math.pow(10, parseFloat(scaleInput.value));
  persist();
});
focusSel.addEventListener('change', () => { focusIdx = parseInt(focusSel.value); persist(); });

// P3 insert: click the ecliptic to place a body, drag to set its velocity (a
// live two-body preview ellipse shows the orbit), release to commit to the sim.
const insertChk = $<HTMLInputElement>('#insert');
const flyChk = $<HTMLInputElement>('#fly');
insertChk.addEventListener('change', () => {
  if (insertChk.checked && flyChk.checked) { flyChk.checked = false; renderer.setFlyMode(false); }
  renderer.setInsertMode(insertChk.checked, (x, v) => sim.addParticle(x, v));
});
$<HTMLButtonElement>('#clearp').addEventListener('click', () => sim.clearParticles());

flyChk.addEventListener('change', () => {
  if (flyChk.checked && insertChk.checked) { insertChk.checked = false; renderer.setInsertMode(false); }
  renderer.setFlyMode(flyChk.checked);
});
// 'F' toggles free-flight too (ignored while typing in the date field).
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' && document.activeElement?.tagName !== 'INPUT') {
    flyChk.checked = !flyChk.checked; renderer.setFlyMode(flyChk.checked);
  }
});

function persist(t = curTdb) {
  writeState({ t, focus: bodyIds[focusIdx], rate, scale: trueScale.checked ? 1 : exaggeration });
}

// --- loop -------------------------------------------------------------------
let frames = 0;
let lastFpsT = performance.now();
let lastDateSync = 0;

renderer.renderer.setAnimationLoop(() => {
  curTdb = sim.readLatest(state);
  const exagg = trueScale.checked ? 1 : exaggeration;
  renderer.update(state, focusIdx, exagg, curTdb);
  renderer.updateParticles(sim.particlePositions(), state[focusIdx * 6], state[focusIdx * 6 + 1], state[focusIdx * 6 + 2]);
  renderer.render();

  // HUD readouts (throttled).
  const now = performance.now();
  frames++;
  if (now - lastFpsT > 500) {
    $<HTMLSpanElement>('#fps').textContent = `${Math.round((frames * 1000) / (now - lastFpsT))} FPS`;
    frames = 0; lastFpsT = now;
    if (debugChk.checked) {
      const info = renderer.renderer.info.render;
      readout.textContent = `calls ${info.drawCalls}  tris ${info.triangles}\ntick ${sim.tickMs().toFixed(2)} ms  dist ${(renderer.focusDistance() / 1.495978707e11).toFixed(3)} AU`;
    } else readout.textContent = '';
  }
  if (now - lastDateSync > 200) { syncDatePicker(tdbToDate(curTdb as never)); lastDateSync = now; }
});

(globalThis as { __r?: Renderer }).__r = renderer; // dev inspection hook
(globalThis as { __sim?: SimClient }).__sim = sim;
