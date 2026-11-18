import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR ?? './data'),
  /** ffmpeg is only needed for RTSPS cameras (X1 / H2 / P2S series). */
  ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
  /** Set to true when served over HTTPS (e.g. behind a reverse proxy). */
  cookieSecure: env.COOKIE_SECURE === 'true',
  sessionTtlMs: Number(env.SESSION_TTL_DAYS ?? 30) * 24 * 60 * 60 * 1000,
  /** Static frontend build. */
  webDist: path.resolve(import.meta.dirname, '../web/dist'),
};
