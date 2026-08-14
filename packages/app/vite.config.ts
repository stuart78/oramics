import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Electron loads the build from disk, so asset URLs must be relative.
  base: './',
  worker: {
    // AudioWorklet module scripts are ES modules; the default 'iife' output
    // cannot carry the engine's imports.
    format: 'es',
  },
  server: { port: 5273, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        projector: resolve(import.meta.dirname, 'projector.html'),
      },
    },
  },
});
