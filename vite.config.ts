import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The build lands in web/dist, which `cargo build` embeds into the sift binary.
// `npm run dev` proxies the API to a running `sift` server (SIFT_API, default 127.0.0.1:4800).
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { proxy: { '/api': process.env.SIFT_API ?? 'http://127.0.0.1:4800' } },
});
