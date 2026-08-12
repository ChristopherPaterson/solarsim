// Vessel + maneuver-node controls (build plan §7 P3.5 items 3-5, 12). Spawn a
// craft co-orbiting Earth, then plan an impulsive burn (prograde/normal/radial)
// with a live replanned trajectory and the rocket-equation cost surfaced.

import { Vessel } from '../core/spacecraft/vessel';
import { rvToElements } from '../core/orbital/elements';
import type { Renderer } from '../render/Renderer';

const GM_SUN = 1.32712440018e20;
const AU = 1.495978707e11;

export interface VesselCtx { state: Float64Array; sunIdx: number; earthIdx: number; tdb: number; }

function periodOf(r: number[], v: number[]): number {
  const rn = Math.hypot(r[0], r[1], r[2]), v2 = v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
  const a = 1 / (2 / rn - v2 / GM_SUN);
  return a > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / GM_SUN) : 365.25 * 86400;
}

export function createVesselPanel(renderer: Renderer, app: HTMLElement, ctx: () => VesselCtx): () => void {
  const panel = document.createElement('div');
  panel.className = 'vessel';
  panel.style.cssText = 'position:fixed;left:12px;bottom:12px;width:300px;background:rgba(8,12,18,0.92);border:1px solid #2a3442;border-radius:6px;padding:10px;font:11px ui-monospace,monospace;color:#cfe;display:none;z-index:9';
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:6px"><b style="letter-spacing:1px">VESSEL · MANEUVER NODE</b><span id="v-close" style="cursor:pointer;opacity:0.6">✕</span></div>
    <label style="display:block;margin:4px 0">NODE TIME <input id="v-time" type="range" min="0" max="1" step="0.005" value="0.5" style="width:100%"></label>
    <label style="display:block;margin:4px 0">PROGRADE <span id="v-pl">0</span> m/s <input id="v-pro" type="range" min="-8000" max="8000" step="25" value="0" style="width:100%"></label>
    <label style="display:block;margin:4px 0">NORMAL <span id="v-nl">0</span> m/s <input id="v-nrm" type="range" min="-8000" max="8000" step="25" value="0" style="width:100%"></label>
    <label style="display:block;margin:4px 0">RADIAL <span id="v-rl">0</span> m/s <input id="v-rad" type="range" min="-8000" max="8000" step="25" value="0" style="width:100%"></label>
    <div id="v-readout" style="margin-top:6px;color:#8fd"></div>`;
  app.appendChild(panel);
  const $ = <T extends HTMLElement>(s: string) => panel.querySelector<T>(s)!;
  const readout = $<HTMLDivElement>('#v-readout');
  let vessel: Vessel | null = null;
  let t0 = 0, period = 0;

  const time = $<HTMLInputElement>('#v-time'), pro = $<HTMLInputElement>('#v-pro'), nrm = $<HTMLInputElement>('#v-nrm'), rad = $<HTMLInputElement>('#v-rad');

  function refresh(): void {
    if (!vessel) return;
    const node = vessel.nodes[0];
    node.t = t0 + parseFloat(time.value) * period;
    node.prograde = parseFloat(pro.value); node.normal = parseFloat(nrm.value); node.radial = parseFloat(rad.value);
    $('#v-pl').textContent = pro.value; $('#v-nl').textContent = nrm.value; $('#v-rl').textContent = rad.value;
    // Resulting orbit just after the burn.
    const r = new Float64Array(3), v = new Float64Array(3);
    vessel.stateAt(node.t + 1, r, v);
    const el = rvToElements(r, v, GM_SUN);
    const peri = el.a * (1 - el.e), apo = el.a * (1 + el.e);
    const dv = vessel.totalDeltaV();
    readout.innerHTML = `Δv <b style="color:#ff8">${(dv / 1000).toFixed(2)} km/s</b> · mass ratio ${vessel.massRatio().toFixed(2)}<br>`
      + (el.e < 1 ? `peri ${(peri / AU).toFixed(2)} AU · apo ${(apo / AU).toFixed(2)} AU · e ${el.e.toFixed(2)}` : `hyperbolic escape (e ${el.e.toFixed(2)})`);
  }
  for (const el of [time, pro, nrm, rad]) el.addEventListener('input', refresh);
  $('#v-close').addEventListener('click', () => { panel.style.display = 'none'; renderer.setVessel(null); vessel = null; });

  return function addVessel(): void {
    const c = ctx();
    const s = c.sunIdx * 6, e = c.earthIdx * 6, st = c.state;
    const r0 = [st[e] - st[s], st[e + 1] - st[s + 1], st[e + 2] - st[s + 2]];       // heliocentric pos
    const v0 = [st[e + 3] - st[s + 3], st[e + 4] - st[s + 4], st[e + 5] - st[s + 5]]; // heliocentric vel
    vessel = new Vessel(new Float64Array(r0), new Float64Array(v0), c.tdb, GM_SUN);
    t0 = c.tdb; period = periodOf(r0, v0);
    vessel.nodes = [{ t: t0 + period * 0.5, prograde: 0, normal: 0, radial: 0 }];
    time.value = '0.5'; pro.value = '0'; nrm.value = '0'; rad.value = '0';
    renderer.setVessel(vessel);
    panel.style.display = 'block';
    refresh();
  };
}
