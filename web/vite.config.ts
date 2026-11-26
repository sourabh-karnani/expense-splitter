import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Same origin in dev: the browser only talks to :5173, so the session cookie works without CORS.
    proxy: { '/api': 'http://127.0.0.1:4000' },
  },
});
