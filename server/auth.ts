import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.ts';
import { db, type UserRow } from './db.ts';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = 'bc_session';

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

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    Date.now() + config.sessionTtlMs,
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

export interface SessionUser {
  id: number;
  username: string;
}

export function userFromToken(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const row = db
    .prepare(
      'SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    )
    .get(sha256(token)) as { id: number; username: string; expires_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    deleteSession(token);
    return null;
  }
  return { id: row.id, username: row.username };
}

export function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

export function userCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

export function findUser(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
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

/** Simple in-memory brute-force protection for the login endpoint. */
const failures = new Map<string, { count: number; blockedUntil: number }>();

export function loginBlockedFor(ip: string): number {
  const entry = failures.get(ip);
  if (!entry) return 0;
  return Math.max(0, entry.blockedUntil - Date.now());
}

export function recordLoginFailure(ip: string) {
  const entry = failures.get(ip) ?? { count: 0, blockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= 5) {
    // 5 failures -> 30s lockout, doubling each time, capped at 15 minutes.
    entry.blockedUntil = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (entry.count - 5));
  }
  failures.set(ip, entry);
}

export function clearLoginFailures(ip: string) {
  failures.delete(ip);
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user) {
    return reply.code(401).send({ error: 'Not authenticated' });
  }
}
