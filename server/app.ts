import fs from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { SESSION_COOKIE, requireAuth, userFromToken } from './auth.ts';
import { config } from './config.ts';
import { HttpError } from './http-error.ts';
import { log } from './log.ts';
import { accountRoutes, authRoutes } from './routes/auth.ts';
import { controlRoutes } from './routes/control.ts';
import { MAX_UPLOAD_BYTES, fileRoutes } from './routes/files.ts';
import { historyRoutes } from './routes/history.ts';
import { jobRoutes } from './routes/job.ts';
import { mediaRoutes } from './routes/media.ts';
import { printerRoutes } from './routes/printers.ts';
import { pushRoutes } from './routes/push.ts';
import { ajvOptions, formatValidationError } from './validation.ts';

/** Build the Fastify app (routes, security hooks, static UI) without listening. */
export async function buildApp() {
  const https =
    config.tlsCertFile && config.tlsKeyFile
      ? { cert: fs.readFileSync(config.tlsCertFile), key: fs.readFileSync(config.tlsKeyFile), minVersion: 'TLSv1.2' as const }
      : null;

  const app = Fastify({
    ...(https ? { https } : {}),
    loggerInstance: log,
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    keepAliveTimeout: 10_000,
    requestTimeout: 0, // streams (camera, SSE, video) are long-lived by design
    ajv: ajvOptions,
    schemaErrorFormatter: formatValidationError,
  });

  /**
   * Content Security Policy. Everything is same-origin; Svelte sets inline
   * `style` attributes, hence 'unsafe-inline' for styles only (no inline scripts).
   */
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(config.cookieSecure ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const SECURITY_HEADERS: Record<string, string> = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    ...(config.cookieSecure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { files: 1, fields: 5, fieldSize: 1024, parts: 6, fileSize: MAX_UPLOAD_BYTES },
  });
  await app.register(fastifyRateLimit, {
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    // Static assets are cheap and cached; only throttle the API.
    allowList: (request) => !request.url.startsWith('/api/'),
    onExceeded: (request) => app.log.warn({ ip: request.ip, url: request.url }, 'rate limit exceeded'),
  });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (request, reply) => {
    // Set on the raw response so hijacked streaming responses (SSE, camera,
    // video) carry the same headers.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.raw.setHeader(name, value);
    if (request.url.startsWith('/api/')) reply.raw.setHeader('Cache-Control', 'no-store');
    request.user = userFromToken(request.cookies[SESSION_COOKIE]);
  });

  // State-changing API calls must be JSON or multipart and carry a custom header:
  // browsers can't send those cross-site without a CORS preflight (which is never
  // granted), and session cookies are SameSite=Strict — together this closes CSRF.
  app.addHook('preValidation', async (request, reply) => {
    if (!request.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const type = request.headers['content-type'] ?? '';
    const hasBody = Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding'];
    if (hasBody && !type.startsWith('application/json') && !type.startsWith('multipart/form-data')) {
      return reply.code(415).send({ error: 'Unsupported content type' });
    }
    if (!request.headers['x-requested-with']) {
      return reply.code(403).send({ error: 'Missing X-Requested-With header' });
    }
  });

  // Don't leak internals: unexpected failures get a generic message, details go to the log.
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500 && !(error instanceof HttpError)) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(status).send({ error: 'Internal server error' });
    }
    if (status >= 500) request.log.warn({ err: error }, 'request failed');
    return reply.code(status).send({ error: error.message });
  });

  // Unauthenticated liveness probe (used by the Docker HEALTHCHECK).
  app.get('/api/health', { config: { rateLimit: false } }, async () => ({ ok: true, version: config.version }));

  await app.register(authRoutes);
  await app.register(async (signedIn) => {
    // Before validation, so anonymous callers get 401 rather than a schema error.
    signedIn.addHook('preValidation', requireAuth);
    await signedIn.register(accountRoutes);
    await signedIn.register(printerRoutes);
    await signedIn.register(controlRoutes);
    await signedIn.register(fileRoutes);
    await signedIn.register(mediaRoutes);
    await signedIn.register(historyRoutes);
    await signedIn.register(pushRoutes);
    await signedIn.register(jobRoutes);
  });

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      dotfiles: 'deny',
      // Browsers must always revalidate the service worker so updates apply.
      setHeaders: (reply, filePath) => {
        if (path.basename(filePath) === 'sw.js') reply.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || /\.[a-z0-9]+(\?|$)/i.test(request.url)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.log.warn(`Frontend build not found at ${path.relative(process.cwd(), config.webDist)} — run "npm run build"`);
  }

  return app;
}
