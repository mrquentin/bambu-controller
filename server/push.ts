import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { JobSnapshot, PrinterEvent } from './bambu/job-events.ts';
import { config } from './config.ts';
import { db } from './db.ts';
import { checkPushEndpoint } from './net-policy.ts';
import { decrypt, encrypt } from './secrets.ts';
import {
  encryptPayload,
  fromB64url,
  generateVapidJwk,
  isP256PublicKey,
  vapidAuthorization,
  vapidKeysFromJwk,
  type VapidKeys,
} from './webpush.ts';

/**
 * Browser push notifications for print-job events. Every subscribed device
 * (browser or installed PWA) gets the events it opted into; the payload is
 * end-to-end encrypted for the browser and relayed by its vendor's push
 * service (FCM, Mozilla autopush, Apple, WNS), so the server needs outbound
 * HTTPS to that service.
 */

export const PUSH_EVENTS = ['started', 'finished', 'failed', 'paused', 'hms'] as const;
export type PushEventKind = (typeof PUSH_EVENTS)[number];
export type PushPreferences = Record<PushEventKind, boolean>;

/** Per-user cap on subscribed devices. */
export const MAX_SUBSCRIPTIONS_PER_USER = 20;
/** The same HMS alert on the same printer is notified at most once per window. */
const HMS_REPEAT_MS = 30 * 60_000;

interface PushSubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  on_started: number;
  on_finished: number;
  on_failed: number;
  on_paused: number;
  on_hms: number;
  created_at: number;
  last_success_at: number | null;
}

export interface PushMessage {
  kind: PushEventKind | 'test';
  title: string;
  body: string;
  /** Notification tag: a newer notification with the same tag replaces the old one. */
  tag: string;
  url: string;
  urgency: 'normal' | 'high';
  /** Push-service collapse key: an undelivered message is replaced by a newer one. */
  topic?: string;
  /** Seconds the push service keeps an undelivered message. */
  ttl: number;
}

export type DeliveryResult = 'sent' | 'gone' | 'failed';

let log: FastifyBaseLogger | null = null;

export function setPushLogger(logger: FastifyBaseLogger) {
  log = logger;
}

// ---------------------------------------------------------------- VAPID keys

let vapidKeys: VapidKeys | null = null;

/**
 * The VAPID key pair is generated on first use and stored in the data
 * directory, encrypted with the app secret (owner-only permissions). If it
 * can't be decrypted any more (APP_SECRET changed) a new pair is generated;
 * existing subscriptions are bound to the old key and are dropped.
 */
export function getVapidKeys(): VapidKeys {
  if (vapidKeys) return vapidKeys;
  const file = path.join(config.dataDir, 'vapid.key');
  // Read directly instead of checking existence first (no check-then-use race).
  let stored: string | null = null;
  try {
    stored = fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (stored !== null) {
    try {
      vapidKeys = vapidKeysFromJwk(JSON.parse(decrypt(stored)));
      return vapidKeys;
    } catch {
      log?.warn('Push: vapid.key is unreadable (APP_SECRET changed?); generating a new key. Devices must re-enable notifications.');
      db.prepare('DELETE FROM push_subscriptions').run();
      fs.rmSync(file, { force: true });
    }
  }
  const jwk = generateVapidJwk();
  fs.writeFileSync(file, encrypt(JSON.stringify(jwk)), { mode: 0o600, flag: 'wx' });
  vapidKeys = vapidKeysFromJwk(jwk);
  return vapidKeys;
}

// ---------------------------------------------------------------- subscriptions

const column = (kind: PushEventKind) => `on_${kind}` as const;

function preferencesOf(row: PushSubscriptionRow): PushPreferences {
  return Object.fromEntries(PUSH_EVENTS.map((k) => [k, row[column(k)] === 1])) as PushPreferences;
}

/** Hash of the endpoint so the browser can recognize its own subscription without the server echoing the URL. */
export const endpointFingerprint = (endpoint: string) => crypto.createHash('sha256').update(endpoint).digest('hex');

function publicView(row: PushSubscriptionRow) {
  return {
    id: row.id,
    fingerprint: endpointFingerprint(row.endpoint),
    service: new URL(row.endpoint).hostname,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
    preferences: preferencesOf(row),
  };
}
export type PublicSubscription = ReturnType<typeof publicView>;

export interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Validate a browser `PushSubscription.toJSON()`; returns an error message or the input. */
export async function parseSubscription(body: any): Promise<SubscriptionInput | string> {
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
  const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : '';
  const auth = typeof body?.keys?.auth === 'string' ? body.keys.auth : '';
  if (!endpoint || !p256dh || !auth) return 'Invalid push subscription';
  if (!/^[\w-]{80,100}$/.test(p256dh) || !isP256PublicKey(fromB64url(p256dh))) return 'Invalid push subscription key';
  if (!/^[\w-]{16,30}$/.test(auth) || fromB64url(auth).length !== 16) return 'Invalid push subscription secret';
  const problem = await checkPushEndpoint(endpoint);
  return problem ?? { endpoint, p256dh, auth };
}

export function parsePreferences(body: any): Partial<PushPreferences> | string {
  if (typeof body !== 'object' || body === null) return 'Invalid preferences';
  const prefs: Partial<PushPreferences> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(PUSH_EVENTS as readonly string[]).includes(key) || typeof value !== 'boolean') return `Invalid preference "${key}"`;
    prefs[key as PushEventKind] = value;
  }
  return prefs;
}

export function listSubscriptions(userId: number): PublicSubscription[] {
  return (
    db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as PushSubscriptionRow[]
  ).map(publicView);
}

function ownSubscription(userId: number, id: number) {
  return db.prepare('SELECT * FROM push_subscriptions WHERE id = ? AND user_id = ?').get(id, userId) as unknown as
    | PushSubscriptionRow
    | undefined;
}

/**
 * Create or refresh the subscription for `endpoint`, bound to `userId`.
 * `replaces` is the previous endpoint of the same device when the browser
 * rotated its subscription: its preferences carry over and the old row goes.
 */
export function saveSubscription(
  userId: number,
  input: SubscriptionInput,
  userAgent: string | null,
  replaces?: string,
): PublicSubscription | string {
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(input.endpoint);
  const old = replaces
    ? (db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').get(replaces, userId) as unknown as
        | PushSubscriptionRow
        | undefined)
    : undefined;
  const count = (db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId) as { n: number }).n;
  if (!existing && !old && count >= MAX_SUBSCRIPTIONS_PER_USER) {
    return `At most ${MAX_SUBSCRIPTIONS_PER_USER} devices per user; remove one first`;
  }
  const ua = userAgent ? userAgent.slice(0, 300) : null;
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
    ).run(userId, input.endpoint, input.p256dh, input.auth, ua, Date.now());
    if (old && old.endpoint !== input.endpoint) {
      setPreferencesWhere('endpoint = ?', [input.endpoint], preferencesOf(old));
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(old.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const row = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(input.endpoint) as unknown as PushSubscriptionRow;
  return publicView(row);
}

function setPreferencesWhere(where: string, params: (string | number)[], prefs: Partial<PushPreferences>) {
  const entries = Object.entries(prefs) as [PushEventKind, boolean][];
  if (!entries.length) return;
  // Column names come from the fixed PUSH_EVENTS list, never from input.
  const sets = entries.map(([k]) => `${column(k)} = ?`).join(', ');
  db.prepare(`UPDATE push_subscriptions SET ${sets} WHERE ${where}`).run(...entries.map(([, v]) => (v ? 1 : 0)), ...params);
}

export function updatePreferences(userId: number, id: number, prefs: Partial<PushPreferences>): PublicSubscription | null {
  if (!ownSubscription(userId, id)) return null;
  setPreferencesWhere('id = ?', [id], prefs);
  return publicView(ownSubscription(userId, id)!);
}

/** Returns the deleted subscription (for the audit log), or null when it isn't the user's. */
export function deleteSubscription(userId: number, id: number): PublicSubscription | null {
  const row = ownSubscription(userId, id);
  if (!row) return null;
  db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
  return publicView(row);
}

export function subscriptionsFor(kind: PushEventKind): PushSubscriptionRow[] {
  return db.prepare(`SELECT * FROM push_subscriptions WHERE ${column(kind)} = 1`).all() as unknown as PushSubscriptionRow[];
}

// ---------------------------------------------------------------- delivery

const hostOf = (endpoint: string) => {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '?';
  }
};

/**
 * Encrypt and POST one message. Never throws. Subscriptions the push service
 * reports as gone (404/410) are deleted. Logs carry only the service host:
 * the endpoint URL itself is a bearer capability.
 */
export async function deliver(row: PushSubscriptionRow, message: PushMessage): Promise<DeliveryResult> {
  const host = hostOf(row.endpoint);
  try {
    // Checked again at send time: DNS may have changed since the subscription was stored.
    const problem = await checkPushEndpoint(row.endpoint);
    if (problem) {
      log?.warn({ push: { host, subscription: row.id } }, `push refused: ${problem}`);
      return 'failed';
    }
    const payload = JSON.stringify({ title: message.title, body: message.body, tag: message.tag, url: message.url, at: Date.now() });
    const body = encryptPayload(Buffer.from(payload), fromB64url(row.p256dh), fromB64url(row.auth));
    const res = await fetch(row.endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: vapidAuthorization(row.endpoint, getVapidKeys(), config.vapidSubject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(message.ttl),
        Urgency: message.urgency,
        ...(message.topic ? { Topic: message.topic } : {}),
      },
      body: new Uint8Array(body),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) {
      db.prepare('UPDATE push_subscriptions SET last_success_at = ? WHERE id = ?').run(Date.now(), row.id);
      return 'sent';
    }
    if (res.status === 404 || res.status === 410) {
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
      log?.info({ push: { host, subscription: row.id, status: res.status } }, 'push subscription expired, removed');
      return 'gone';
    }
    log?.warn({ push: { host, subscription: row.id, status: res.status } }, 'push delivery failed');
    return 'failed';
  } catch (err) {
    log?.warn({ push: { host, subscription: row.id, error: (err as Error).message } }, 'push delivery failed');
    return 'failed';
  }
}

export async function sendTest(userId: number, id: number): Promise<DeliveryResult | null> {
  const row = ownSubscription(userId, id);
  if (!row) return null;
  return deliver(row, {
    kind: 'test',
    title: 'Bambu Controller',
    body: 'Test notification: notifications work on this device.',
    tag: 'test',
    url: '/#/settings',
    urgency: 'normal',
    ttl: 300,
  });
}

// ---------------------------------------------------------------- printer events

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
const errorCode = (n: number) => `${hex4((n >>> 16) & 0xffff)}_${hex4(n & 0xffff)}`;
export const hmsCode = (attr: number, code: number) => `HMS_${errorCode(attr >>> 0)}_${errorCode(code >>> 0)}`;
const HMS_SEVERITY: Record<number, string> = { 1: 'Fatal', 2: 'Serious', 3: 'Common', 4: 'Info' };

function duration(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function progress(job: JobSnapshot) {
  const parts = [job.task ? job.task.slice(0, 100) : 'Print job'];
  if (job.percent !== null) parts.push(`${job.percent}%`);
  if (job.layer !== null && job.totalLayers) parts.push(`layer ${job.layer}/${job.totalLayers}`);
  return parts.join(' · ');
}

/** Notification for a printer event, or null when it isn't notified. */
export function messageFor(printer: { id: number; name: string }, event: PrinterEvent): PushMessage | null {
  const name = printer.name.slice(0, 60);
  const base = { url: `/#/printer/${printer.id}`, ttl: 12 * 3600 };
  const make = (kind: PushEventKind, title: string, body: string, urgency: PushMessage['urgency'] = 'normal'): PushMessage => ({
    ...base,
    kind,
    title: `${name}: ${title}`,
    body,
    tag: `printer-${printer.id}-${kind}`,
    // One collapse slot per printer and kind, so e.g. a pending HMS alert is
    // never replaced by a later "finished" while the device is offline.
    topic: `printer-${printer.id}-${kind}`,
    urgency,
  });
  const job = event.job;
  switch (event.type) {
    case 'job_started': {
      if (event.observedMidway) return null;
      const eta = job.remainingMinutes ? ` · ${duration(job.remainingMinutes)} left` : '';
      return make('started', 'print started', `${job.task?.slice(0, 100) ?? 'Print job'}${eta}`);
    }
    case 'job_finished':
      return make('finished', 'print finished', job.task?.slice(0, 100) ?? 'Print job');
    case 'job_failed': {
      const error = event.printError ? ` · error ${errorCode(event.printError)}` : '';
      return make('failed', 'print failed or cancelled', `${progress(job)}${error}`, 'high');
    }
    case 'job_paused': {
      if (event.printError) {
        return make('paused', 'print paused, needs attention', `${progress(job)} · error ${errorCode(event.printError)}`, 'high');
      }
      return make('paused', 'print paused', progress(job));
    }
    case 'hms_raised': {
      const shown = event.alerts.slice(0, 3).map((a) => `${hmsCode(a.attr, a.code)} (${HMS_SEVERITY[(a.code >>> 16) & 0xffff] ?? 'Unknown'})`);
      if (event.alerts.length > 3) shown.push(`+${event.alerts.length - 3} more`);
      return make('hms', event.alerts.length > 1 ? 'health alerts' : 'health alert', shown.join(', '), 'high');
    }
    default:
      return null;
  }
}

const recentHms = new Map<string, number>();

/** Drop HMS alerts already notified for this printer within the repeat window (flapping alerts). */
function freshAlerts(printerId: number, alerts: { attr: number; code: number }[], now: number) {
  for (const [key, at] of recentHms) if (now - at > HMS_REPEAT_MS) recentHms.delete(key);
  return alerts.filter((a) => {
    const key = `${printerId}:${a.attr}:${a.code}`;
    if (recentHms.has(key)) return false;
    recentHms.set(key, now);
    return true;
  });
}

/**
 * Fan a printer event out to every subscription that wants it. Never throws:
 * notifications must not affect the printer connection.
 */
export async function notifyPrinterEvent(printer: { id: number; name: string }, event: PrinterEvent): Promise<void> {
  try {
    if (event.type === 'hms_raised') {
      const alerts = freshAlerts(printer.id, event.alerts, Date.now());
      if (!alerts.length) return;
      event = { ...event, alerts };
    }
    const message = messageFor(printer, event);
    if (!message || message.kind === 'test') return;
    const targets = subscriptionsFor(message.kind);
    await Promise.all(targets.map((row) => deliver(row, message)));
  } catch (err) {
    log?.error({ err }, 'push notification failed');
  }
}
