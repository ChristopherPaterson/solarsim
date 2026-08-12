import { Renderer } from './render/Renderer';
import { SimClient } from './sim/simClient';
import { SOLAR_SYSTEM } from './data/bodies';
import { dateToTdb, tdbToDate } from './core/time';
import { readState, writeState } from './ui/urlState';
import { createPorkchopPanel } from './ui/porkchop';
import { createVesselPanel } from './ui/vessel';
import { createTransferPanel } from './ui/transfer';
import { createDvLadderPanel } from './ui/dvladder';
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
const urlScale = url.scale ?? 1; // default: real (true) scale
let exaggeration = urlScale > 1 ? urlScale : 1500; // value used when TRUE SCALE is toggled off
const startTdb = url.t ?? dateToTdb(new Date());
// Time control: WARP factor (≥1× real time) plus a play/pause toggle. Loads
// running at real time unless the URL says otherwise (rate 0 = paused).
let paused = url.rate === 0;
let warp = url.rate && url.rate >= 1 ? url.rate : 1;
const rateNow = () => (paused ? 0 : warp);

const sim = new SimClient(bodyIds, startTdb, rateNow());
const renderer = new Renderer(app);
await renderer.init();
renderer.setBodies(SOLAR_SYSTEM);
renderer.loadStars('data/stars.bin', tdbToDate(startTdb as never).getFullYear()).catch((e) => console.warn('stars:', e));

// Real mission trajectories (JPL): [name, label, colour, on-by-default].
const MISSIONS: [string, string, number, boolean][] = [
  ['voyager1', 'Voyager 1', 0xff5aa0, false], ['voyager2', 'Voyager 2', 0xff8a5a, false],
  ['newhorizons', 'New Horizons', 0x88ff88, false], ['parker', 'Parker Solar Probe', 0xffd24a, false],
  ['juno', 'Juno', 0x9a7bff, false], ['cassini', 'Cassini', 0x7affc0, false], ['jwst', 'JWST', 0xffffff, false],
];
for (const [name, , color, on] of MISSIONS) {
  renderer.loadMission(name, `data/missions/${name}.bin`, color).then(() => renderer.setMissionVisible(name, on)).catch((e) => console.warn(name, e));
}
renderer.loadAsteroids('data/asteroids.bin').catch((e) => console.warn('asteroids:', e));
// Real shape models (Thomas, PDS SBN) for the lumpy Martian moons.
renderer.loadMoonShape('Phobos', 'data/shapes/phobos.bin').catch((e) => console.warn('phobos shape:', e));
renderer.loadMoonShape('Deimos', 'data/shapes/deimos.bin').catch((e) => console.warn('deimos shape:', e));
// Colour-coded satellite categories (name, file, colour, dot size, legend label).
const SAT_CATS: [string, string, number, number, string][] = [
  ['stations', 'stations', 0xffffff, 5, 'Space stations'],
  ['navigation', 'navigation', 0x54e08a, 3, 'Navigation · GPS/GNSS'],
  ['communications', 'communications', 0xffab3d, 3, 'Communications'],
  ['weather', 'weather', 0x5fbcff, 3, 'Weather · Earth obs'],
  ['science', 'science', 0xc98bff, 4, 'Science'],
  ['other', 'other', 0x8a97a5, 2, 'Other'],
];
for (const [name, file, colour, size] of SAT_CATS) {
  renderer.loadSatelliteGroup(name, `data/sats/${file}.txt`, colour, size).catch((e) => console.warn(name, e));
}
renderer.loadSatelliteGroup('starlink', 'data/starlink.txt', 0xbfe0ff, 2).catch((e) => console.warn('starlink:', e));

const state = new Float64Array(nBodies * 6);
let curTdb = startTdb;

// --- HUD --------------------------------------------------------------------
const hud = document.createElement('div');
hud.className = 'hud';
// FOCUS options: planets top-level, their moons nested in a labelled optgroup.
const focusOpts = SOLAR_SYSTEM.map((b, i) => {
  if (b.parent) return '';
  const moons = SOLAR_SYSTEM.map((m, j) => [m, j] as const).filter(([m]) => m.parent === b.id);
  const group = moons.length ? `<optgroup label="${b.id.toUpperCase()} MOONS">${moons.map(([m, j]) => `<option value="${j}">&nbsp;&nbsp;↳ ${m.id.toUpperCase()}</option>`).join('')}</optgroup>` : '';
  return `<option value="${i}">${b.id.toUpperCase()}</option>${group}`;
}).join('');

hud.innerHTML = `
  <div class="title"><b>SOLARSIM</b><span class="badges"><span class="badge" id="backend">…</span><span class="badge" id="fps">-- FPS</span></span></div>

  <details class="sec" open><summary>TIME</summary><div class="body">
    <label>DATE <input type="datetime-local" id="date" step="1"></label>
    <label>WARP <input type="range" id="rate" min="0" max="8" step="0.05"></label>
    <div class="row"><button id="playpause">⏸ PAUSE</button><span id="ratelabel">×1</span><button id="now">NOW</button></div>
  </div></details>

  <details class="sec" open><summary>VIEW</summary><div class="body">
    <label>FOCUS <select id="focus">${focusOpts}</select></label>
    <label>FRAME <select id="frame"><option value="-1">INERTIAL</option>${SOLAR_SYSTEM.map((b, i) => (i > 0 && !b.parent ? `<option value="${i}">⟳ ${b.id.toUpperCase()}</option>` : '')).join('')}</select></label>
    <label>SCALE <input type="range" id="scale" min="0" max="4" step="0.01"></label>
    <label class="row"><span>TRUE SCALE</span><input type="checkbox" id="truescale"></label>
    <label class="row"><span>FLY · WASD+DRAG</span><input type="checkbox" id="fly"></label>
  </div></details>

  <details class="sec"><summary>LAYERS</summary><div class="body">
    <label class="row"><span>ASTEROIDS · 100K</span><input type="checkbox" id="asteroids"></label>
    <label class="row"><span class="sub">↳ COUNT</span><input type="range" id="astcount" min="2000" max="100000" step="2000" value="100000" style="width:120px"></label>
    <label class="row"><span>SATELLITES · SGP4</span><input type="checkbox" id="sats"></label>
    <div class="sat-legend" id="satlegend"></div>
    <label class="row"><span class="sub">↳ ORBIT TRACKS</span><input type="checkbox" id="satorbits"></label>
    <label class="row"><span>STARLINK · ~11K</span><input type="checkbox" id="starlink"></label>
    <label class="row"><span>SPHERES OF INFLUENCE</span><input type="checkbox" id="soi"></label>
    <details class="sec"><summary>MISSIONS &amp; PROBES</summary><div class="body" id="missions"></div></details>
  </div></details>

  <details class="sec"><summary>TOOLS</summary><div class="body">
    <label class="row"><span>INSERT · CLICK+DRAG</span><input type="checkbox" id="insert"></label>
    <div class="row"><button id="ghost">GHOST</button><button id="clearp">CLEAR</button></div>
    <label class="row"><span>PERTURB ALL · N-BODY</span><input type="checkbox" id="perturb"></label>
    <div class="row"><button id="porkchop">PORKCHOP</button><button id="transfer">TRANSFER</button></div>
    <div class="row"><button id="vessel">+ VESSEL</button><button id="dvladder">Δv LADDER</button></div>
  </div></details>

  <details class="sec"><summary>DEBUG</summary><div class="body">
    <label class="row"><span>OVERLAY</span><input type="checkbox" id="debug"></label>
    <div class="mono" id="readout"></div>
  </div></details>
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
trueScale.checked = urlScale <= 1; // default to real scale unless the URL exaggerates
// At true scale the focus body is tiny; frame it at ~12 radii so it's actually
// visible on load (the default far camera suits the exaggerated view, not this).
if (trueScale.checked) {
  const d = SOLAR_SYSTEM[focusIdx].radius * 12;
  renderer.camera.position.set(0, d * 0.375, d * 0.927);
  renderer.controls.update();
}
const playPause = $<HTMLButtonElement>('#playpause');
rateInput.value = String(Math.log10(warp));
function updateTimeUI() {
  playPause.textContent = paused ? '▶ PLAY' : '⏸ PAUSE';
  rateLabel.textContent = warp < 1000 ? `×${warp.toFixed(0)}` : `×${warp.toExponential(0)}`;
}
updateTimeUI();
function pad(n: number) { return String(n).padStart(2, '0'); }
function syncDatePicker(d: Date) {
  dateInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

dateInput.addEventListener('change', () => {
  const parsed = new Date(dateInput.value);
  if (!isNaN(parsed.getTime())) { const t = dateToTdb(parsed); sim.jumpTo(t); renderer.starField?.applyEpoch(parsed.getFullYear()); persist(t); }
});
rateInput.addEventListener('input', () => {
  warp = Math.pow(10, parseFloat(rateInput.value)); // slider min 0 -> ×1 (real time)
  if (!paused) sim.setRate(warp);
  updateTimeUI(); persist();
});
playPause.addEventListener('click', () => {
  paused = !paused; sim.setRate(rateNow()); updateTimeUI(); persist();
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
$<HTMLSelectElement>('#frame').addEventListener('change', (e) => renderer.setFrame(parseInt((e.target as HTMLSelectElement).value)));

// P3 insert: click the ecliptic to place a body, drag to set its velocity (a
// live two-body preview ellipse shows the orbit), release to commit to the sim.
const insertChk = $<HTMLInputElement>('#insert');
const flyChk = $<HTMLInputElement>('#fly');
insertChk.addEventListener('change', () => {
  if (insertChk.checked && flyChk.checked) { flyChk.checked = false; renderer.setFlyMode(false); }
  renderer.setInsertMode(insertChk.checked, (x, v) => sim.addParticle(x, v));
});
// Ghost: drop a test particle at the focus body's exact state. It integrates in
// the sim's Newtonian field and should track the body's ephemeris orbit line;
// the slow divergence (only 10 bodies, no GR) is the visible correctness check.
$<HTMLButtonElement>('#ghost').addEventListener('click', () => sim.ghostBody(focusIdx));
$<HTMLButtonElement>('#clearp').addEventListener('click', () => sim.clearParticles());

// Perturb-everything: whole system goes full N-body, with a clear signal that
// reality has been left behind.
const perturbChk = $<HTMLInputElement>('#perturb');
const nbodyBanner = document.createElement('div');
nbodyBanner.textContent = '⚠ N-BODY — OFF EPHEMERIS RAILS';
nbodyBanner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:6px 16px;background:rgba(190,40,20,0.85);color:#fff;font:600 13px ui-monospace,monospace;letter-spacing:1.5px;border-radius:4px;display:none;z-index:10;pointer-events:none';
app.appendChild(nbodyBanner);
perturbChk.addEventListener('change', () => {
  sim.setPerturb(perturbChk.checked);
  nbodyBanner.style.display = perturbChk.checked ? 'block' : 'none';
});

const togglePorkchop = createPorkchopPanel(sim, () => curTdb, app);
$<HTMLButtonElement>('#porkchop').addEventListener('click', togglePorkchop);

// Mission toggles, colour-coded to their trajectories.
const missionsBox = $<HTMLDivElement>('#missions');
missionsBox.innerHTML = MISSIONS.map(([name, label, color, on]) =>
  `<label class="row" style="font-size:10px"><span style="color:#${color.toString(16).padStart(6, '0')}">${label}</span><input type="checkbox" data-m="${name}" ${on ? 'checked' : ''}></label>`).join('');
missionsBox.querySelectorAll<HTMLInputElement>('input[data-m]').forEach((chk) =>
  chk.addEventListener('change', () => renderer.setMissionVisible(chk.dataset.m!, chk.checked)));
const astChk = $<HTMLInputElement>('#asteroids');
astChk.addEventListener('change', () => renderer.setAsteroidsVisible(astChk.checked));
$<HTMLInputElement>('#astcount').addEventListener('input', (e) => renderer.setAsteroidCount(+(e.target as HTMLInputElement).value));

const satChk = $<HTMLInputElement>('#sats');
satChk.addEventListener('change', () => { for (const [name] of SAT_CATS) renderer.setSatGroupVisible(name, satChk.checked); });
const starlinkChk = $<HTMLInputElement>('#starlink');
starlinkChk.addEventListener('change', () => renderer.setSatGroupVisible('starlink', starlinkChk.checked));
const satOrbChk = $<HTMLInputElement>('#satorbits');
satOrbChk.addEventListener('change', () => renderer.setSatOrbitsVisible(satOrbChk.checked));

// Colour legend for the categories.
$<HTMLDivElement>('#satlegend').innerHTML = SAT_CATS
  .map(([, , colour, , label]) => `<span class="sw"><i style="background:#${colour.toString(16).padStart(6, '0')}"></i>${label}</span>`)
  .join('');

// Hover: name the satellite nearest the cursor, highlight its orbit ring, fade
// the rest. Click opens Wikipedia — Special:Search resolves to the article if one
// exists, else lands on results (obscure debris just searches, notable sats jump in).
const satTip = document.createElement('div');
satTip.style.cssText = 'position:fixed;pointer-events:none;background:rgba(10,14,20,0.92);border:1px solid #2a3442;color:#cfe;font:10px ui-monospace,monospace;padding:2px 7px;border-radius:3px;display:none;z-index:20';
app.appendChild(satTip);
let hoverName: string | null = null;
window.addEventListener('mousemove', (e) => {
  const hit = renderer.pickSatellite(e.clientX, e.clientY);
  hoverName = hit?.name ?? null;
  if (hit) {
    satTip.innerHTML = `${hit.name}<span style="color:#7a8">  ↗ wiki</span>`;
    satTip.style.left = `${e.clientX + 13}px`; satTip.style.top = `${e.clientY + 10}px`; satTip.style.display = 'block';
    renderer.domElement.style.cursor = 'pointer';
  } else { satTip.style.display = 'none'; renderer.domElement.style.cursor = ''; }
  if (satOrbChk.checked) renderer.highlightSatOrbit(hit?.key ?? null);
});
// Distinguish a click from an orbit drag: only open wiki if the pointer barely moved.
let downX = 0, downY = 0;
renderer.domElement.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
renderer.domElement.addEventListener('click', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // was a drag
  if (hoverName) window.open(`https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(hoverName.replace(/\s+/g, ' ').trim())}`, '_blank', 'noopener');
});

const soiChk = $<HTMLInputElement>('#soi');
soiChk.addEventListener('change', () => renderer.setSoiVisible(soiChk.checked));

const sunIdx = bodyIds.indexOf('Sun'), earthIdx = bodyIds.indexOf('Earth');
const addVessel = createVesselPanel(renderer, app, () => ({ state, sunIdx, earthIdx, tdb: curTdb }));
$<HTMLButtonElement>('#vessel').addEventListener('click', addVessel);

const toggleTransfer = createTransferPanel(renderer, app, () => ({ state, bodyIds, sunIdx, tdb: curTdb }));
$<HTMLButtonElement>('#transfer').addEventListener('click', toggleTransfer);

const toggleDvLadder = createDvLadderPanel(app);
$<HTMLButtonElement>('#dvladder').addEventListener('click', toggleDvLadder);

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
  writeState({ t, focus: bodyIds[focusIdx], rate: rateNow(), scale: trueScale.checked ? 1 : exaggeration });
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
