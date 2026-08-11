import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HelioVector } from 'astronomy-engine';
import { SUN, PLANETS, type P0Body } from './planets';
import './style.css';

// --- P0 scene scale ---------------------------------------------------------
// Positions come from astronomy-engine HelioVector in AU (equatorial J2000).
// P0 uses 1 scene unit = 1 AU and exaggerates radii so bodies are visible.
// This is throwaway: real-scale + floating origin is P1.
const AU = 1;
const sceneRadius = (radiusKm: number) => 0.06 * Math.cbrt(radiusKm / 6371);

const app = document.getElementById('app')!;

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.001, 10000);
camera.position.set(0, 8, 16);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// One mesh per body; sphere unit geometry scaled per body.
const unitSphere = new THREE.SphereGeometry(1, 32, 16);
interface RenderedBody {
  def: P0Body;
  mesh: THREE.Mesh;
}
const bodies: RenderedBody[] = [];

function makeBody(def: P0Body, emissive: boolean): RenderedBody {
  const mat = emissive
    ? new THREE.MeshBasicMaterial({ color: def.colour })
    : new THREE.MeshStandardMaterial({ color: def.colour, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(unitSphere, mat);
  mesh.scale.setScalar(sceneRadius(def.radiusKm) * (emissive ? 3 : 1));
  scene.add(mesh);
  return { def, mesh };
}

const sun = makeBody(SUN, true);
bodies.push(sun);
for (const p of PLANETS) bodies.push(makeBody(p, false));

// Sunlight from the origin.
const sunLight = new THREE.PointLight(0xffffff, 4, 0, 0);
scene.add(sunLight);
scene.add(new THREE.AmbientLight(0x222233, 1));

// Place every body at its heliocentric position for a given date.
function updatePositions(date: Date) {
  for (const b of bodies) {
    if (b.def === SUN) continue;
    const v = HelioVector(b.def.body, date);
    b.mesh.position.set(v.x * AU, v.z * AU, -v.y * AU); // y-up scene: map ecliptic z->y
  }
}

// --- time authority (P0: main-thread, replaced by worker in P1) -------------
let simDate = new Date();
let rate = 0; // seconds of sim time per second of real time
let lastReal = performance.now();

function tick(nowReal: number) {
  const dtReal = (nowReal - lastReal) / 1000;
  lastReal = nowReal;
  if (rate !== 0) {
    simDate = new Date(simDate.getTime() + dtReal * rate * 1000);
    syncDatePicker();
  }
  updatePositions(simDate);
  controls.update();
  renderer.render(scene, camera);
}

// --- HUD --------------------------------------------------------------------
const hud = document.createElement('div');
hud.className = 'hud';
hud.innerHTML = `
  <div class="row"><span class="badge" id="backend">…</span></div>
  <label>DATE <input type="datetime-local" id="date" step="1"></label>
  <label>RATE <input type="range" id="rate" min="0" max="8" step="0.1" value="0"></label>
  <div class="row"><span id="ratelabel">PAUSED</span><button id="now">NOW</button></div>
`;
app.appendChild(hud);

const dateInput = hud.querySelector<HTMLInputElement>('#date')!;
const rateInput = hud.querySelector<HTMLInputElement>('#rate')!;
const rateLabel = hud.querySelector<HTMLSpanElement>('#ratelabel')!;

function syncDatePicker() {
  // datetime-local wants local time without timezone/millis.
  const d = simDate;
  const pad = (n: number) => String(n).padStart(2, '0');
  dateInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

dateInput.addEventListener('change', () => {
  const parsed = new Date(dateInput.value);
  if (!isNaN(parsed.getTime())) simDate = parsed;
});

rateInput.addEventListener('input', () => {
  // slider 0 -> paused, otherwise 10^(v) sim-seconds per real-second (max ~1e8).
  const v = parseFloat(rateInput.value);
  rate = v === 0 ? 0 : Math.pow(10, v);
  rateLabel.textContent = v === 0 ? 'PAUSED' : `×${rate.toExponential(0)}`;
});

hud.querySelector<HTMLButtonElement>('#now')!.addEventListener('click', () => {
  simDate = new Date();
  syncDatePicker();
});

syncDatePicker();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// WebGPURenderer requires init() before first render; falls back to WebGL2.
await renderer.init();
const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
hud.querySelector<HTMLSpanElement>('#backend')!.textContent = isWebGPU ? 'WEBGPU' : 'WEBGL2';
renderer.setAnimationLoop(tick);
