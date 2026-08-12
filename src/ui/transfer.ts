// Transfer planner (build plan §7 P3.5): pick a start and end body, choose a
// drive — LAMBERT (chemical, coasting) or TORCH (constant-g "sci-fi") — and see
// the trajectory, the time of flight, and the honest Δv/Isp it demands.

import { lambert } from '../core/orbital/lambert';
import { propagate } from '../core/orbital/kepler';
import { torchIntercept, ispForDeltaV, DRIVES } from '../core/spacecraft/torch';
import { massRatio } from '../core/spacecraft/propulsion';
import { G0 } from '../core/units';
import type { Renderer } from '../render/Renderer';

const MU = 1.32712440018e20;
const DAY = 86400;
const N = 220;

export interface TransferCtx { state: Float64Array; bodyIds: string[]; sunIdx: number; tdb: number; }

export function createTransferPanel(renderer: Renderer, app: HTMLElement, ctx: () => TransferCtx): () => void {
  const bodyIds = ctx().bodyIds;
  const opts = bodyIds.map((id, i) => `<option value="${i}">${id.toUpperCase()}</option>`).join('');
  const panel = document.createElement('div');
  panel.className = 'transfer panel';
  // top:256px so it sits below the tactical scope (232px) instead of over it.
  panel.style.cssText = 'left:auto;bottom:auto;right:12px;top:256px;width:min(290px,calc(100vw - 24px));display:none';
  panel.innerHTML = `
    <div class="panel-head"><b>TRANSFER PLANNER</b><span class="panel-x" id="t-close">✕</span></div>
    <div class="row" style="gap:6px"><label>FROM <select id="t-from">${opts}</select></label><label>TO <select id="t-to">${opts}</select></label></div>
    <label class="row" style="margin-top:4px">DRIVE <select id="t-mode"><option value="lambert">LAMBERT (chemical)</option><option value="torch">TORCH (sci-fi)</option></select></label>
    <label style="display:block;margin:6px 0"><span id="t-plabel">TOF ×Hohmann</span> <span id="t-pval"></span><input id="t-param" type="range" min="0.6" max="1.8" step="0.02" value="1" style="width:100%"></label>
    <div id="t-readout" style="margin-top:4px;color:#8fd"></div>`;
  app.appendChild(panel);
  const $ = <T extends HTMLElement>(s: string) => panel.querySelector<T>(s)!;
  const from = $<HTMLSelectElement>('#t-from'), to = $<HTMLSelectElement>('#t-to'), mode = $<HTMLSelectElement>('#t-mode');
  const param = $<HTMLInputElement>('#t-param'), readout = $<HTMLDivElement>('#t-readout');
  from.value = String(bodyIds.indexOf('Earth')); to.value = String(bodyIds.indexOf('Mars'));
  $('#t-close').addEventListener('click', () => { panel.style.display = 'none'; renderer.setTransfer(null, null); });

  const helio = (state: Float64Array, sun: number, idx: number) => {
    const s = sun * 6, b = idx * 6;
    return { r: new Float64Array([state[b] - state[s], state[b + 1] - state[s + 1], state[b + 2] - state[s + 2]]),
      v: new Float64Array([state[b + 3] - state[s + 3], state[b + 4] - state[s + 4], state[b + 5] - state[s + 5]]) };
  };
  const mag = (a: Float64Array) => Math.hypot(a[0], a[1], a[2]);

  function driveNeeded(deltaV: number): string {
    for (const [name, isp] of DRIVES) if (massRatio(deltaV, isp) <= 10) return name;
    return 'beyond antimatter';
  }

  function plan(): void {
    const c = ctx();
    const F = helio(c.state, c.sunIdx, +from.value), T = helio(c.state, c.sunIdx, +to.value);
    const path = new Float64Array(N * 3), rr = new Float64Array(3), vv = new Float64Array(3);
    if (mode.value === 'lambert') {
      $('#t-plabel').textContent = 'TOF ×Hohmann';
      param.min = '0.6'; param.max = '1.8';
      const aT = (mag(F.r) + mag(T.r)) / 2, hoh = Math.PI * Math.sqrt((aT * aT * aT) / MU);
      const tof = parseFloat(param.value) * hoh;
      // Now is rarely a launch window, so search departures over a synodic period
      // for the cheapest transfer at this TOF (endpoints are the future positions).
      const Fr = new Float64Array(3), Fv = new Float64Array(3), Tr = new Float64Array(3), Tv = new Float64Array(3);
      let best = { dv: Infinity, dep: 0, dvDep: 0, dvArr: 0 };
      const bFr = new Float64Array(3), bV1 = new Float64Array(3), bTarr = new Float64Array(3);
      for (let dd = 0; dd <= 800; dd += 12) {
        const dep = dd * DAY;
        propagate(F.r, F.v, MU, dep, Fr, Fv);
        propagate(T.r, T.v, MU, dep + tof, Tr, Tv);
        const { v1, v2 } = lambert(Fr, Tr, tof, MU);
        const dvDep = Math.hypot(v1[0] - Fv[0], v1[1] - Fv[1], v1[2] - Fv[2]);
        const dvArr = Math.hypot(v2[0] - Tv[0], v2[1] - Tv[1], v2[2] - Tv[2]);
        const dv = dvDep + dvArr;
        if (Number.isFinite(dv) && dv < best.dv) { best = { dv, dep, dvDep, dvArr }; bFr.set(Fr); bV1.set(v1); bTarr.set(Tr); }
      }
      for (let i = 0; i < N; i++) { propagate(bFr, bV1, MU, (tof * i) / (N - 1), rr, vv); path[i * 3] = rr[0]; path[i * 3 + 1] = rr[1]; path[i * 3 + 2] = rr[2]; }
      $('#t-pval').textContent = parseFloat(param.value).toFixed(2);
      readout.innerHTML = `depart +${(best.dep / DAY).toFixed(0)} d · ${(tof / DAY).toFixed(0)} d transit · Δv <b style="color:#ff8">${(best.dv / 1000).toFixed(2)} km/s</b><br>depart ${(best.dvDep / 1000).toFixed(2)} + arrive ${(best.dvArr / 1000).toFixed(2)} km/s`;
      renderer.setTransfer(path, new Float64Array([...bFr, ...bTarr]));
    } else {
      $('#t-plabel').textContent = 'ACCEL (g)';
      param.min = '0.1'; param.max = '10';
      const g = parseFloat(param.value);
      const p = torchIntercept(F.r, T.r, T.v, MU, g * G0);
      for (let i = 0; i < N; i++) { const f = i / (N - 1); for (let k = 0; k < 3; k++) path[i * 3 + k] = F.r[k] + (p.intercept[k] - F.r[k]) * f; }
      const isp = ispForDeltaV(p.deltaV, 3);
      $('#t-pval').textContent = g.toFixed(1) + ' g';
      const t = p.tof / DAY;
      readout.innerHTML = `${t < 2 ? (p.tof / 3600).toFixed(0) + ' h' : t.toFixed(1) + ' d'} · peak <b style="color:#ff8">${(p.peakV / 1000).toFixed(0)} km/s</b><br>Δv ${(p.deltaV / 1000).toFixed(0)} km/s · needs Isp ${(isp / 1000).toFixed(0)}k s (<b style="color:#8f8">${driveNeeded(p.deltaV)}</b>)`;
      renderer.setTransfer(path, new Float64Array([...F.r, ...p.intercept]));
    }
  }
  for (const el of [from, to, param]) el.addEventListener('input', plan);
  mode.addEventListener('change', () => { param.value = '1'; plan(); });

  return function toggle(): void {
    const showing = panel.style.display !== 'none';
    panel.style.display = showing ? 'none' : 'block';
    if (showing) renderer.setTransfer(null, null); else plan();
  };
}
