import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API server (server/index.ts) listens on API_PORT (default 3001).
const apiPort = Number(process.env.API_PORT) || 3001;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
});
