import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, normalize, sep } from 'node:path';

const SERVER = `http://localhost:${process.env.SERVER_PORT || 8080}`;
const DATA_DIR = resolve(__dirname, '../../data');

/**
 * Serve the repo's data/ directly when a file exists there (so `?mock` works without the server running);
 * anything else under /data falls through to the proxy (the server serves the same directory).
 */
function localData(): Plugin {
  const handler = (req: { url?: string }, res: import('node:http').ServerResponse, next: () => void) => {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith('/data/')) return next();
    const file = normalize(resolve(DATA_DIR, decodeURIComponent(url.slice('/data/'.length))));
    if (!file.startsWith(DATA_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
    res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(file).pipe(res);
  };
  return {
    name: 'stargazer-local-data',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

const proxy = {
  '/ws': { target: SERVER, ws: true, changeOrigin: true },
  '/data': { target: SERVER, changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), localData()],
  // Loopback unless HOST is set (e.g. HOST=0.0.0.0 for a tablet), same as the server.
  server: { host: process.env.HOST || 'localhost', proxy },
  preview: { host: process.env.HOST || 'localhost', proxy },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        // Large, rarely-changing libraries in their own chunks (all served locally; just better caching).
        manualChunks: { three: ['three'], astronomy: ['astronomy-engine'], react: ['react', 'react-dom', 'react-dom/client'] },
      },
    },
  },
});
