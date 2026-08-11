import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import http from 'http';
import { router as apiRouter } from './src/server/routes';
import { webhookRouter } from './src/server/webhooks';
import { requestId, rateLimit, secureHeaders, RATE_LIMITS } from './src/server/security';
import { db } from './src/server/db';

// Resolve the project root in both run modes:
//  - dev (`tsx server.ts`): executed as ESM, so import.meta.url points at this file.
//  - production (`node dist/server.cjs`): esbuild bundles to CJS where import.meta.url
//    is empty, but the native __dirname points at dist/. The project root is one level up.
const IS_CJS = typeof __dirname !== 'undefined';
const serverDir = IS_CJS ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const projectRoot = IS_CJS ? path.join(__dirname, '..') : serverDir;

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Trust the first proxy hop so req.protocol / req.ip respect X-Forwarded-*
  // headers when running behind a reverse proxy (nginx, a load balancer, or a
  // PaaS like Render/Heroku). This is required for correct Secure-cookie
  // behavior and rate-limit client IPs in production.
  app.set('trust proxy', 1);

  // The Meta webhook POST route needs the RAW request body (it hashes the exact
  // bytes for X-Hub-Signature-256), so it must run BEFORE any JSON/urlencoded
  // body parser consumes the stream. Mount the webhook router first; it installs
  // its own parsers (raw for Meta, urlencoded for Twilio). The auth-protected
  // /api router is mounted afterwards with the global body parsers below.
  app.use('/api/webhooks', webhookRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Security hardening (Phase 22): request IDs, secure headers, rate limiting.
  app.use(requestId);
  app.use(secureHeaders);
  // Auth endpoints get a tighter budget to slow credential stuffing.
  app.use('/api/auth', rateLimit({ ...RATE_LIMITS.auth, prefix: 'auth' }));

  // Static public directory (for embeddable widget.js script)
  app.use(express.static(path.join(projectRoot, 'public')));

  // Mount API Routes FIRST
  app.use('/api', apiRouter);

  // External channel webhooks (Meta/Instagram + Twilio/SMS). Mounted outside the
  // auth-protected /api router because they receive provider-signed traffic, and
  // apply their own signature/verify-token validation. They never trust inbound
  // tenant ids; businesses are resolved server-side from the channel config.
  app.use('/api/webhooks', webhookRouter);

  // Vite middleware for development vs static production build
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(projectRoot, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Centralized JSON error handler. Catches thrown errors (e.g. a missing
  // SESSION_SECRET in production) and returns a clean JSON 500 instead of the
  // default HTML "Internal Server Error" page. Never leaks stack traces.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err?.status || 500;
    const message = status >= 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error.'
      : (err?.message || 'Internal server error.');
    if (status >= 500) {
      console.error('[server] unhandled error:', err?.stack || err);
    }
    res.status(status).json({ error: message });
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 AI Agent Factory SaaS Server listening on http://0.0.0.0:${PORT}`);
  });

  // Graceful shutdown: stop accepting new connections, drain in-flight, close
  // the SQLite handle (WAL checkpoint) so no data is lost on container restart.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} received, shutting down gracefully...`);
    server.close((err) => {
      if (err) console.error('[server] error closing HTTP server:', err);
      try { db.close(); } catch (e) { console.error('[server] error closing DB:', e); }
      console.log('[server] shutdown complete.');
      process.exit(err ? 1 : 0);
    });
    // Hard exit if drain stalls (e.g. a hung connection) so orchestrators can recycle.
    setTimeout(() => { console.error('[server] forced exit after shutdown timeout.'); process.exit(1); }, 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
