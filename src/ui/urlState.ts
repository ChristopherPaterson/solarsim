// URL-as-state (build plan §7 P1): #t=<tdb>&focus=<id>&rate=<r>&scale=<x>.
// Shareable, reloadable. `frame` is reserved for P6.

export interface UrlState {
  t?: number; // TDB seconds past J2000
  focus?: string;
  rate?: number;
  scale?: number;
}

export function readState(): UrlState {
  const p = new URLSearchParams(location.hash.slice(1));
  const num = (k: string) => (p.has(k) ? Number(p.get(k)) : undefined);
  const out: UrlState = {};
  const t = num('t'); if (t !== undefined && !isNaN(t)) out.t = t;
  const focus = p.get('focus'); if (focus) out.focus = focus;
  const rate = num('rate'); if (rate !== undefined && !isNaN(rate)) out.rate = rate;
  const scale = num('scale'); if (scale !== undefined && !isNaN(scale)) out.scale = scale;
  return out;
}

export function writeState(s: UrlState): void {
  const p = new URLSearchParams();
  if (s.t !== undefined) p.set('t', s.t.toFixed(1));
  if (s.focus) p.set('focus', s.focus);
  if (s.rate !== undefined) p.set('rate', String(s.rate));
  if (s.scale !== undefined) p.set('scale', String(Math.round(s.scale)));
  history.replaceState(null, '', `#${p.toString()}`);
}
