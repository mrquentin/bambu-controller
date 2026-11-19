import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

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

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS printers (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    model       TEXT    NOT NULL,
    serial      TEXT    NOT NULL UNIQUE,
    ip          TEXT    NOT NULL,
    access_code TEXT    NOT NULL,
    camera      TEXT    NOT NULL DEFAULT 'auto',
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id       INTEGER PRIMARY KEY,
    at       INTEGER NOT NULL,
    user_id  INTEGER,
    username TEXT,
    ip       TEXT,
    action   TEXT    NOT NULL,
    outcome  TEXT    NOT NULL DEFAULT 'success',
    detail   TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);
`);

/** Additive migrations for databases created by earlier versions. */
function addColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('printers', 'tls_verify', 'INTEGER NOT NULL DEFAULT 1');
addColumn('sessions', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sessions', 'last_seen_at', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sessions', 'ip', 'TEXT');
addColumn('sessions', 'user_agent', 'TEXT');

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
