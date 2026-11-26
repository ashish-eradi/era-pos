import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: { include: ['@era/contracts'] },
  build:{commonjsOptions:{include:[/node_modules/,/packages[\\/]contracts[\\/]/]}},
  server: { proxy: { '/v1': 'http://127.0.0.1:3001' } },
});
