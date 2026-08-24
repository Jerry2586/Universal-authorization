import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: { outDir: '../public/admin', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/admin/auth': 'http://127.0.0.1:3000',
      '/admin/v1': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
      '/ready': 'http://127.0.0.1:3000',
    },
  },
});
