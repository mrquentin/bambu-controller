import path from 'node:path';

const env = process.env;

const tlsCertFile = env.TLS_CERT_FILE || null;
const tlsKeyFile = env.TLS_KEY_FILE || null;

export const config = {
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  /** ffmpeg is only needed for RTSPS cameras (X1 / H2 / P2S series). */
  ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
  /** Optional built-in HTTPS (otherwise terminate TLS at a reverse proxy). */
  tlsCertFile,
  tlsKeyFile,
  /** Secure cookies + HSTS: on with built-in HTTPS, or set COOKIE_SECURE=true behind an HTTPS proxy. */
  cookieSecure: env.COOKIE_SECURE === 'true' || Boolean(tlsCertFile && tlsKeyFile),
  /** Absolute session lifetime. */
  sessionTtlMs: Number(env.SESSION_TTL_DAYS ?? 30) * 24 * 60 * 60 * 1000,
  /** Sessions unused for this long are signed out. */
  sessionIdleMs: Number(env.SESSION_IDLE_HOURS ?? 72) * 60 * 60 * 1000,
  /** Requests per minute per IP for the whole API (camera/SSE streams count once). */
  rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 600),
  /** Static frontend build. */
  webDist: path.resolve(import.meta.dirname, '../web/dist'),
};
