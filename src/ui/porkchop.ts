// Porkchop plot UI (build plan §7 P3.5 item 10): request an Earth->target Δv
// grid from the worker and render it as the classic heatmap — bright "eye" at
// the optimal launch window, contour bands of rising Δv around it.

import type { SimClient } from '../sim/simClient';
import type { PorkchopResult } from '../sim/protocol';
import { tdbToDate } from '../core/time';

const DAY = 86400;
const SPAN_D = 780; // departure + arrival window width, days
const N = 160;

// Δv (m/s above optimum) -> colour. Bright warm at the optimum, cooling out.
const STOPS: [number, [number, number, number]][] = [
  [0.0, [255, 255, 215]], [0.14, [255, 214, 82]], [0.34, [242, 130, 42]],
  [0.54, [201, 52, 62]], [0.76, [88, 28, 92]], [1.0, [16, 12, 34]],
];
function colour(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
      const f = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

const fmtDate = (tdb: number): string => tdbToDate(tdb as never).toISOString().slice(0, 10);

export function createPorkchopPanel(sim: SimClient, getTdb: () => number, app: HTMLElement): () => void {
  const panel = document.createElement('div');
  panel.className = 'porkchop';
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;width:360px;background:rgba(8,12,18,0.92);border:1px solid #2a3442;border-radius:6px;padding:10px;font:11px ui-monospace,monospace;color:#cfe;display:none;z-index:9';
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <b style="letter-spacing:1px">PORKCHOP · EARTH → MARS</b><span id="pc-close" style="cursor:pointer;opacity:0.6">✕</span>
    </div>
    <canvas id="pc-canvas" width="320" height="320" style="width:100%;image-rendering:auto;border:1px solid #223"></canvas>
    <div style="display:flex;justify-content:space-between;opacity:0.7;margin-top:2px"><span id="pc-depmin"></span><span>departure →</span><span id="pc-depmax"></span></div>
    <div id="pc-readout" style="margin-top:6px;color:#8fd">computing…</div>`;
  app.appendChild(panel);
  const canvas = panel.querySelector<HTMLCanvasElement>('#pc-canvas')!;
  const ctx = canvas.getContext('2d')!;
  const readout = panel.querySelector<HTMLDivElement>('#pc-readout')!;
  panel.querySelector('#pc-close')!.addEventListener('click', () => (panel.style.display = 'none'));

  sim.onPorkchop = (r: PorkchopResult) => render(r);

  function render(r: PorkchopResult): void {
    const off = document.createElement('canvas'); off.width = r.n; off.height = r.m;
    const octx = off.getContext('2d')!; const img = octx.createImageData(r.n, r.m);
    const RANGE = 9000; // m/s above optimum spanned by the colour ramp
    for (let i = 0; i < r.n; i++) {
      for (let j = 0; j < r.m; j++) {
        const dv = r.dv[i * r.m + j];
        // x = departure (i), y = arrival increasing upward (flip j).
        const px = ((r.m - 1 - j) * r.n + i) * 4;
        if (!Number.isFinite(dv)) { img.data[px] = 8; img.data[px + 1] = 10; img.data[px + 2] = 16; img.data[px + 3] = 255; continue; }
        const [cr, cg, cb] = colour((dv - r.bestDv) / RANGE);
        img.data[px] = cr; img.data[px + 1] = cg; img.data[px + 2] = cb; img.data[px + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
    // Optimum crosshair.
    const bi = Math.floor(r.bestIdx / r.m), bj = r.bestIdx % r.m;
    const cx = (bi + 0.5) / r.n * canvas.width, cy = (r.m - 1 - bj + 0.5) / r.m * canvas.height;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, 2 * Math.PI); ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy); ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10); ctx.stroke();
    panel.querySelector('#pc-depmin')!.textContent = fmtDate(r.depStart);
    panel.querySelector('#pc-depmax')!.textContent = fmtDate(r.depStart + r.depStep * (r.n - 1));
    readout.innerHTML = `optimum <b style="color:#ff8">${(r.bestDv / 1000).toFixed(2)} km/s</b> · depart ${fmtDate(r.depStart + bi * r.depStep)} · arrive ${fmtDate(r.arrStart + bj * r.arrStep)}`;
  }

  return function toggle(): void {
    const showing = panel.style.display !== 'none';
    panel.style.display = showing ? 'none' : 'block';
    if (!showing) {
      readout.textContent = 'computing…';
      const t = getTdb();
      sim.requestPorkchop('Mars', t, (SPAN_D * DAY) / N, t + 180 * DAY, (SPAN_D * DAY) / N, N);
    }
  };
}
