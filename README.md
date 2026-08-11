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

## Status

Live build status is written to the share at `solarsim/status.html`.
