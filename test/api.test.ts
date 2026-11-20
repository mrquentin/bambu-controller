import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.ts';

/** Integration tests against the real app (in-memory requests, temp database). */
let app: FastifyInstance;
let cookie = '';

const json = { 'content-type': 'application/json', 'x-requested-with': 'test' };

function sessionCookie(res: { headers: Record<string, unknown> }) {
  const set = res.headers['set-cookie'];
  const raw = Array.isArray(set) ? set[0] : String(set ?? '');
  return raw.split(';')[0];
}

before(async () => {
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app.close();
});

describe('API', () => {
  it('health check is public and reports the version', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.equal(typeof res.json().version, 'string');
  });

  it('sends security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.match(String(res.headers['content-security-policy']), /script-src 'self'/);
    assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('requires authentication for printer endpoints', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/printers' });
    assert.equal(res.statusCode, 401);
  });

  it('reports that first-run setup is required', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/state' });
    assert.deepEqual(res.json(), { setupRequired: true, user: null });
  });

  it('rejects state-changing requests without the CSRF header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'admin', password: 'Sup3r-Secret!' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('rejects form-encoded bodies (CSRF via HTML forms)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'test' },
      payload: 'username=admin&password=x',
    });
    assert.equal(res.statusCode, 415);
  });

  it('enforces the password policy during setup', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: json,
      payload: { username: 'admin', password: 'password1' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('creates the first account and sets a hardened session cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: json,
      payload: { username: 'admin', password: 'Sup3r-Secret!' },
    });
    assert.equal(res.statusCode, 200);
    const set = String(res.headers['set-cookie']);
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Strict/i);
    cookie = sessionCookie(res);
    assert.match(cookie, /^bc_session=/);
  });

  it('refuses a second setup', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: json,
      payload: { username: 'other', password: 'Sup3r-Secret!' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('authenticates with the session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/printers', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });

  it('validates printer input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/printers',
      headers: { ...json, cookie },
      payload: { name: 'x', model: 'X1C', serial: 'bad serial!', ip: '192.168.1.5', accessCode: '12345678' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /Serial/);
  });

  it('refuses printers outside the local network (SSRF)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/printers',
      headers: { ...json, cookie },
      payload: { name: 'x', model: 'X1C', serial: '00M09C450700001', ip: '8.8.8.8', accessCode: '12345678' },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /not a local network address/);
  });

  it('locks an account after repeated failures', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: json,
        payload: { username: 'victim', password: 'wrong' },
        remoteAddress: `10.0.0.${i + 1}`, // different IPs: only the account throttle applies
      });
      last = res.statusCode;
    }
    assert.equal(last, 429);
  });

  it('records security events in the audit log', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } });
    const actions = res.json().map((a: any) => `${a.action}:${a.outcome}`);
    assert.ok(actions.includes('auth.setup:success'));
    assert.ok(actions.includes('auth.login:failure'));
    assert.ok(actions.includes('auth.login:blocked'));
  });

  it('lists and logs out sessions', async () => {
    const sessions = await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: { cookie } });
    assert.equal(sessions.json().length, 1);
    assert.equal(sessions.json()[0].current, true);

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-requested-with': 'test' } });
    assert.equal(out.statusCode, 200);
    const after = await app.inject({ method: 'GET', url: '/api/printers', headers: { cookie } });
    assert.equal(after.statusCode, 401);
  });

  it('returns 404 JSON for unknown API routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    assert.equal(res.statusCode, 404);
  });
});
