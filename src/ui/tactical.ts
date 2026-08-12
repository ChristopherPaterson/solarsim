// Tactical display: a top-down ecliptic-plane orbital scope (the signature
// Expanse look). Sun-centred, auto-ranged to the current focus, drawing each
// planet's true orbit trace (Kepler ellipse from live r,v), body dots, velocity
// vectors and a focus highlight. Fed the live barycentric-ecliptic state each
// frame; costs nothing extra since the orbit sampler already exists.
import { sampleOrbitPathRV } from '../core/orbital/elements';

const GM_SUN = 1.32712440018e20;
const AU = 1.495978707e11;
const SEG = 128;
// Planets to plot, with a 3-letter tag and orbit-trace colour.
const PLOT: [string, string, string][] = [
  ['Mercury', 'MER', '#9c8a7a'], ['Venus', 'VEN', '#d9b382'], ['Earth', 'EAR', '#4f8fd8'],
  ['Mars', 'MAR', '#c1440e'], ['Jupiter', 'JUP', '#d8b48f'], ['Saturn', 'SAT', '#e3d9a1'],
  ['Uranus', 'URA', '#9fd8e3'], ['Neptune', 'NEP', '#3f66d8'], ['Pluto', 'PLU', '#ccb39a'],
];

interface Ctx { state: Float64Array; bodyIds: string[]; focusIdx: number; sunIdx: number; }

export function createTactical(app: HTMLElement, getCtx: () => Ctx): { draw: () => void; setVisible: (on: boolean) => void } {
  const S = 232, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.className = 'tactical';
  canvas.width = S * dpr; canvas.height = S * dpr;
  app.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const scratch = new Float64Array(SEG * 3);
  const r = new Float64Array(3), v = new Float64Array(3);
  let visible = true;

  const cx = S / 2, cy = S / 2, R = S / 2 - 12; // scope radius (px)

  function draw(): void {
    if (!visible) return;
    const { state, bodyIds, focusIdx, sunIdx } = getCtx();
    const sx = state[sunIdx * 6], sy = state[sunIdx * 6 + 1];

    // Range: fit the focus body's heliocentric distance to ~65% of the scope.
    const fb = focusIdx * 6;
    let fd = Math.hypot(state[fb] - sx, state[fb + 1] - sy);
    if (!(fd > 0.05 * AU)) fd = 1.6 * AU; // Sun / very-near focus -> inner-system default
    const Rview = fd / 0.65;
    const k = R / Rview; // metres -> px
    const px = (wx: number) => cx + (wx - sx) * k;
    const py = (wy: number) => cy - (wy - sy) * k;

    ctx.clearRect(0, 0, S, S);
    // Scope frame + range rings.
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(5,8,12,0.82)'; ctx.fill();
    ctx.clip(); // everything below is masked to the circular scope
    ctx.strokeStyle = 'rgba(255,171,61,0.10)'; ctx.lineWidth = 1;
    for (let f = 0.33; f <= 1.01; f += 0.335) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();

    // Planet orbit traces + dots + velocity vectors.
    for (const [id, tag, colour] of PLOT) {
      const i = bodyIds.indexOf(id);
      if (i < 0) continue;
      const b = i * 6;
      for (let j = 0; j < 3; j++) { r[j] = state[b + j] - state[sunIdx * 6 + j]; v[j] = state[b + 3 + j] - state[sunIdx * 6 + 3 + j]; }
      if (sampleOrbitPathRV(r, v, GM_SUN, SEG, scratch)) {
        ctx.strokeStyle = colour; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.beginPath();
        for (let s = 0; s < SEG; s++) {
          const X = px(sx + scratch[s * 3]), Y = py(sy + scratch[s * 3 + 1]);
          s === 0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y);
        }
        ctx.closePath(); ctx.stroke(); ctx.globalAlpha = 1;
      }
      const X = px(state[b]), Y = py(state[b + 1]);
      // skip drawing the dot/label if it's outside the scope (keeps it tidy)
      if (Math.hypot(X - cx, Y - cy) > R + 2) continue;
      const focused = i === focusIdx;
      // velocity vector (short, in the direction of motion)
      const vm = Math.hypot(state[b + 3], state[b + 4]) || 1;
      ctx.strokeStyle = colour; ctx.globalAlpha = 0.8; ctx.lineWidth = 1; ctx.beginPath();
      ctx.moveTo(X, Y); ctx.lineTo(X + (state[b + 3] / vm) * 9, Y - (state[b + 4] / vm) * 9); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(X, Y, focused ? 3.2 : 2.2, 0, Math.PI * 2); ctx.fill();
      if (focused) { ctx.strokeStyle = '#5fe0ef'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(X, Y, 6, 0, Math.PI * 2); ctx.stroke(); }
      ctx.fillStyle = focused ? '#5fe0ef' : 'rgba(255,171,61,0.75)';
      ctx.font = '9px ui-monospace, monospace'; ctx.fillText(tag, X + 5, Y - 4);
    }
    // Sun.
    ctx.fillStyle = '#ffcc33'; ctx.beginPath(); ctx.arc(px(sx), py(sy), 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Scope ring + labels (outside the clip).
    ctx.strokeStyle = 'rgba(255,171,61,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,171,61,0.85)'; ctx.font = '9px ui-monospace, monospace';
    ctx.fillText('TACTICAL · ECLIPTIC', 8, 13);
    ctx.fillStyle = 'rgba(122,135,148,0.9)';
    ctx.fillText(`${(Rview / AU).toFixed(Rview < 3 * AU ? 2 : 1)} AU`, 8, S - 7);
  }

  return {
    draw,
    setVisible(on: boolean) { visible = on; canvas.style.display = on ? 'block' : 'none'; },
  };
}
