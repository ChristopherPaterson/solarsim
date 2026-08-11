# SolarSim

Browser-based, real-scale 3D simulator of the Sol system. See
[`DESIGN.md`](DESIGN.md) for the brainstorm and the decision-complete build
plan for the phase spec.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173, exposed on the LAN
```

## Build

```bash
npm run build    # tsc + vite -> ./dist
```

## Deploy (LAN)

The container serves the built `./dist` over the LAN on port **8087**. It
bind-mounts `dist`, so after `npm run build` a browser refresh picks up the new
build — no image rebuild.

```bash
npm run build
docker compose up -d          # http://<host>:8087  (this host: 10.92.2.54)
```

COOP/COEP headers are set (`deploy/nginx.conf`) so `SharedArrayBuffer` works
for the P1+ worker core.

## Public URL (Cloudflare Tunnel)

`solarsim.commx.me` is served via a Cloudflare Tunnel. See
[`deploy/cloudflared-compose.yml`](deploy/cloudflared-compose.yml) for the
one-command bring-up once the tunnel token exists.

## Ephemeris (P2)

Planet/Moon positions come from JPL **DE440**, baked to Chebyshev coefficients
in `public/data/ephemeris.bin` and evaluated at runtime by
`src/core/ephemeris/de440.ts`. Accuracy vs JPL Horizons (see `test/de440.test.ts`):
Sun, Mercury, Venus, Earth, Moon, Mars are sub-km (true centres); the four giant
planets are the system **barycentre** (DE440s carries no centre for them), off
the planet centre by 0.2–4 Mm — sub-km there needs the per-planet satellite kernel.

Regenerate (needs Python + `de440s.bsp`):

```bash
curl -O https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp   # -> tools/data/
python -m venv venv && venv/bin/pip install jplephem numpy
venv/bin/python tools/bake_ephemeris.py
```

## Credits

Planet/Sun surface maps in `public/textures/` are the 2K equirectangular
textures from [Solar System Scope](https://www.solarsystemscope.com/textures/),
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Status

Live build status is written to the share at `solarsim/status.html`.
