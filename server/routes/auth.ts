import type { FastifyInstance } from 'fastify';
import {
  SESSION_COOKIE,
  clearLoginFailures,
  createSession,
  deleteSession,
  deleteUserSessions,
  dummyPasswordHash,
  findUser,
  hashPassword,
  loginBlockedFor,
  recordLoginFailure,
  requireAuth,
  setSessionCookie,
  userCount,
  verifyPassword,
} from '../auth.ts';
import { db, type UserRow } from '../db.ts';

interface Credentials {
  username?: unknown;
  password?: unknown;
}

function validCredentials(body: Credentials): { username: string; password: string } | string {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[\w.@-]{3,32}$/.test(username)) return 'Username must be 3–32 characters (letters, digits, . _ - @)';
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 256) return 'Password is too long';
  return { username, password };
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/state', async (request) => ({
    setupRequired: userCount() === 0,
    user: request.user,
  }));

  // First-run: create the initial account. Only allowed while no users exist.
  app.post<{ Body: Credentials }>('/api/auth/setup', async (request, reply) => {
    if (userCount() > 0) return reply.code(409).send({ error: 'Setup already completed' });
    const creds = validCredentials(request.body ?? {});
    if (typeof creds === 'string') return reply.code(400).send({ error: creds });
    const result = db
      .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(creds.username, await hashPassword(creds.password), Date.now());
    setSessionCookie(reply, createSession(Number(result.lastInsertRowid)));
    return { ok: true };
  });

  app.post<{ Body: Credentials }>('/api/auth/login', async (request, reply) => {
    const blocked = loginBlockedFor(request.ip);
    if (blocked > 0) {
      return reply
        .code(429)
        .send({ error: `Too many failed attempts. Try again in ${Math.ceil(blocked / 1000)}s.` });
    }
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const user = findUser(username);
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !ok) {
      recordLoginFailure(request.ip);
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    clearLoginFailures(request.ip);
    setSessionCookie(reply, createSession(user.id));
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) deleteSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post<{ Body: { current?: unknown; next?: unknown } }>(
    '/api/auth/password',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.user!.id) as unknown as UserRow;
      const current = typeof request.body?.current === 'string' ? request.body.current : '';
      const next = typeof request.body?.next === 'string' ? request.body.next : '';
      if (!(await verifyPassword(current, user.password_hash))) {
        return reply.code(400).send({ error: 'Current password is incorrect' });
      }
      if (next.length < 8 || next.length > 256) {
        return reply.code(400).send({ error: 'New password must be at least 8 characters' });
      }
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), user.id);
      deleteUserSessions(user.id, request.cookies[SESSION_COOKIE]);
      return { ok: true };
    },
  );

  // --- user management (every account is an administrator) ---

  app.get('/api/users', { preHandler: requireAuth }, async () =>
    db.prepare('SELECT id, username, created_at FROM users ORDER BY username').all(),
  );

  app.post<{ Body: Credentials }>('/api/users', { preHandler: requireAuth }, async (request, reply) => {
    const creds = validCredentials(request.body ?? {});
    if (typeof creds === 'string') return reply.code(400).send({ error: creds });
    if (findUser(creds.username)) return reply.code(409).send({ error: 'That username already exists' });
    db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(
      creds.username,
      await hashPassword(creds.password),
      Date.now(),
    );
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', { preHandler: requireAuth }, async (request, reply) => {
    const id = Number(request.params.id);
    if (id === request.user!.id) return reply.code(400).send({ error: "You can't delete your own account" });
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  });
}
