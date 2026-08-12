// Δv ladder (build plan §7 P3.5 item 13): drives side by side against reachable
// destinations, on a log Δv axis. Makes the point visually — chemical stops at
// the planets, and only a fusion/antimatter torch reaches the days-not-months
// transits from the transfer planner.

import { DRIVES } from '../core/spacecraft/torch';
import { G0 } from '../core/units';

const RATIO = 10; // mass ratio the budgets assume (~90% propellant)
const MIN = 5, MAX = 3e5; // km/s, log axis
// Representative mission Δv (km/s): chemical-era near the bottom, torch far up.
const DEST = [
  { name: 'LEO', dv: 9.4 },
  { name: 'planets & solar escape', dv: 16 },
  { name: 'Mars in ~2 days (1 g)', dv: 1750 },
  { name: 'Jupiter in a week (1 g)', dv: 6000 },
  { name: 'fast interstellar (1 g)', dv: 50000 },
];
const DRIVE_COL: Record<string, string> = {
  chemical: '#9aa4b2', 'nuclear-thermal': '#ff9a3c', ion: '#4fd8e8', 'fusion torch': '#ffd24a', antimatter: '#ff6ad5',
};

export function createDvLadderPanel(app: HTMLElement): () => void {
  const panel = document.createElement('div');
  panel.className = 'dvladder';
  panel.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:560px;background:rgba(8,12,18,0.96);border:1px solid #2a3442;border-radius:8px;padding:12px;font:11px ui-monospace,monospace;color:#cfe;display:none;z-index:11';
  panel.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:6px"><b style="letter-spacing:1px">Δv LADDER · reach at mass ratio ${RATIO}</b><span id="d-close" style="cursor:pointer;opacity:0.6">✕</span></div>
    <canvas id="d-canvas" width="536" height="330" style="width:100%"></canvas>`;
  app.appendChild(panel);
  panel.querySelector('#d-close')!.addEventListener('click', () => (panel.style.display = 'none'));
  const canvas = panel.querySelector<HTMLCanvasElement>('#d-canvas')!;
  const ctx = canvas.getContext('2d')!;

  function draw(): void {
    const W = canvas.width, H = canvas.height, L = 46, R = 168, T = 14, B = 46;
    const pw = W - L - R, ph = H - T - B;
    const lmin = Math.log10(MIN), lmax = Math.log10(MAX);
    const yOf = (dv: number) => T + ph - ((Math.log10(dv) - lmin) / (lmax - lmin)) * ph;
    ctx.clearRect(0, 0, W, H);
    // log gridlines + axis labels (1, 10, 100, 1k, 10k, 100k km/s)
    ctx.textBaseline = 'middle'; ctx.font = '10px ui-monospace';
    for (let e = 1; e <= 5; e++) {
      const dv = 10 ** e; if (dv < MIN || dv > MAX) continue;
      const y = yOf(dv);
      ctx.strokeStyle = '#1b2430'; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke();
      ctx.fillStyle = '#5a6b7a'; ctx.textAlign = 'right'; ctx.fillText(dv >= 1000 ? dv / 1000 + 'k' : String(dv), L - 4, y);
    }
    ctx.save(); ctx.translate(11, T + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = '#7a8b9a'; ctx.fillText('Δv  (km/s)', 0, 0); ctx.restore();
    // destination rungs + labels on the right
    for (const d of DEST) {
      const y = yOf(d.dv);
      ctx.strokeStyle = 'rgba(120,200,255,0.35)'; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#9fd6ff'; ctx.textAlign = 'left'; ctx.fillText(`${d.name}  (${d.dv >= 1000 ? d.dv / 1000 + 'k' : d.dv})`, L + pw + 6, y);
    }
    // drive columns
    const n = DRIVES.length, cw = pw / n;
    DRIVES.forEach(([name, isp], i) => {
      const dv = (isp * G0 * Math.log(RATIO)) / 1000; // km/s budget
      const x = L + i * cw + cw * 0.2, bw = cw * 0.6;
      const top = yOf(Math.min(dv, MAX)), base = T + ph;
      const col = DRIVE_COL[name] ?? '#8fd';
      ctx.fillStyle = col; ctx.globalAlpha = 0.85; ctx.fillRect(x, top, bw, base - top); ctx.globalAlpha = 1;
      ctx.fillStyle = '#0a0e14'; ctx.textAlign = 'center'; ctx.font = '9px ui-monospace';
      ctx.fillText(dv >= 1000 ? (dv / 1000).toFixed(0) + 'k' : dv.toFixed(0), x + bw / 2, top + 8);
      ctx.fillStyle = col; ctx.font = '9px ui-monospace';
      ctx.save(); ctx.translate(x + bw / 2, base + 6); ctx.rotate(-Math.PI / 5); ctx.textAlign = 'right'; ctx.fillText(name, 0, 0); ctx.restore();
    });
  }

  return function toggle(): void {
    const showing = panel.style.display !== 'none';
    panel.style.display = showing ? 'none' : 'block';
    if (!showing) draw();
  };
}
