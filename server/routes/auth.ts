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
import { idParams, type IdParams } from '../validation.ts';

interface Credentials {
  username: string;
  password: string;
}

const USERNAME_RULE = 'Username must be 3–32 characters (letters, digits, . _ - @)';
const PASSWORD_MESSAGES = { maxLength: 'Password is too long (max 256 characters)', type: 'Password must be a string' };

/** New accounts (setup, user creation); `validCredentials` applies the format and password policy. */
const newCredentialsBody = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', maxLength: 32, errorMessage: USERNAME_RULE },
    password: { type: 'string', maxLength: 256, errorMessage: PASSWORD_MESSAGES },
  },
};

/** Login: any malformed input gets the same message as a wrong password (no hint about the account). */
const loginBody = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', maxLength: 64, errorMessage: 'Invalid username or password' },
    password: { type: 'string', maxLength: 256, errorMessage: 'Invalid username or password' },
  },
};

const passwordChangeBody = {
  type: 'object',
  required: ['current', 'next'],
  additionalProperties: false,
  properties: {
    current: { type: 'string', maxLength: 256, errorMessage: 'Current password is incorrect' },
    next: { type: 'string', maxLength: 256, errorMessage: PASSWORD_MESSAGES },
  },
};

/** Public session ids are the first 16 hex characters of the token hash. */
const sessionParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[a-f0-9]{16}$', errorMessage: 'Session not found' } },
};

/** Strict limits for endpoints that accept credentials. */
const credentialLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

function validCredentials(body: Credentials): { username: string; password: string } | string {
  const username = body.username.trim();
  const password = body.password;
  if (!/^[\w.@-]{3,32}$/.test(username)) return USERNAME_RULE;
  return passwordProblem(password, username) ?? { username, password };
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/state', async (request) => ({
    setupRequired: userCount() === 0,
    user: request.user,
  }));

  // First run: create the initial account. Only allowed while no users exist;
  // the conditional INSERT makes concurrent setup requests safe.
  app.post<{ Body: Credentials }>('/api/auth/setup', { config: credentialLimit, schema: { body: newCredentialsBody } }, async (request, reply) => {
    if (userCount() > 0) return reply.code(409).send({ error: 'Setup already completed' });
    const creds = validCredentials(request.body);
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

  app.post<{ Body: Credentials }>('/api/auth/login', { config: credentialLimit, schema: { body: loginBody } }, async (request, reply) => {
    const username = request.body.username.trim();
    const password = request.body.password;
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

  app.post<{ Body: { current: string; next: string } }>(
    '/api/auth/password',
    { preValidation: requireAuth, config: credentialLimit, schema: { body: passwordChangeBody } },
    async (request, reply) => {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(request.user!.id) as unknown as UserRow;
      const { current, next } = request.body;
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

  app.get('/api/auth/sessions', { preValidation: requireAuth }, async (request) =>
    listSessions(request.user!.id, request.cookies[SESSION_COOKIE]),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/auth/sessions/:id',
    { preValidation: requireAuth, schema: { params: sessionParams } },
    async (request, reply) => {
      if (!revokeSession(request.user!.id, request.params.id)) return reply.code(404).send({ error: 'Session not found' });
      audit(request, { action: 'auth.session_revoke' });
      return { ok: true };
    },
  );

  app.post('/api/auth/sessions/revoke-others', { preValidation: requireAuth }, async (request) => {
    deleteUserSessions(request.user!.id, request.cookies[SESSION_COOKIE]);
    audit(request, { action: 'auth.session_revoke_others' });
    return { ok: true };
  });

  // --- user management (every account is an administrator) ---

  app.get('/api/users', { preValidation: requireAuth }, async () =>
    db.prepare('SELECT id, username, created_at FROM users ORDER BY username').all(),
  );

  app.post<{ Body: Credentials }>(
    '/api/users',
    { preValidation: requireAuth, config: credentialLimit, schema: { body: newCredentialsBody } },
    async (request, reply) => {
      const creds = validCredentials(request.body);
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

  app.delete<{ Params: IdParams }>('/api/users/:id', { preValidation: requireAuth, schema: { params: idParams } }, async (request, reply) => {
    const id = Number(request.params.id);
    if (id === request.user!.id) return reply.code(400).send({ error: "You can't delete your own account" });
    const target = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined;
    if (!target) return reply.code(404).send({ error: 'User not found' });
    db.prepare('DELETE FROM users WHERE id = ?').run(id); // sessions cascade
    audit(request, { action: 'user.delete', detail: { target: target.username } });
    return { ok: true };
  });

  // --- security audit log ---

  app.get('/api/audit', { preValidation: requireAuth }, async () => recentAudit(300));
}
