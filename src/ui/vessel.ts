// Vessel maneuver planner (build plan §7 P3.5). Spawn a craft either co-orbiting
// the Sun (interplanetary) or in low Earth orbit, then plan a chain of impulsive
// burns (multi-node) in the prograde/normal/radial basis, with a live replanned
// trajectory and the rocket-equation affordability surfaced.

import { Vessel, type ManeuverNode } from '../core/spacecraft/vessel';
import { requiredPropellant } from '../core/spacecraft/propulsion';
import { rvToElements } from '../core/orbital/elements';
import type { Renderer } from '../render/Renderer';

const GM_SUN = 1.32712440018e20, GM_EARTH = 3.986004418e14, R_EARTH = 6.378137e6, AU = 1.495978707e11;

export interface VesselCtx { state: Float64Array; sunIdx: number; earthIdx: number; tdb: number; }

function periodOf(r: number[], v: number[], mu: number): number {
  const rn = Math.hypot(r[0], r[1], r[2]), v2 = v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
  const a = 1 / (2 / rn - v2 / mu);
  return a > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : 365.25 * 86400;
}

export function createVesselPanel(renderer: Renderer, app: HTMLElement, ctx: () => VesselCtx): () => void {
  const panel = document.createElement('div');
  panel.className = 'vessel panel';
  panel.innerHTML = `
    <div class="panel-head"><b>VESSEL · MANEUVER PLAN</b><span class="panel-x" id="v-close">✕</span></div>
    <div class="row"><span>ORBIT</span><select id="v-mode"><option value="solar">SOLAR (co-orbit Earth)</option><option value="leo">LOW EARTH ORBIT</option></select></div>
    <div class="row" style="margin-top:4px"><span>NODES</span><span id="v-nodes"></span></div>
    <label style="display:block;margin:4px 0">NODE TIME <input id="v-time" type="range" min="0" max="1" step="0.002" value="0.5" style="width:100%"></label>
    <label style="display:block;margin:4px 0">PROGRADE <span id="v-pl">0</span> m/s <input id="v-pro" type="range" min="-8000" max="8000" step="10" value="0" style="width:100%"></label>
    <label style="display:block;margin:4px 0">NORMAL <span id="v-nl">0</span> m/s <input id="v-nrm" type="range" min="-8000" max="8000" step="10" value="0" style="width:100%"></label>
    <label style="display:block;margin:4px 0">RADIAL <span id="v-rl">0</span> m/s <input id="v-rad" type="range" min="-8000" max="8000" step="10" value="0" style="width:100%"></label>
    <div class="panel-rule">ENGINE &amp; MASS</div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;text-align:center">
      <label>Isp&nbsp;s<input id="v-isp" type="number" min="100" max="1000000" step="10" value="320" style="width:100%"></label>
      <label>Dry&nbsp;kg<input id="v-dry" type="number" min="1" step="100" value="1000" style="width:100%"></label>
      <label>Prop&nbsp;kg<input id="v-prop" type="number" min="0" step="500" value="5000" style="width:100%"></label>
    </div>
    <div id="v-readout" class="panel-readout"></div>`;
  app.appendChild(panel);
  const $ = <T extends HTMLElement>(s: string) => panel.querySelector<T>(s)!;
  const readout = $<HTMLDivElement>('#v-readout'), nodesBox = $<HTMLSpanElement>('#v-nodes');
  const mode = $<HTMLSelectElement>('#v-mode');
  const time = $<HTMLInputElement>('#v-time'), pro = $<HTMLInputElement>('#v-pro'), nrm = $<HTMLInputElement>('#v-nrm'), rad = $<HTMLInputElement>('#v-rad');
  const isp = $<HTMLInputElement>('#v-isp'), dry = $<HTMLInputElement>('#v-dry'), prop = $<HTMLInputElement>('#v-prop');

  let vessel: Vessel | null = null;
  let t0 = 0, period = 0, propMass = 5000, sel = 0, leo = false;
  const SPAN = 2; // node time slider spans this many initial periods

  // Rebuild the node chip row (select / add / remove).
  function renderNodes(): void {
    if (!vessel) return;
    nodesBox.innerHTML = vessel.nodes.map((_, i) =>
      `<button class="node-chip${i === sel ? ' on' : ''}" data-i="${i}">${i + 1}</button>`).join('')
      + `<button class="node-chip add" id="v-add">+</button>`
      + (vessel.nodes.length > 1 ? `<button class="node-chip del" id="v-del">−</button>` : '');
  }
  function selectNode(i: number): void {
    if (!vessel) return;
    sel = Math.max(0, Math.min(i, vessel.nodes.length - 1));
    renderer.setEditNode(sel);
    const n = vessel.nodes[sel];
    time.value = String(Math.max(0, Math.min(1, (n.t - t0) / (period * SPAN))));
    pro.value = String(Math.round(n.prograde)); nrm.value = String(Math.round(n.normal)); rad.value = String(Math.round(n.radial));
    renderNodes(); applyReadout();
  }

  // Readout is from the nodes (so gizmo drags show too): total Δv vs budget + final orbit.
  function applyReadout(): void {
    if (!vessel) return;
    sel = Math.min(sel, vessel.nodes.length - 1);
    const n = vessel.nodes[sel];
    $('#v-pl').textContent = n.prograde.toFixed(0); $('#v-nl').textContent = n.normal.toFixed(0); $('#v-rl').textContent = n.radial.toFixed(0);
    const last = Math.max(...vessel.nodes.map((x) => x.t));
    const r = new Float64Array(3), v = new Float64Array(3);
    vessel.stateAt(last + 1, r, v);
    const el = rvToElements(r, v, vessel.mu);
    const peri = el.a * (1 - el.e), apo = el.a * (1 + el.e);
    const need = vessel.totalDeltaV(), have = vessel.budget(propMass);
    const used = requiredPropellant(vessel.dryMass, need, vessel.isp);
    const ok = used <= propMass;
    const orbit = el.e < 1
      ? (leo
        ? `peri ${((peri - R_EARTH) / 1000).toFixed(0)} km · apo ${((apo - R_EARTH) / 1000).toFixed(0)} km · e ${el.e.toFixed(3)}`
        : `peri ${(peri / AU).toFixed(2)} AU · apo ${(apo / AU).toFixed(2)} AU · e ${el.e.toFixed(2)}`)
      : `escape trajectory (e ${el.e.toFixed(2)})`;
    readout.innerHTML = `Δv need <b>${(need / 1000).toFixed(2)}</b> · have <b>${(have / 1000).toFixed(2)}</b> km/s`
      + ` <span class="tag">${vessel.nodes.length} burn${vessel.nodes.length > 1 ? 's' : ''}</span><br>`
      + (ok ? `<span class="ok">✓ affordable</span> · burns ${used.toFixed(0)} of ${propMass.toFixed(0)} kg`
        : `<span class="bad">✗ short</span> · needs ${used.toFixed(0)} kg, have ${propMass.toFixed(0)}`) + '<br>' + orbit;
  }
  // Slider edit -> write the selected node.
  function refresh(): void {
    if (!vessel) return;
    const n = vessel.nodes[sel];
    n.t = t0 + parseFloat(time.value) * period * SPAN;
    n.prograde = parseFloat(pro.value); n.normal = parseFloat(nrm.value); n.radial = parseFloat(rad.value);
    applyReadout();
  }
  function sync(): void { if (!vessel) return; selectNode(sel); } // gizmo drag -> reflect in sliders
  function editEngine(): void {
    if (!vessel) return;
    vessel.isp = Math.max(1, parseFloat(isp.value) || vessel.isp);
    vessel.dryMass = Math.max(1, parseFloat(dry.value) || vessel.dryMass);
    propMass = Math.max(0, parseFloat(prop.value) || 0);
    applyReadout();
  }
  for (const el of [time, pro, nrm, rad]) el.addEventListener('input', refresh);
  for (const el of [isp, dry, prop]) el.addEventListener('input', editEngine);
  renderer.onNodeDrag = sync;
  // Node chips: select / add / remove (event-delegated so it survives re-render).
  nodesBox.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button'); if (!t || !vessel) return;
    if (t.id === 'v-add') {
      const lastT = Math.max(...vessel.nodes.map((n) => n.t));
      vessel.nodes.push({ t: Math.min(t0 + period * SPAN, lastT + period * 0.25), prograde: 0, normal: 0, radial: 0 });
      selectNode(vessel.nodes.length - 1);
    } else if (t.id === 'v-del' && vessel.nodes.length > 1) {
      vessel.nodes.splice(sel, 1); selectNode(Math.min(sel, vessel.nodes.length - 1));
    } else if (t.dataset.i !== undefined) selectNode(+t.dataset.i);
  });

  function spawn(): void {
    const c = ctx();
    leo = mode.value === 'leo';
    let r0: number[], v0: number[], mu: number, centerIdx: number;
    if (leo) {
      const r = R_EARTH + 400e3, vc = Math.sqrt(GM_EARTH / r); // 400 km circular, ecliptic-plane prograde
      r0 = [r, 0, 0]; v0 = [0, 0, vc]; mu = GM_EARTH; centerIdx = c.earthIdx;
    } else {
      const s = c.sunIdx * 6, e = c.earthIdx * 6, st = c.state;
      r0 = [st[e] - st[s], st[e + 1] - st[s + 1], st[e + 2] - st[s + 2]];
      v0 = [st[e + 3] - st[s + 3], st[e + 4] - st[s + 4], st[e + 5] - st[s + 5]];
      mu = GM_SUN; centerIdx = c.sunIdx;
    }
    vessel = new Vessel(new Float64Array(r0), new Float64Array(v0), c.tdb, mu);
    t0 = c.tdb; period = periodOf(r0, v0, mu);
    vessel.nodes = [{ t: t0 + period * 0.5, prograde: 0, normal: 0, radial: 0 } as ManeuverNode];
    sel = 0;
    renderer.setVessel(vessel, centerIdx);
    editEngine(); selectNode(0);
    panel.style.display = 'block';
  }
  mode.addEventListener('change', spawn);
  $('#v-close').addEventListener('click', () => { panel.style.display = 'none'; renderer.setVessel(null); vessel = null; });

  return spawn;
}
