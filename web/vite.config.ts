import { defineConfig } from 'vite';

// `pnpm dev` proxies the local logger server (pnpm --dir .. server → 127.0.0.1:8787) so the page can run LIVE.
const target = 'http://127.0.0.1:8787';
export default defineConfig({
  server: { proxy: { '/events': target, '/api': target, '/rounds.csv': target } },
  build: { target: 'es2022', sourcemap: false },
});
