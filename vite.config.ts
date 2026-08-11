import { defineConfig } from 'vite';

// COOP/COEP so SharedArrayBuffer works in dev too (needed from P1 on).
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

export default defineConfig({
  plugins: [crossOriginIsolation],
  server: { host: true }, // expose on LAN during dev
  build: { target: 'esnext' }, // top-level await + WebGPU are modern-only
});
