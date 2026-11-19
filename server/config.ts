import path from 'node:path';

const env = process.env;

/**
 * Environment helpers. Empty values count as "not set": container UIs such as
 * Unraid pass every template variable, including blank ones, and Number('')
 * would otherwise silently become 0 (random port, instantly expiring sessions).
 */
function str(name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
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

const tlsCertFile = env.TLS_CERT_FILE?.trim() || null;
const tlsKeyFile = env.TLS_KEY_FILE?.trim() || null;

export const config = {
  port: num('PORT', 8080, 1),
  host: str('HOST', '0.0.0.0'),
  dataDir: path.resolve(str('DATA_DIR', './data')),
  /** ffmpeg is only needed for RTSPS cameras (X1 / H2 / P2S series). */
  ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
  /** Optional built-in HTTPS (otherwise terminate TLS at a reverse proxy). */
  tlsCertFile,
  tlsKeyFile,
  /** Secure cookies + HSTS: on with built-in HTTPS, or set COOKIE_SECURE=true behind an HTTPS proxy. */
  cookieSecure: bool('COOKIE_SECURE') || Boolean(tlsCertFile && tlsKeyFile),
  /** Absolute session lifetime. */
  sessionTtlMs: num('SESSION_TTL_DAYS', 30, 1) * 24 * 60 * 60 * 1000,
  /** Sessions unused for this long are signed out. */
  sessionIdleMs: num('SESSION_IDLE_HOURS', 72, 1) * 60 * 60 * 1000,
  /** Requests per minute per IP for the whole API (camera/SSE streams count once). */
  rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 600, 1),
  /** Static frontend build. */
  webDist: path.resolve(import.meta.dirname, '../web/dist'),
};
