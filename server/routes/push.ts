import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.ts';
import { requireAuth } from '../auth.ts';
import {
  deleteSubscription,
  getVapidKeys,
  listSubscriptions,
  parsePreferences,
  parseSubscription,
  saveSubscription,
  sendTest,
  setPushLogger,
  updatePreferences,
} from '../push.ts';

/** Browser push notifications: every route acts on the current user's own devices only. */
export async function pushRoutes(app: FastifyInstance) {
  setPushLogger(app.log);

  app.get('/api/push/key', { preHandler: requireAuth }, async () => ({ publicKey: getVapidKeys().publicKey }));

  app.get('/api/push/subscriptions', { preHandler: requireAuth }, async (request) => listSubscriptions(request.user!.id));

  app.post<{ Body: { subscription?: unknown; replaces?: unknown } }>(
    '/api/push/subscriptions',
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = await parseSubscription(request.body?.subscription);
      if (typeof input === 'string') {
        audit(request, { action: 'push.subscribe', outcome: 'failure', detail: { reason: input } });
        return reply.code(400).send({ error: input });
      }
      const replaces = typeof request.body?.replaces === 'string' ? request.body.replaces : undefined;
      const saved = saveSubscription(request.user!.id, input, request.headers['user-agent'] ?? null, replaces);
      if (typeof saved === 'string') return reply.code(400).send({ error: saved });
      audit(request, { action: 'push.subscribe', detail: { device: saved.id, service: saved.service, renewed: Boolean(replaces) } });
      return saved;
    },
  );

  app.put<{ Params: { id: string }; Body: { preferences?: unknown } }>(
    '/api/push/subscriptions/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const prefs = parsePreferences(request.body?.preferences);
      if (typeof prefs === 'string') return reply.code(400).send({ error: prefs });
      const saved = updatePreferences(request.user!.id, Number(request.params.id), prefs);
      if (!saved) return reply.code(404).send({ error: 'Device not found' });
      return saved;
    },
  );

  app.delete<{ Params: { id: string } }>('/api/push/subscriptions/:id', { preHandler: requireAuth }, async (request, reply) => {
    const removed = deleteSubscription(request.user!.id, Number(request.params.id));
    if (!removed) return reply.code(404).send({ error: 'Device not found' });
    audit(request, { action: 'push.unsubscribe', detail: { device: removed.id, service: removed.service } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(
    '/api/push/subscriptions/:id/test',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const result = await sendTest(request.user!.id, Number(request.params.id));
      if (result === null) return reply.code(404).send({ error: 'Device not found' });
      if (result === 'gone') return reply.code(410).send({ error: 'The browser no longer accepts notifications for this device; enable them again' });
      if (result === 'failed') return reply.code(502).send({ error: 'The push service did not accept the notification (see server log)' });
      return { ok: true };
    },
  );
}
