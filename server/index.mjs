/**
 * Standalone production backend for God's Eye View.
 *
 * The live-data proxies (TomTom, OpenSky, AISStream, CelesTrak, Overpass, …)
 * are authored as Vite dev-server middleware in `vite.config.js`. Vite's
 * `server.middlewares` is a Connect stack, and Express is Connect-compatible,
 * so this wrapper mounts the *same* plugin handlers on an Express app — reusing
 * all caching, rate-limiting, daily-budget, and the AIS WebSocket logic without
 * a rewrite. Runs as one always-on process (needed for the AIS socket + shared
 * caches), which serverless functions can't provide.
 *
 * Env: provider keys (TOMTOM_API_KEY, OPENSKY_*, AISSTREAM_API_KEY, …) come
 * from the host's environment. PORT is provided by the host. ALLOWED_ORIGIN
 * (optional, comma-separated) restricts CORS; defaults to '*'.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createProxyPlugins } from '../vite.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env for local runs (host platforms inject env directly). Node 20.12+.
try {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
} catch (err) {
  console.warn('[server] .env load skipped:', err?.message || err);
}

const app = express();
app.disable('x-powered-by');

// CORS — the frontend normally reaches us via a same-origin Vercel rewrite, so
// this is a backstop for direct cross-origin calls. Body is intentionally NOT
// parsed here: several proxies (e.g. Overpass) read the raw request stream.
const allowed = (process.env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowed.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  next();
});

// Health check for host uptime probes.
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

const server = http.createServer(app);

// Minimal Vite-server stand-in: the proxy plugins only touch `.middlewares`
// (the Connect/Express stack) and `.httpServer` (for AIS socket teardown).
const viteServerStub = { middlewares: app, httpServer: server, config: { logger: console } };

let mounted = 0;
for (const plugin of createProxyPlugins()) {
  try {
    plugin.configureServer?.(viteServerStub);
    mounted += 1;
  } catch (err) {
    console.error(`[server] failed to mount plugin "${plugin?.name}":`, err?.message || err);
  }
}

const PORT = parseInt(process.env.PORT, 10) || 8787;
server.listen(PORT, () => {
  console.log(`[server] God's Eye View proxy backend up on :${PORT} (${mounted} plugins mounted)`);
});
