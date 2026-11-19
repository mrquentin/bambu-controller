import type { FastifyInstance } from 'fastify';
import { audit, recentAudit } from '../audit.ts';
import {
  SESSION_COOKIE,
  clearLoginFailures,
  createSession,
  deleteSession,
  deleteUserSessions,
  dummyPasswordHash,
  findUser,
  hashPassword,
  listSessions,
  loginBlockedFor,
  passwordProblem,
  recordLoginFailure,
  requireAuth,
  revokeSession,
  setSessionCookie,
  userCount,
  verifyPassword,
} from '../auth.ts';
import { db, type UserRow } from '../db.ts';

interface Credentials {
  username?: unknown;
  password?: unknown;
}

/** Strict limits for endpoints that accept credentials. */
const credentialLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

function validCredentials(body: Credentials): { username: string; password: string } | string {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[\w.@-]{3,32}$/.test(username)) return 'Username must be 3–32 characters (letters, digits, . _ - @)';
  return passwordProblem(password, username) ?? { username, password };
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/state', async (request) => ({
    setupRequired: userCount() === 0,
    user: request.user,
  }));

  // First run: create the initial account. Only allowed while no users exist;
  // the conditional INSERT makes concurrent setup requests safe.
  app.post<{ Body: Credentials }>('/api/auth/setup', { config: credentialLimit }, async (request, reply) => {
    if (userCount() > 0) return reply.code(409).send({ error: 'Setup already completed' });
    const creds = validCredentials(request.body ?? {});
    if (typeof creds === 'string') return reply.code(400).send({ error: creds });
    const hash = await hashPassword(creds.password);
    const result = db
      .prepare(
        'INSERT INTO users (username, password_hash, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)',
      )
      .run(creds.username, hash, Date.now());
    if (Number(result.changes) === 0) return reply.code(409).send({ error: 'Setup already completed' });
    setSessionCookie(reply, createSession(Number(result.lastInsertRowid), request));
    audit(request, { action: 'auth.setup', username: creds.username });
    return { ok: true };
  });

  app.post<{ Body: Credentials }>('/api/auth/login', { config: credentialLimit }, async (request, reply) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim().slice(0, 64) : '';
    const password = typeof request.body?.password === 'string' ? request.body.password.slice(0, 256) : '';
    const blocked = loginBlockedFor(request.ip, username);
    if (blocked > 0) {
      audit(request, { action: 'auth.login', outcome: 'blocked', username });
      return reply
        .code(429)
        .send({ error: `Too many failed attempts. Try again in ${Math.ceil(blocked / 60_000)} min.` });
    }
    const user = findUser(username);
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !ok) {
      const locked = recordLoginFailure(request.ip, username);
      audit(request, { action: 'auth.login', outcome: 'failure', username, detail: locked ? { lockout: true } : undefined });
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    clearLoginFailures(request.ip, username);
    setSessionCookie(reply, createSession(user.id, request));
    audit(request, { action: 'auth.login', username: user.username });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) deleteSession(token);
    if (request.user) audit(request, { action: 'auth.logout' });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post<{ Body: { current?: unknown; next?: unknown } }>(
    '/api/auth/password',
    { preHandler: requireAuth, config: credentialLimit },
    async (request, reply) => {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.user!.id) as unknown as UserRow;
      const current = typeof request.body?.current === 'string' ? request.body.current : '';
      const next = typeof request.body?.next === 'string' ? request.body.next : '';
      if (!(await verifyPassword(current, user.password_hash))) {
        audit(request, { action: 'auth.password_change', outcome: 'failure' });
        return reply.code(400).send({ error: 'Current password is incorrect' });
      }
      const problem = passwordProblem(next, user.username);
      if (problem) return reply.code(400).send({ error: problem });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), user.id);
      // Sign out everywhere else, and rotate the current session token too.
      const token = request.cookies[SESSION_COOKIE];
      deleteUserSessions(user.id);
      if (token) setSessionCookie(reply, createSession(user.id, request));
      audit(request, { action: 'auth.password_change' });
      return { ok: true };
    },
  );

  // --- sessions of the current user ---

  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (request) =>
    listSessions(request.user!.id, request.cookies[SESSION_COOKIE]),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/auth/sessions/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!revokeSession(request.user!.id, request.params.id)) return reply.code(404).send({ error: 'Session not found' });
      audit(request, { action: 'auth.session_revoke' });
      return { ok: true };
    },
  );

  app.post('/api/auth/sessions/revoke-others', { preHandler: requireAuth }, async (request) => {
    deleteUserSessions(request.user!.id, request.cookies[SESSION_COOKIE]);
    audit(request, { action: 'auth.session_revoke_others' });
    return { ok: true };
  });

  // --- user management (every account is an administrator) ---

  app.get('/api/users', { preHandler: requireAuth }, async () =>
    db.prepare('SELECT id, username, created_at FROM users ORDER BY username').all(),
  );

  app.post<{ Body: Credentials }>(
    '/api/users',
    { preHandler: requireAuth, config: credentialLimit },
    async (request, reply) => {
      const creds = validCredentials(request.body ?? {});
      if (typeof creds === 'string') return reply.code(400).send({ error: creds });
      if (findUser(creds.username)) return reply.code(409).send({ error: 'That username already exists' });
      db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(
        creds.username,
        await hashPassword(creds.password),
        Date.now(),
      );
      audit(request, { action: 'user.create', detail: { target: creds.username } });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/users/:id', { preHandler: requireAuth }, async (request, reply) => {
    const id = Number(request.params.id);
    if (id === request.user!.id) return reply.code(400).send({ error: "You can't delete your own account" });
    const target = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined;
    if (!target) return reply.code(404).send({ error: 'User not found' });
    db.prepare('DELETE FROM users WHERE id = ?').run(id); // sessions cascade
    audit(request, { action: 'user.delete', detail: { target: target.username } });
    return { ok: true };
  });

  // --- security audit log ---

  app.get('/api/audit', { preHandler: requireAuth }, async () => recentAudit(300));
}
