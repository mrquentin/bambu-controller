import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.ts';
import { pushResolver } from '../server/net-policy.ts';

/** Push notification API against the real app (in-memory requests, temp database, stubbed DNS + fetch). */
let app: FastifyInstance;
let cookie = '';
const json = { 'content-type': 'application/json', 'x-requested-with': 'test' };
const realFetch = globalThis.fetch;
const realLookup = pushResolver.lookup;
let pushStatus = 201;
let pushed: string[] = [];

function browserSubscription(endpoint: string) {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  return { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}

before(async () => {
  pushResolver.lookup = async (host) => (host.endsWith('.push.example') ? ['93.184.216.34'] : ['192.168.1.10']);
  globalThis.fetch = (async (url: string) => {
    pushed.push(url);
    return new Response(null, { status: pushStatus });
  }) as typeof fetch;
  app = await buildApp({ logLevel: false });
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: json,
    payload: { username: 'admin', password: 'Sup3r-Secret!' },
  });
  cookie = String(res.headers['set-cookie']).split(';')[0];
});

after(async () => {
  globalThis.fetch = realFetch;
  pushResolver.lookup = realLookup;
  await app.close();
});

describe('push API', () => {
  let id = 0;
  const endpoint = 'https://fcm.push.example/send/device-1';

  it('requires authentication', async () => {
    for (const [method, url] of [['GET', '/api/push/key'], ['GET', '/api/push/subscriptions']] as const) {
      assert.equal((await app.inject({ method, url })).statusCode, 401);
    }
  });

  it('serves a stable VAPID public key', async () => {
    const a = (await app.inject({ method: 'GET', url: '/api/push/key', headers: { cookie } })).json();
    const b = (await app.inject({ method: 'GET', url: '/api/push/key', headers: { cookie } })).json();
    assert.equal(Buffer.from(a.publicKey, 'base64url').length, 65);
    assert.equal(a.publicKey, b.publicKey);
  });

  it('rejects endpoints on the local network and malformed keys', async () => {
    for (const subscription of [
      browserSubscription('https://printer-hub.lan/send/x'),
      browserSubscription('http://fcm.push.example/send/x'),
      { endpoint, keys: { p256dh: 'abc', auth: 'def' } },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/push/subscriptions', headers: { ...json, cookie }, payload: { subscription } });
      assert.equal(res.statusCode, 400);
    }
  });

  it('subscribes the current device with default preferences', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      headers: { ...json, cookie, 'user-agent': 'Mozilla/5.0 (Android) Chrome/140' },
      payload: { subscription: browserSubscription(endpoint) },
    });
    assert.equal(res.statusCode, 200);
    const saved = res.json();
    id = saved.id;
    assert.deepEqual(saved.preferences, { started: false, finished: true, failed: true, paused: true, hms: true });
    assert.equal(saved.fingerprint, crypto.createHash('sha256').update(endpoint).digest('hex'));
    assert.equal(saved.endpoint, undefined); // the capability URL is never echoed back

    // Re-subscribing the same endpoint updates instead of duplicating.
    await app.inject({ method: 'POST', url: '/api/push/subscriptions', headers: { ...json, cookie }, payload: { subscription: browserSubscription(endpoint) } });
    const list = (await app.inject({ method: 'GET', url: '/api/push/subscriptions', headers: { cookie } })).json();
    assert.equal(list.length, 1);
  });

  it('updates preferences', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/push/subscriptions/${id}`,
      headers: { ...json, cookie },
      payload: { preferences: { started: true, hms: false } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().preferences.started, true);
    assert.equal(res.json().preferences.hms, false);
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/push/subscriptions/${id}`,
      headers: { ...json, cookie },
      payload: { preferences: { everything: true } },
    });
    assert.equal(bad.statusCode, 400);
  });

  it('sends a test notification and forgets devices the push service dropped', async () => {
    pushed = [];
    const ok = await app.inject({ method: 'POST', url: `/api/push/subscriptions/${id}/test`, headers: { cookie, 'x-requested-with': 'test' } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(pushed, [endpoint]);

    pushStatus = 410;
    const gone = await app.inject({ method: 'POST', url: `/api/push/subscriptions/${id}/test`, headers: { cookie, 'x-requested-with': 'test' } });
    assert.equal(gone.statusCode, 410);
    pushStatus = 201;
    const list = (await app.inject({ method: 'GET', url: '/api/push/subscriptions', headers: { cookie } })).json();
    assert.equal(list.length, 0);
  });

  it('unsubscribes and audits it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      headers: { ...json, cookie },
      payload: { subscription: browserSubscription('https://fcm.push.example/send/device-2') },
    });
    const del = await app.inject({ method: 'DELETE', url: `/api/push/subscriptions/${res.json().id}`, headers: { cookie, 'x-requested-with': 'test' } });
    assert.equal(del.statusCode, 200);
    const again = await app.inject({ method: 'DELETE', url: `/api/push/subscriptions/${res.json().id}`, headers: { cookie, 'x-requested-with': 'test' } });
    assert.equal(again.statusCode, 404);

    const actions = (await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })).json().map((a: any) => `${a.action}:${a.outcome}`);
    assert.ok(actions.includes('push.subscribe:success'));
    assert.ok(actions.includes('push.subscribe:failure'));
    assert.ok(actions.includes('push.unsubscribe:success'));
  });

  it("can't touch another user's devices", async () => {
    await app.inject({ method: 'POST', url: '/api/users', headers: { ...json, cookie }, payload: { username: 'other', password: 'Sup3r-Secret!2' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: json, payload: { username: 'other', password: 'Sup3r-Secret!2' } });
    const otherCookie = String(login.headers['set-cookie']).split(';')[0];
    const mine = await app.inject({
      method: 'POST',
      url: '/api/push/subscriptions',
      headers: { ...json, cookie },
      payload: { subscription: browserSubscription('https://fcm.push.example/send/device-3') },
    });
    const sid = mine.json().id;
    for (const [method, url] of [['DELETE', `/api/push/subscriptions/${sid}`], ['POST', `/api/push/subscriptions/${sid}/test`]] as const) {
      const res = await app.inject({ method, url, headers: { cookie: otherCookie, 'x-requested-with': 'test' } });
      assert.equal(res.statusCode, 404);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/push/subscriptions', headers: { cookie: otherCookie } })).json().length, 0);
  });
});
