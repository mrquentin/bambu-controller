import fs from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { setAuditLogger } from './audit.ts';
import { SESSION_COOKIE, userFromToken } from './auth.ts';
import { config } from './config.ts';
import { authRoutes } from './routes/auth.ts';
import { printerRoutes } from './routes/printers.ts';
import { APP_VERSION } from './version.ts';

export interface BuildOptions {
  /** Pino log level, or false to disable logging (tests). */
  logLevel?: string | false;
}

/** Build the Fastify app (routes, security hooks, static UI) without listening. */
export async function buildApp(options: BuildOptions = {}) {
  const https =
    config.tlsCertFile && config.tlsKeyFile
      ? { cert: fs.readFileSync(config.tlsCertFile), key: fs.readFileSync(config.tlsKeyFile), minVersion: 'TLSv1.2' as const }
      : null;

  const app = Fastify({
    ...(https ? { https } : {}),
    logger: options.logLevel === false ? false : {
      level: options.logLevel ?? (process.env.LOG_LEVEL?.trim() || 'info'),
      // Never log cookies or credentials.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: process.env.TRUST_PROXY === 'true',
    bodyLimit: 1024 * 1024,
    // Don't keep idle keep-alive sockets forever.
    keepAliveTimeout: 10_000,
    requestTimeout: 0, // streams (camera, SSE, video) are long-lived by design
  });
  setAuditLogger(app.log);

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
    limits: { files: 1, fields: 5, fieldSize: 1024, parts: 6, fileSize: 1024 * 1024 * 1024 },
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

  // Don't leak internals: 5xx responses get a generic message, details go to the log.
  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(status).send({ error: 'Internal server error' });
    }
    return reply.code(status).send({ error: error.message });
  });

  // Unauthenticated liveness probe (used by the Docker HEALTHCHECK).
  app.get('/api/health', { config: { rateLimit: false } }, async () => ({ ok: true, version: APP_VERSION }));

  await app.register(authRoutes);
  await app.register(printerRoutes);

  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, dotfiles: 'deny' });
    app.setNotFoundHandler((request, reply) => {
      // API routes and missing files (anything with an extension) get a real 404.
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
