import type { FastifyInstance } from 'fastify';
import type { AuthState } from '../../shared/api.ts';
import { ACCOUNT } from '../../shared/forms.ts';
import { audit, recentAudit } from '../audit.ts';
import {
  SESSION_COOKIE,
  SESSION_ID_LENGTH,
  clearLoginFailures,
  createSession,
  createFirstUser,
  createUser,
  deleteSession,
  deleteUser,
  deleteUserSessions,
  dummyPasswordHash,
  findUser,
  getUser,
  listSessions,
  listUsers,
  loginBlockedFor,
  passwordProblem,
  recordLoginFailure,
  revokeSession,
  setPassword,
  setSessionCookie,
  userCount,
  verifyPassword,
} from '../auth.ts';
import { HttpError } from '../http-error.ts';
import { idParams, type IdParams } from '../validation.ts';

interface Credentials {
  username: string;
  password: string;
}

const { username: USERNAME, password: PASSWORD } = ACCOUNT;
const USERNAME_RULE = `Username must be ${USERNAME.minLength}–${USERNAME.maxLength} characters (letters, digits, . _ - @)`;
const PASSWORD_MESSAGES = { maxLength: `Password is too long (max ${PASSWORD.maxLength} characters)`, type: 'Password must be a string' };

/** New accounts (setup, user creation); `validCredentials` applies the format and password policy. */
const newCredentialsBody = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', maxLength: USERNAME.maxLength, errorMessage: USERNAME_RULE },
    password: { type: 'string', maxLength: PASSWORD.maxLength, errorMessage: PASSWORD_MESSAGES },
  },
};

/** Login: any malformed input gets the same message as a wrong password (no hint about the account). */
const loginBody = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', maxLength: USERNAME.maxLength, errorMessage: 'Invalid username or password' },
    password: { type: 'string', maxLength: PASSWORD.maxLength, errorMessage: 'Invalid username or password' },
  },
};

const passwordChangeBody = {
  type: 'object',
  required: ['current', 'next'],
  additionalProperties: false,
  properties: {
    current: { type: 'string', maxLength: PASSWORD.maxLength, errorMessage: 'Current password is incorrect' },
    next: { type: 'string', maxLength: PASSWORD.maxLength, errorMessage: PASSWORD_MESSAGES },
  },
};

const sessionParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: `^[a-f0-9]{${SESSION_ID_LENGTH}}$`, errorMessage: 'Session not found' } },
};

/** Strict limits for endpoints that accept credentials. */
const credentialLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

function validCredentials(body: Credentials): Credentials {
  const username = body.username.trim();
  const password = body.password;
  if (!/^[\w.@-]+$/.test(username) || username.length < USERNAME.minLength) {
    throw new HttpError(400, USERNAME_RULE);
  }
  const problem = passwordProblem(password, username);
  if (problem) throw new HttpError(400, problem);
  return { username, password };
}

/** Signing in and out: open to anonymous callers. */
export async function authRoutes(app: FastifyInstance) {
  app.get('/api/auth/state', async (request): Promise<AuthState> => ({
    setupRequired: userCount() === 0,
    user: request.user,
  }));

  app.post<{ Body: Credentials }>('/api/auth/setup', { config: credentialLimit, schema: { body: newCredentialsBody } }, async (request, reply) => {
    if (userCount() > 0) return reply.code(409).send({ error: 'Setup already completed' });
    const creds = validCredentials(request.body);
    const userId = await createFirstUser(creds.username, creds.password);
    if (userId === null) return reply.code(409).send({ error: 'Setup already completed' });
    setSessionCookie(reply, createSession(userId, request));
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
}

/** The signed-in user's password and sessions, user management and the audit log. */
export async function accountRoutes(app: FastifyInstance) {
  app.post<{ Body: { current: string; next: string } }>(
    '/api/auth/password',
    { config: credentialLimit, schema: { body: passwordChangeBody } },
    async (request, reply) => {
      const user = getUser(request.user!.id)!;
      const { current, next } = request.body;
      if (!(await verifyPassword(current, user.password_hash))) {
        audit(request, { action: 'auth.password_change', outcome: 'failure' });
        return reply.code(400).send({ error: 'Current password is incorrect' });
      }
      const problem = passwordProblem(next, user.username);
      if (problem) return reply.code(400).send({ error: problem });
      await setPassword(user.id, next);
      const token = request.cookies[SESSION_COOKIE];
      deleteUserSessions(user.id);
      if (token) setSessionCookie(reply, createSession(user.id, request));
      audit(request, { action: 'auth.password_change' });
      return { ok: true };
    },
  );

  app.get('/api/auth/sessions', async (request) =>
    listSessions(request.user!.id, request.cookies[SESSION_COOKIE]),
  );

  app.delete<{ Params: { id: string } }>(
    '/api/auth/sessions/:id',
    { schema: { params: sessionParams } },
    async (request, reply) => {
      if (!revokeSession(request.user!.id, request.params.id)) return reply.code(404).send({ error: 'Session not found' });
      audit(request, { action: 'auth.session_revoke' });
      return { ok: true };
    },
  );

  app.post('/api/auth/sessions/revoke-others', async (request) => {
    deleteUserSessions(request.user!.id, request.cookies[SESSION_COOKIE]);
    audit(request, { action: 'auth.session_revoke_others' });
    return { ok: true };
  });

  app.get('/api/users', async () => listUsers());

  app.post<{ Body: Credentials }>(
    '/api/users',
    { config: credentialLimit, schema: { body: newCredentialsBody } },
    async (request, reply) => {
      const creds = validCredentials(request.body);
      if (findUser(creds.username)) return reply.code(409).send({ error: 'That username already exists' });
      await createUser(creds.username, creds.password);
      audit(request, { action: 'user.create', detail: { target: creds.username } });
      return { ok: true };
    },
  );

  app.delete<{ Params: IdParams }>('/api/users/:id', { schema: { params: idParams } }, async (request, reply) => {
    const id = Number(request.params.id);
    if (id === request.user!.id) return reply.code(400).send({ error: "You can't delete your own account" });
    const target = getUser(id);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    deleteUser(id);
    audit(request, { action: 'user.delete', detail: { target: target.username } });
    return { ok: true };
  });

  app.get('/api/audit', async () => recentAudit());
}
