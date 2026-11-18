import fs from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { SESSION_COOKIE, pruneSessions, userFromToken } from './auth.ts';
import { config } from './config.ts';
import { manager } from './manager.ts';
import { authRoutes } from './routes/auth.ts';
import { printerRoutes } from './routes/printers.ts';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: process.env.TRUST_PROXY === 'true',
  bodyLimit: 1024 * 1024,
});

await app.register(fastifyCookie);
await app.register(fastifyMultipart);

app.decorateRequest('user', null);
app.addHook('onRequest', async (request, reply) => {
  request.user = userFromToken(request.cookies[SESSION_COOKIE]);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
});

// State-changing API calls must be JSON or multipart: browsers can't send those
// cross-site without a CORS preflight, which (with SameSite=strict cookies)
// closes off CSRF.
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

await app.register(authRoutes);
await app.register(printerRoutes);

if (fs.existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist });
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

manager.init();
pruneSessions();
setInterval(pruneSessions, 60 * 60 * 1000).unref();

const shutdown = async () => {
  manager.shutdown();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
