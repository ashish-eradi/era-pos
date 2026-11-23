import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist/renderer',
    commonjsOptions: { include: [/node_modules/, /packages[\\/]contracts[\\/]/] },
  },
});
