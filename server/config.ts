import fs from 'node:fs';
import path from 'node:path';

const env = process.env;

/**
 * Every environment variable is read here. Empty values count as "not set":
 * container UIs such as Unraid pass every template variable, including blank
 * ones, and Number('') would otherwise silently become 0 (random port,
 * instantly expiring sessions).
 */
function str(name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function optional(name: string): string | null {
  return env[name]?.trim() || null;
}

/** Used as is (not trimmed): it derives an encryption key. */
function secret(name: string, minLength: number): string | null {
  const value = env[name]?.trim() ? env[name]! : null;
  if (value !== null && value.length < minLength) throw new Error(`${name} must be at least ${minLength} characters`);
  return value;
}

function num(name: string, fallback: number, min = 0): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`Invalid ${name}="${value}" (expected a number >= ${min})`);
  }
  return parsed;
}

function bool(name: string): boolean {
  return env[name]?.trim().toLowerCase() === 'true';
}

function packageVersion(): string {
  try {
    return String(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')).version);
  } catch {
    return 'dev';
  }
}

const tlsCertFile = optional('TLS_CERT_FILE');
const tlsKeyFile = optional('TLS_KEY_FILE');

export const config = {
  port: num('PORT', 8080, 1),
  host: str('HOST', '0.0.0.0'),
  dataDir: path.resolve(str('DATA_DIR', './data')),
  /** Release version: CI injects APP_VERSION (from semantic-release) into the Docker image. */
  version: str('APP_VERSION', '') || packageVersion(),
  logLevel: str('LOG_LEVEL', 'info'),
  /** Encryption key material for stored secrets; null = generate data/secret.key. */
  appSecret: secret('APP_SECRET', 16),
  /** ffmpeg is only needed for RTSPS cameras (X1 / H2 / P2S series). */
  ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
  /** Optional built-in HTTPS (otherwise terminate TLS at a reverse proxy). */
  tlsCertFile,
  tlsKeyFile,
  trustProxy: bool('TRUST_PROXY'),
  /** Secure cookies + HSTS: on with built-in HTTPS, or set COOKIE_SECURE=true behind an HTTPS proxy. */
  cookieSecure: bool('COOKIE_SECURE') || Boolean(tlsCertFile && tlsKeyFile),
  /** Absolute session lifetime. */
  sessionTtlMs: num('SESSION_TTL_DAYS', 30, 1) * 24 * 60 * 60 * 1000,
  /** Sessions unused for this long are signed out. */
  sessionIdleMs: num('SESSION_IDLE_HOURS', 72, 1) * 60 * 60 * 1000,
  auditRetentionMs: num('AUDIT_RETENTION_DAYS', 90, 1) * 24 * 60 * 60 * 1000,
  /** Requests per minute per IP for the whole API (camera/SSE streams count once). */
  rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 600, 1),
  /** Lift the LAN-only restriction on printer addresses (e.g. printers reached through a routed VPN). */
  allowPublicPrinterHosts: bool('ALLOW_PUBLIC_PRINTER_HOSTS'),
  /** Extra CA trusted for printer certificates (models signed by another CA). */
  printerExtraCaFile: optional('PRINTER_EXTRA_CA_FILE'),
  /**
   * VAPID "sub" claim: a contact for browser push services (RFC 8292). Apple
   * rejects mailto:…@localhost, so default to the project's URL.
   */
  vapidSubject: str('VAPID_SUBJECT', 'https://github.com/mrquentin/bambu-controller'),
  /** Static frontend build. */
  webDist: path.resolve(import.meta.dirname, '../web/dist'),
};
