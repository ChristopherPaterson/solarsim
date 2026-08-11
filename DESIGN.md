# SolarSim — Design & Technology Brainstorm

A browser-based, real-scale 3D simulator of the Sol system: all planets, their major
moons, asteroid populations, and a sandbox mode for inserting new bodies and watching
how they perturb existing orbits (in the spirit of the Encarta 95 orbital simulator).

**Status:** design document / brainstorm. Nothing implemented yet. This is the thing to
argue with before any code gets written.

---

## 1. Product goals

| Goal | Meaning |
| --- | --- |
| Zero-friction start | Load the URL, the sim is already running, bodies at their true current positions. No menus, no loading gate. |
| Real scale | True distances and radii. No fudged spacing by default. |
| Real orbits | Positions match JPL ephemerides to a stated, tested tolerance. |
| Time control | Scrub to any date, pause, run at 1× to ~1e6×, forward and backward. |
| Free camera | Fly anywhere from a moon's surface to outside Neptune's orbit, continuously. |
| Sandbox | Insert arbitrary bodies, give them mass and velocity, watch the system respond. |
| Texture-ready | Ship flat-colour bodies first, but the material pipeline assumes textures from day one. |
| High quality & performant | 60 fps at 1080p on integrated graphics; fast first paint. |

### Non-goals (for now)

- Spacecraft simulation, manoeuvre planning, delta-v budgeting.
- Surface/terrain rendering or landing.
- Relativistic corrections beyond what the ephemeris data already bakes in.
- Multiplayer.

---

## 2. The central problem: dynamic range

The system spans roughly **ten orders of magnitude** — Deimos is ~6 km across, Neptune's
orbit is ~4.5e9 km. Two things break immediately:

- **float32 world coordinates.** ~7 significant decimal digits. At Neptune's distance the
  spacing between representable float32 values is thousands of kilometres. Objects jitter,
  snap, and interpenetrate.
- **float32 depth buffer.** Standard perspective depth concentrates almost all precision
  near the near plane. A near/far ratio of 1e10 produces catastrophic z-fighting.

Nearly every architectural decision below falls out of solving these.

### 2.1 Camera-relative rendering (floating origin)

- All simulation state lives in **float64** (`Float64Array`; JS numbers are IEEE754 doubles).
- Each frame, compute `render_pos = body_pos_f64 - camera_pos_f64` **in double**, then
  downcast the (now small) result to float32 for the GPU.
- The camera is permanently at the origin in render space; the world moves around it.
- Body-local geometry stays in body-local units, so a 6 km moon is modelled at 6 km.

This alone fixes positional precision at every scale. It is not optional and it is easier
to build in at the start than to retrofit.

### 2.2 Depth precision

Three options, roughly in increasing order of robustness:

1. **Logarithmic depth buffer.** Three.js exposes `logarithmicDepthBuffer: true`. Easy,
   but costs fill rate, disables some early-Z optimisation, and interpolates incorrectly
   across large triangles unless depth is written per-fragment.
2. **Reversed-Z with a floating-point depth buffer.** Pairs float32 depth's exponent
   distribution against perspective's `1/z`, yielding near-uniform relative precision.
   Excellent, but needs renderer-level support (clip control / depth clamping) — better
   supported on the WebGPU path than WebGL2.
3. **Cascaded depth passes.** Render the scene in 2–3 nested frustums (e.g. 1 m–1e6 m,
   1e6 m–1e9 m, 1e9 m–1e14 m), clearing depth between passes and compositing front-to-back.
   This is what Celestia, Space Engine, and Kerbal Space Program do. Costs extra draw
   calls but is bulletproof and renderer-agnostic.

**Recommendation:** start with (1) to get moving, design the render graph so (3) can be
dropped in as a pass-list change, and adopt (2) opportunistically on WebGPU.

### 2.3 Camera motion across scales

Linear interpolation of camera distance feels broken across this range. **Interpolate
distance in log space** — `d(t) = d0 * (d1/d0)^t` — so "fly from Phobos to Neptune" has a
constant *perceptual* rate of approach. Similarly, scale movement speed, zoom sensitivity,
and near-plane distance to the distance to the focused body.

---

## 3. Orbital mechanics: two modes

### 3.1 Ephemeris mode (default)

Bodies follow *evaluated* positions rather than integrated ones. No drift, no error
accumulation, exactly reproducible at any date, and instant seeking to arbitrary times —
which is what makes the date scrubber feel good.

Tiered data strategy, so first paint is immediate and accuracy improves as data streams:

**Tier 0 — bundled, a few KB, available at frame 1**
Standish's *Approximate Positions of the Major Planets*: Keplerian elements plus secular
rates for the 8 planets. Accurate to roughly arcminutes over 1800–2050. Solve Kepler's
equation (Newton–Raphson, or Danby's method for high eccentricity) per body per frame.
This is what renders before anything has downloaded.

**Tier 1 — streamed, higher fidelity**
JPL Development Ephemeris (DE440/DE441) SPK kernels are, structurally, sets of Chebyshev
polynomial coefficients over time intervals. A `.bsp` reader in TypeScript is very
tractable and gets sub-kilometre agreement with Horizons. Full kernels are tens of MB, so
a build step must subset them to the supported date range and body list, and the runtime
should fetch per-body chunks lazily.

**Moons — the genuinely hard part**
Each satellite system has its own analytic theory: ELP2000 (Luna), Lainey L1/L2 (Galileans),
TASS1.7 (Saturnian), GUST86 (Uranian), plus assorted one-offs for irregular/retrograde
satellites. Porting all of them is a large, error-prone job.

*Preferred approach:* query JPL Horizons offline in a build script for each moon over the
supported date range, **fit our own Chebyshev polynomials** to the sampled positions, and
ship those. One uniform runtime evaluator, one uniform data format, accuracy controlled by
a single knob (polynomial degree vs. interval length), and it extends to any body Horizons
knows about — including comets and named asteroids — for free.

*Fallback:* for minor/irregular moons where accuracy matters least, mean Keplerian elements
in the parent's frame are visually fine.

### 3.2 N-body mode (the sandbox)

When the user inserts a body or asks "what if", switch the affected set to numerical
integration.

- **WHFast** (Wisdom–Holman symplectic mapping) — the standard for long-term planetary
  integration. Bounded energy error over millions of steps, cheap per step. Default.
- **IAS15** (adaptive, 15th-order Gauss–Radau) — near machine precision, handles close
  encounters and high eccentricity where WHFast degrades. Switch to it automatically when
  a close-encounter criterion trips.
- **Velocity Verlet / Yoshida-4** — trivial to implement, good enough for a first
  milestone before either of the above exists.

REBOUND implements WHFast and IAS15 in C and compiles to WASM cleanly. **Check its licence
before committing** — the author's implementation is, to my recollection, GPLv3, which may
or may not be acceptable depending on how this project is licensed. If it isn't, both
integrators are well-documented enough to reimplement.

**Massless test particles vs. massive bodies.** Expose this as an explicit toggle on
inserted objects. A test particle is influenced by the system but does not influence it:
O(N) instead of O(N²), no perturbation of the reference ephemeris, and it covers the
majority of "where would this go?" questions. Massive bodies are the interesting case and
should exist, but shouldn't be the default.

**Hybrid handoff.** In sandbox mode, keep the major planets on their ephemeris unless the
inserted body is massive enough to matter; only then promote the whole system to full
N-body with ephemeris state as the initial condition. Cheap, and preserves accuracy in the
common case.

### 3.3 Time

- Store epoch as a **split Julian Date** (integer day + fractional day, both doubles) to
  keep sub-millisecond resolution across centuries.
- Work internally in **TDB/TT**; convert to UTC only for display (and handle leap seconds
  in that conversion, not in the sim).
- Time warp is a multiplier on simulated seconds per wall-clock second, exposed as a
  logarithmic slider from 1× to ~1e6×, forward and reverse, plus a "now" button.
- In ephemeris mode, warping is free (just evaluate at a different `t`). In N-body mode,
  warping means more integration steps per frame — so cap the warp rate by a per-frame
  step budget and tell the user when it's the limiter.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Main thread                                             │
│  ├─ UI layer (HUD, time controls, body inspector)       │
│  ├─ Camera controller (log-space dolly, frame switching)│
│  └─ Renderer (Three.js; camera-relative transforms)     │
└───────────────┬─────────────────────────────────────────┘
                │ SharedArrayBuffer ring buffer (f64 states)
┌───────────────┴─────────────────────────────────────────┐
│ Physics Worker                                          │
│  ├─ Ephemeris evaluator (Chebyshev / Kepler)  [WASM]    │
│  ├─ N-body integrator (WHFast / IAS15)        [WASM]    │
│  └─ Fixed-timestep loop, decoupled from frame rate      │
└─────────────────────────────────────────────────────────┘
```

- The physics worker runs at a **fixed timestep**, publishing state snapshots into a ring
  buffer. The render thread reads the two most recent snapshots and interpolates. Frame
  rate and simulation rate are fully decoupled.
- `SharedArrayBuffer` requires **COOP/COEP headers** (`Cross-Origin-Opener-Policy:
  same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). Configure this in the host
  from day one — discovering it late is painful, and it constrains embedding third-party
  resources.
- The UI layer must never touch the render loop. All UI state flows through a small
  signal/event bus; no framework reconciliation inside `requestAnimationFrame`.

---

## 5. Rendering

### 5.1 Engine choice

| Option | For | Against |
| --- | --- | --- |
| **Three.js** ← recommended | Largest ecosystem, mature WebGPURenderer + TSL, easy WebGL2 fallback, lots of prior art for space scenes | Lower-level; scene graph is not scale-aware, we build that ourselves |
| Babylon.js | Batteries included, excellent inspector/debug tooling, strong WebGPU | Smaller ecosystem, heavier default bundle |
| Raw WebGPU | Total control over depth, precision, compute | Months of engine work before the first planet appears; no WebGL2 fallback |

Three.js with the WebGPU renderer where available and WebGL2 as fallback. Keep our own
scene abstraction on top so the engine stays swappable and camera-relative transforms are
enforced in one place.

### 5.2 Bodies

- **Planets and moons** (~200 named objects): shared sphere geometry, per-instance
  transform and material params. Instancing is not strictly needed at this count but costs
  nothing to set up.
- **Level of detail:** sphere tessellation by apparent angular size. Below a few pixels,
  swap to a **magnitude-based point impostor** so bodies never silently vanish — a
  distant Jupiter should be a bright dot, not nothing.
- **Rings:** a single textured annulus with alpha, plus shadow received from the planet and
  cast onto it.

### 5.3 Asteroids — do them on the GPU

The Minor Planet Center catalogue holds well over a million objects. Do **not** put these
on the CPU.

Pack orbital elements `(a, e, i, Ω, ω, M₀, n)` into a data texture — about 28 bytes per
object — and **solve Kepler's equation in the vertex shader**, computing position directly
from element set + current time. 100k asteroids is a ~2.8 MB texture and costs essentially
nothing per frame; the CPU never touches them.

This gives, as toggleable layers: main belt, Trojans/Greeks, Hildas, near-Earth objects,
Kuiper belt, scattered disc. Colour by family, orbital class, or discovery date. It's also
the single most visually striking feature in the whole project for the least work.

Caveat: these are unperturbed two-body elements, so they drift from truth over decades.
Fine for a population visualisation; anything the user *selects* gets promoted to a proper
ephemeris or integrated body.

### 5.4 Visual quality — high impact, low cost

- **Analytic eclipse shadows.** Sphere-on-sphere occlusion with a known solar angular
  radius has a closed-form penumbra. Compute it in the fragment shader: no shadow maps, no
  cascades, and you get correct umbra/penumbra — Io's shadow on Jupiter, Luna's on Earth.
  Very high impressiveness-to-effort ratio.
- **Physically-based sunlight** with true inverse-square falloff, HDR pipeline, and
  ACES or AgX tonemapping. Neptune should genuinely look dim; the exposure control does the
  work rather than fake ambient light.
- **Real starfield.** Hipparcos or the Yale Bright Star Catalogue: ~9,000 stars to
  magnitude 6.5, point size from apparent magnitude, colour from B–V index. Tiny payload,
  and vastly better than a skybox because it's *correct* — constellations line up, and the
  view from Neptune is right.
- **Sun rendering:** billboard with limb darkening plus a restrained bloom. Resist the urge
  to overdo the bloom.
- **Atmospheric shells** for Earth, Venus, Titan, Mars: single-scattering analytic model on
  a slightly larger sphere. Later milestone, big payoff.
- **Orbit paths:** do *not* accumulate a polyline of past positions in world coordinates —
  that reintroduces the precision problem. Generate the osculating ellipse analytically in
  the parent body's frame and transform it camera-relative, or keep a rolling double-precision
  buffer that is rebased against the camera each frame.

### 5.5 Textures (later, but plan the seams now)

- Material abstraction should carry albedo / normal / roughness / emissive (night lights) /
  ring / cloud slots from the start, even while everything renders flat-coloured.
- Ship **KTX2 / Basis Universal** compressed textures — transcode to the platform's native
  format at load, far smaller than PNG and GPU-resident without decode cost.
- Stream per-body on focus, not upfront. Most sessions look at three or four bodies.
- Earth's 21600×10800 maps need tiling and a mip/LOD scheme; every other body fits in a
  single mip chain comfortably.

---

## 6. Features

### 6.1 Core

- **Time:** pause/play, log-scale warp slider (1× … 1e6×, both directions), date-time picker,
  "now" button, keyboard shortcuts.
- **Camera modes:** free orbit; body-locked (follows position, free orientation); body-fixed
  (rotates with the surface); velocity-chase.
- **Reference frames:** heliocentric inertial, ecliptic, body-centric, barycentric. Switching
  frames is one of the most genuinely illuminating features available — Mars's retrograde
  loop makes instant sense when you can toggle the frame it's drawn in.
- **Focus/goto:** click a body or search by name; smooth log-space flight to it.
- **HUD:** distance, orbital elements, velocity, apparent magnitude, physical stats.
- **Radius exaggeration slider**, clearly labelled as non-physical, because real-scale
  planets are invisible dots from any useful vantage point and people will want this.
- **URL state serialisation:** `#t=2026-08-11T12:00:00Z&focus=mars&cam=...&warp=1000`.
  Every view is shareable and reload-safe, and it directly serves the "load the address and
  the sim starts" requirement — a bare URL is just the default state.

### 6.2 The Encarta sandbox

- Click to place a body; drag to set a velocity vector, with a **live trajectory preview
  that integrates forward while you drag**.
- Mass and radius sliders; presets (comet, rogue planet, second Jupiter, brown dwarf).
- Test-particle vs. massive toggle.
- Collision detection with merge (conserving momentum) or fragmentation.
- **Snapshot-based rewind** — periodic state snapshots let the user scrub back and retry
  without re-integrating from the epoch.
- Ejection/capture detection with a notification ("your body has left the system").
- Lagrange point markers for any two-body pair; stability visualisation.
- Energy/momentum conservation readout — doubles as a live integrator sanity check.

### 6.3 Later / speculative

- Porkchop-plot transfer window planner.
- Constellation lines and labels with declutter.
- Measurement tools (distance, angular separation).
- WebXR mode — the scale genuinely lands in VR in a way it never does on a monitor.
- Historical/future event bookmarks (eclipses, oppositions, conjunctions, Voyager flybys).
- Scenario permalinks for sandbox setups, so a "what if" is shareable.

---

## 7. Data pipeline

Build-time Node scripts fetch from authoritative sources and bake compact, versioned binary
blobs committed as static assets. **Zero runtime third-party API calls** — the sim must work
offline after first load, and must not break because someone else's service changed.

| Source | Provides |
| --- | --- |
| JPL Horizons | Ephemerides for planets, moons, comets, named asteroids (sampled, then Chebyshev-fitted by us) |
| JPL SSD / DE44x SPK | High-precision planetary ephemeris kernels |
| JPL SBDB | Asteroid and comet orbital elements, physical parameters |
| MPC | Bulk minor planet catalogue for the GPU population layer |
| IAU WGCCRE | Rotation models, pole orientations, prime meridians |
| Hipparcos / Yale BSC | Background starfield |

Output format: tightly packed `Float64Array` / `Float32Array` blobs with a small JSON
manifest, versioned by content hash so caching is trivially correct.

---

## 8. Correctness and testing

- **Golden-value tests against JPL Horizons.** For every body, at N epochs spread across the
  supported date range, assert computed position is within a stated tolerance (e.g. < 100 km
  for planets, < 10 km for Luna). This converts "is the ephemeris right?" from a vibe into a
  CI check, and it is the single highest-value quality investment in the project.
- **Integrator conservation tests:** total energy and angular momentum drift bounded over
  long runs; symplectic integrators should show bounded oscillation, not secular drift.
- **Known-scenario regression:** integrate the real system forward and confirm known
  configurations reproduce (e.g. a specific eclipse date, a Galilean moon mutual event).
- **Visual regression** via Playwright screenshots at fixed epochs and camera states.
- **Precision stress test:** an automated fly-through from a moon's surface to outside
  Neptune's orbit, asserting no NaNs, no jitter above threshold, no depth artefacts.

---

## 9. Performance budget

| Metric | Target |
| --- | --- |
| Frame time | < 16.6 ms at 1080p on integrated graphics |
| Time to first rendered frame | < 1.5 s on a warm cache |
| Initial JS + data payload | < 1.5 MB gzipped |
| Physics step (ephemeris mode, ~200 bodies) | < 1 ms |
| Physics step (N-body, ~50 massive bodies) | < 4 ms |
| Asteroid layer (100k objects) | < 1 ms GPU |

Instrument these from the first milestone with an in-app perf overlay. A budget nobody
measures is a wish.

---

## 10. Proposed milestones

| # | Deliverable |
| --- | --- |
| **M0** | Vite + TS skeleton, Three.js renderer, camera-relative transform layer, perf overlay, CI. |
| **M1** | 8 planets + Sun from bundled Keplerian elements. Free camera with log-space dolly. Time controls. Correct positions *now*. **This is the first genuinely usable build.** |
| **M2** | Major moons. Physics worker + SharedArrayBuffer. Body-locked/body-fixed cameras. Reference frame switching. Orbit path rendering. |
| **M3** | N-body sandbox: insert bodies, drag velocity vectors, live trajectory preview, collisions, rewind. |
| **M4** | GPU asteroid populations — belt, Trojans, Kuiper belt, NEOs. |
| **M5** | Visual pass: textures + KTX2 streaming, analytic eclipse shadows, real starfield, HDR/tonemapping, rings. |
| **M6** | Chebyshev ephemeris upgrade, Horizons golden tests, accuracy tightened to stated tolerances. |
| **M7** | Polish: URL state, search, labels with declutter, event bookmarks, WebXR. |

M1 is deliberately scoped to be shippable on its own — real planets, real positions, real
scale, flat colours, working camera and time controls. Everything after is enhancement.

---

## 11. Open questions

1. **Accuracy target.** Arcminute (bundled elements, tiny, instant) or sub-kilometre
   (streamed Chebyshev data, more build machinery)? This decides how much of Section 3.1
   gets built.
2. **Date range.** 1900–2100 keeps data small and covers every plausible use. Wider ranges
   multiply the ephemeris payload.
3. **Sandbox fidelity.** Is the sandbox a toy ("nudge Jupiter, watch chaos") or a tool
   (trustworthy long-term integration)? This decides WHFast/IAS15-in-WASM vs. a simple
   Verlet in TypeScript.
4. **Licence.** Determines whether REBOUND (likely GPLv3 — verify) is usable, or whether the
   integrators need reimplementing.
5. **Moon coverage.** Major moons only (~20, high value, manageable) or all ~300 named
   satellites (long tail of irregular objects with poor data)?
6. **UI framework.** Svelte, Lit, React, or none. Affects bundle size but not architecture,
   since the UI is firewalled from the render loop either way.
