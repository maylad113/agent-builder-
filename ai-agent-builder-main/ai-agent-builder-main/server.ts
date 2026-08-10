import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { router as apiRouter } from './src/server/routes';
import { requestId, rateLimit, secureHeaders, RATE_LIMITS } from './src/server/security';

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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 AI Agent Factory SaaS Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
