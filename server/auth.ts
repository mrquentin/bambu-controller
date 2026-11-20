import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.ts';
import type { SessionInfo, SessionUser, UserInfo } from '../shared/api.ts';
import { ACCOUNT } from '../shared/forms.ts';
import { db, type UserRow } from './db.ts';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = 'bc_session';
/** Public session ids: the first hex characters of the token hash. */
export const SESSION_ID_LENGTH = 16;

// ---------------------------------------------------------------- passwords

function scrypt(password: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected);
}

/** Used to keep login timing similar whether or not the user exists. */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash() {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890', 'qwerty123',
  'qwertyuiop', 'iloveyou', 'admin123', 'administrator', 'letmein123', 'welcome1', 'welcome123', 'changeme',
  'bambulab', 'bambulab1', 'printer123', '11111111', '00000000', 'abc12345', 'football', 'baseball',
]);

/**
 * At least 10 characters with 3 of 4 character classes (lower, upper, digit,
 * symbol) — or a passphrase of 16+ characters. Common passwords and passwords
 * containing the username are rejected. Returns an error message or null.
 */
export function passwordProblem(password: string, username: string): string | null {
  const { minLength, maxLength } = ACCOUNT.password;
  if (password.length > maxLength) return `Password is too long (max ${maxLength} characters)`;
  if (password.length < minLength) return `Password must be at least ${minLength} characters`;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (password.length < 16 && classes < 3) {
    return 'Use at least 3 of: lowercase, uppercase, digits, symbols — or a passphrase of 16+ characters';
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'That password is too common';
  if (username && lower.includes(username.toLowerCase())) return 'Password must not contain the username';
  return null;
}

// ---------------------------------------------------------------- sessions

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function createSession(userId: number, request: FastifyRequest): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    sha256(token),
    userId,
    now + config.sessionTtlMs,
    now,
    now,
    request.ip,
    String(request.headers['user-agent'] ?? '').slice(0, 200) || null,
  );
  return token;
}

export function deleteSession(token: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function deleteUserSessions(userId: number, exceptToken?: string) {
  if (exceptToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(exceptToken));
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

/**
 * Sessions expire after SESSION_TTL_DAYS (absolute) or SESSION_IDLE_HOURS
 * without activity, whichever comes first.
 */
export function userFromToken(token: string | undefined): SessionUser | null {
  if (!token || token.length > 100) return null;
  const hash = sha256(token);
  const row = db
    .prepare(
      'SELECT u.id, u.username, s.expires_at, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    )
    .get(hash) as { id: number; username: string; expires_at: number; last_seen_at: number } | undefined;
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now || (row.last_seen_at && now - row.last_seen_at > config.sessionIdleMs)) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  if (now - row.last_seen_at > 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, hash);
  }
  return { id: row.id, username: row.username };
}

export function listSessions(userId: number, currentToken: string | undefined): SessionInfo[] {
  const current = currentToken ? sha256(currentToken) : '';
  return (
    db
      .prepare(
        'SELECT token_hash, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC',
      )
      .all(userId) as { token_hash: string; created_at: number; last_seen_at: number; ip: string | null; user_agent: string | null }[]
  ).map((s) => ({
    id: s.token_hash.slice(0, SESSION_ID_LENGTH),
    createdAt: s.created_at,
    lastSeenAt: s.last_seen_at,
    ip: s.ip,
    userAgent: s.user_agent,
    current: s.token_hash === current,
  }));
}

export function revokeSession(userId: number, id: string) {
  const result = db
    .prepare(`DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, ${SESSION_ID_LENGTH}) = ?`)
    .run(userId, id);
  return Number(result.changes) > 0;
}

export function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR (last_seen_at > 0 AND last_seen_at < ?)').run(
    Date.now(),
    Date.now() - config.sessionIdleMs,
  );
}

// ---------------------------------------------------------------- accounts (every account is an administrator)

export function userCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

export function findUser(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

export function getUser(id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function listUsers(): UserInfo[] {
  return db.prepare('SELECT id, username, created_at FROM users ORDER BY username').all() as unknown as UserInfo[];
}

export async function createUser(username: string, password: string) {
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(
    username,
    await hashPassword(password),
    Date.now(),
  );
}

/** The first-run account: returns its id, or null when an account already exists. */
export async function createFirstUser(username: string, password: string): Promise<number | null> {
  const hash = await hashPassword(password);
  // The conditional INSERT makes concurrent first-run setups safe.
  const result = db
    .prepare('INSERT INTO users (username, password_hash, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)')
    .run(username, hash, Date.now());
  return Number(result.changes) ? Number(result.lastInsertRowid) : null;
}

export async function setPassword(userId: number, password: string) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), userId);
}

/** Its sessions go with it (foreign key cascade). */
export function deleteUser(id: number) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

// ---------------------------------------------------------------- brute force

/**
 * Two independent throttles (in memory):
 *  - per IP: 5 failures -> 30 s lockout, doubling up to 15 min
 *  - per account name: 5 failures -> 15 min lockout (tracked for unknown names
 *    too, so lockouts don't reveal which accounts exist)
 */
const ipFailures = new Map<string, { count: number; blockedUntil: number; last: number }>();
const accountFailures = new Map<string, { count: number; blockedUntil: number; last: number }>();
const ACCOUNT_LOCK_MS = 15 * 60_000;

export function loginBlockedFor(ip: string, username: string): number {
  const now = Date.now();
  const a = ipFailures.get(ip)?.blockedUntil ?? 0;
  const b = accountFailures.get(username.toLowerCase())?.blockedUntil ?? 0;
  return Math.max(0, a - now, b - now);
}

/** Returns true when this failure triggered a new lockout. */
export function recordLoginFailure(ip: string, username: string): boolean {
  const now = Date.now();
  const ipEntry = ipFailures.get(ip) ?? { count: 0, blockedUntil: 0, last: now };
  ipEntry.count += 1;
  ipEntry.last = now;
  let locked = false;
  if (ipEntry.count >= 5) {
    ipEntry.blockedUntil = now + Math.min(15 * 60_000, 30_000 * 2 ** (ipEntry.count - 5));
    locked = true;
  }
  ipFailures.set(ip, ipEntry);

  const name = username.toLowerCase();
  const acct = accountFailures.get(name) ?? { count: 0, blockedUntil: 0, last: now };
  if (now - acct.last > ACCOUNT_LOCK_MS) acct.count = 0;
  acct.count += 1;
  acct.last = now;
  if (acct.count >= 5) {
    acct.blockedUntil = now + ACCOUNT_LOCK_MS;
    acct.count = 0;
    locked = true;
  }
  accountFailures.set(name, acct);
  return locked;
}

export function clearLoginFailures(ip: string, username: string) {
  ipFailures.delete(ip);
  accountFailures.delete(username.toLowerCase());
}

/** Drop stale throttle entries so the maps can't grow without bound. */
export function pruneLoginFailures() {
  const cutoff = Date.now() - ACCOUNT_LOCK_MS;
  for (const map of [ipFailures, accountFailures]) {
    for (const [key, e] of map) if (e.last < cutoff && e.blockedUntil < Date.now()) map.delete(key);
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) {
    return reply.code(401).send({ error: 'Not authenticated' });
  }
}
