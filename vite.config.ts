import { defineConfig } from 'vite';

// base './' keeps every asset reference relative so the built dist/ can be
// deployed from any static host sub-path without extra configuration.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
