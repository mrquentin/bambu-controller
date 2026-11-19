import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { db } from './db.ts';

/**
 * Security audit trail: who did what, from where. Stored in SQLite (viewable
 * in Settings) and mirrored to the structured log for external monitoring.
 */
export interface AuditEntry {
  action: string;
  outcome?: 'success' | 'failure' | 'blocked';
  detail?: Record<string, unknown>;
  /** Override the actor (e.g. a failed login has no session user). */
  username?: string | null;
}

const RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS?.trim() || 90);
let logger: FastifyBaseLogger | null = null;

export function setAuditLogger(log: FastifyBaseLogger) {
  logger = log;
}

export function audit(request: FastifyRequest | null, entry: AuditEntry) {
  const user = request?.user ?? null;
  const row = {
    at: Date.now(),
    user_id: user?.id ?? null,
    username: entry.username !== undefined ? entry.username : (user?.username ?? null),
    ip: request?.ip ?? null,
    action: entry.action,
    outcome: entry.outcome ?? 'success',
    detail: entry.detail ? JSON.stringify(entry.detail) : null,
  };
  db.prepare(
    'INSERT INTO audit_log (at, user_id, username, ip, action, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.at, row.user_id, row.username, row.ip, row.action, row.outcome, row.detail);
  const level = row.outcome === 'success' ? 'info' : 'warn';
  logger?.[level]({ audit: { ...row, detail: entry.detail } }, `audit: ${row.action} (${row.outcome})`);
}

export function recentAudit(limit = 200) {
  return db
    .prepare('SELECT id, at, username, ip, action, outcome, detail FROM audit_log ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r: any) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

export function pruneAudit() {
  db.prepare('DELETE FROM audit_log WHERE at < ?').run(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
}
