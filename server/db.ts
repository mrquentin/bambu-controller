import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';
import { MigrationError, migrate } from './migrations.ts';

// Owner-only permissions for the data directory and files (no-op on Windows).
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
assertWritable(config.dataDir);
const dbPath = path.join(config.dataDir, 'bambu-controller.db');

/**
 * Fail fast with an actionable message when the data directory isn't writable
 * (typically a host folder created by Docker as root while the container runs
 * as an unprivileged user), instead of SQLite's "unable to open database file".
 */
function assertWritable(dir: string) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    const uid = process.getuid?.() ?? '?';
    const gid = process.getgid?.() ?? '?';
    console.error(
      [
        `Data directory "${dir}" is not writable by this process (uid ${uid}, gid ${gid}).`,
        'Give that user ownership of the host folder mapped to it, for example:',
        `  chown -R ${uid}:${gid} /path/to/host/folder`,
        'On Unraid (container runs as nobody:users): chown -R 99:100 /mnt/user/appdata/bambu-controller',
      ].join('\n'),
    );
    process.exit(1);
  }
}

export const db = new DatabaseSync(dbPath);
try {
  fs.chmodSync(dbPath, 0o600);
} catch {}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA secure_delete = ON;
`);

// The whole schema lives in migrations.ts (single source of truth). A failed
// or impossible migration is not something the app can work around: report it
// and stop before anything touches the database.
try {
  // Runs before Fastify's logger exists; plain stdout, unless logging is off.
  const quiet = process.env.LOG_LEVEL?.trim() === 'silent';
  migrate(db, { dbPath, log: quiet ? undefined : (message) => console.log(message) });
} catch (err) {
  if (!(err instanceof MigrationError)) throw err;
  console.error(err.message);
  process.exit(1);
}

export type CameraSetting = 'auto' | 'jpeg' | 'rtsps' | 'none';

/** Printer as used in memory: `access_code` is always the decrypted value. */
export interface PrinterRow {
  id: number;
  name: string;
  model: string;
  serial: string;
  ip: string;
  access_code: string;
  camera: CameraSetting;
  /** 1 = verify the printer's TLS certificate against the Bambu CA (CN = serial). */
  tls_verify: number;
  created_at: number;
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
}
