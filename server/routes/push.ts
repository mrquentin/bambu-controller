import type { FastifyInstance } from 'fastify';
import { PUSH_EVENTS, type PushPreferences } from '../../shared/api.ts';
import { audit } from '../audit.ts';
import { MAX_PUSH_ENDPOINT_LENGTH } from '../net-policy.ts';
import {
  deleteSubscription,
  getVapidKeys,
  listSubscriptions,
  parseSubscription,
  type BrowserSubscription,
  saveSubscription,
  sendTest,
  updatePreferences,
} from '../push.ts';
import { idParams, type IdParams } from '../validation.ts';

/**
 * The browser's PushSubscription.toJSON(): its shape belongs to the browser
 * (extra fields allowed); `parseSubscription` checks the keys and the endpoint.
 */
const subscribeBody = {
  type: 'object',
  required: ['subscription'],
  additionalProperties: false,
  properties: {
    subscription: {
      type: 'object',
      required: ['endpoint', 'keys'],
      errorMessage: 'Invalid push subscription',
      properties: {
        endpoint: { type: 'string', maxLength: MAX_PUSH_ENDPOINT_LENGTH, errorMessage: 'Invalid push subscription' },
        keys: {
          type: 'object',
          required: ['p256dh', 'auth'],
          errorMessage: 'Invalid push subscription',
          properties: {
            p256dh: { type: 'string', maxLength: 100, errorMessage: 'Invalid push subscription key' },
            auth: { type: 'string', maxLength: 30, errorMessage: 'Invalid push subscription secret' },
          },
        },
      },
    },
    // Previous endpoint of this device when the browser rotated its subscription (sw.js).
    replaces: { type: 'string', maxLength: MAX_PUSH_ENDPOINT_LENGTH },
  },
};

const preferencesBody = {
  type: 'object',
  required: ['preferences'],
  additionalProperties: false,
  properties: {
    preferences: {
      type: 'object',
      additionalProperties: false,
      errorMessage: { type: 'Invalid preferences', required: 'Invalid preferences' },
      properties: Object.fromEntries(PUSH_EVENTS.map((event) => [event, { type: 'boolean' }])),
    },
  },
};

/** Browser push notifications: every route acts on the current user's own devices only. */
export async function pushRoutes(app: FastifyInstance) {
  app.get('/api/push/key', async () => ({ publicKey: getVapidKeys().publicKey }));

  app.get('/api/push/subscriptions', async (request) => listSubscriptions(request.user!.id));

  app.post<{ Body: { subscription: BrowserSubscription; replaces?: string } }>(
    '/api/push/subscriptions',
    { schema: { body: subscribeBody }, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = await parseSubscription(request.body.subscription);
      if (typeof input === 'string') {
        audit(request, { action: 'push.subscribe', outcome: 'failure', detail: { reason: input } });
        return reply.code(400).send({ error: input });
      }
      const replaces = request.body.replaces;
      const saved = saveSubscription(request.user!.id, input, request.headers['user-agent'] ?? null, replaces);
      audit(request, { action: 'push.subscribe', detail: { device: saved.id, service: saved.service, renewed: Boolean(replaces) } });
      return saved;
    },
  );

  app.put<{ Params: IdParams; Body: { preferences: Partial<PushPreferences> } }>(
    '/api/push/subscriptions/:id',
    { schema: { params: idParams, body: preferencesBody } },
    async (request, reply) => {
      const saved = updatePreferences(request.user!.id, Number(request.params.id), request.body.preferences);
      if (!saved) return reply.code(404).send({ error: 'Device not found' });
      return saved;
    },
  );

  app.delete<{ Params: IdParams }>('/api/push/subscriptions/:id', { schema: { params: idParams } }, async (request, reply) => {
    const removed = deleteSubscription(request.user!.id, Number(request.params.id));
    if (!removed) return reply.code(404).send({ error: 'Device not found' });
    audit(request, { action: 'push.unsubscribe', detail: { device: removed.id, service: removed.service } });
    return { ok: true };
  });

  app.post<{ Params: IdParams }>(
    '/api/push/subscriptions/:id/test',
    { schema: { params: idParams }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const result = await sendTest(request.user!.id, Number(request.params.id));
      if (result === null) return reply.code(404).send({ error: 'Device not found' });
      if (result === 'gone') return reply.code(410).send({ error: 'The browser no longer accepts notifications for this device; enable them again' });
      if (result === 'failed') return reply.code(502).send({ error: 'The push service did not accept the notification (see server log)' });
      return { ok: true };
    },
  );
}
