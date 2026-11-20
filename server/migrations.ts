import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Versioned schema migrations, tracked by SQLite's `PRAGMA user_version`
 * (0 on a database that has never been migrated).
 *
 * How to add a migration:
 *   - Append a new entry at the end of `migrations` with the next version
 *     number. Never edit, reorder or remove an entry that has been released:
 *     existing installs have already applied it and will never run it again.
 *   - `up` runs inside a transaction together with the user_version bump, so a
 *     failure leaves the database exactly as it was. Avoid statements SQLite
 *     refuses inside a transaction (VACUUM, PRAGMA foreign_keys/journal_mode).
 *   - Table rebuilds (the "create new, copy, drop, rename" dance) need
 *     foreign_keys checks in mind: dropping a parent table with ON DELETE
 *     CASCADE children deletes their rows.
 *   - Add a test in test/migrations.test.ts that upgrades a database from the
 *     previous version with some rows in it.
 */
export interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    description: 'baseline schema',
    // The baseline must also bring pre-versioning databases (user_version 0,
    // created by releases that used CREATE TABLE IF NOT EXISTS + additive
    // ALTERs) up to date, whatever release created them. That is why, unlike
    // every later migration, it is written to be idempotent: IF NOT EXISTS
    // everywhere and columns added only when missing. On a fresh database the
    // result is identical to what those releases produced.
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id            INTEGER PRIMARY KEY,
          username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT    NOT NULL,
          created_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          token_hash   TEXT    PRIMARY KEY,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at   INTEGER NOT NULL,
          created_at   INTEGER NOT NULL DEFAULT 0,
          last_seen_at INTEGER NOT NULL DEFAULT 0,
          ip           TEXT,
          user_agent   TEXT
        );

        CREATE TABLE IF NOT EXISTS printers (
          id          INTEGER PRIMARY KEY,
          name        TEXT    NOT NULL,
          model       TEXT    NOT NULL,
          serial      TEXT    NOT NULL UNIQUE,
          ip          TEXT    NOT NULL,
          access_code TEXT    NOT NULL,
          camera      TEXT    NOT NULL DEFAULT 'auto',
          created_at  INTEGER NOT NULL,
          tls_verify  INTEGER NOT NULL DEFAULT 1
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

        -- Print history (see history.ts). Jobs outlive their printer: removing a
        -- printer only detaches its jobs (printer_id NULL) so statistics and the
        -- global history stay complete; printer_name keeps them readable.
        CREATE TABLE IF NOT EXISTS print_jobs (
          id                INTEGER PRIMARY KEY,
          printer_id        INTEGER REFERENCES printers(id) ON DELETE SET NULL,
          printer_name      TEXT    NOT NULL,
          task              TEXT,
          gcode_file        TEXT,
          status            TEXT    NOT NULL,
          started_at        INTEGER NOT NULL,
          ended_at          INTEGER,
          updated_at        INTEGER NOT NULL,
          observed_midway   INTEGER NOT NULL DEFAULT 0,
          total_layers      INTEGER,
          last_layer        INTEGER,
          last_percent      INTEGER,
          remaining_minutes INTEGER,
          print_error       INTEGER,
          paused_ms         INTEGER NOT NULL DEFAULT 0,
          paused_at         INTEGER
        );
        CREATE INDEX IF NOT EXISTS print_jobs_printer ON print_jobs(printer_id, started_at);
        CREATE INDEX IF NOT EXISTS print_jobs_started ON print_jobs(started_at);

        -- Web Push subscriptions: one row per browser/device, bound to a user. The
        -- on_* columns are the events this device wants to be notified about.
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id              INTEGER PRIMARY KEY,
          user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          endpoint        TEXT    NOT NULL UNIQUE,
          p256dh          TEXT    NOT NULL,
          auth            TEXT    NOT NULL,
          user_agent      TEXT,
          on_started      INTEGER NOT NULL DEFAULT 0,
          on_finished     INTEGER NOT NULL DEFAULT 1,
          on_failed       INTEGER NOT NULL DEFAULT 1,
          on_paused       INTEGER NOT NULL DEFAULT 1,
          on_hms          INTEGER NOT NULL DEFAULT 1,
          created_at      INTEGER NOT NULL,
          last_success_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
      `);
      // Columns added after the first releases: present already when the
      // tables were just created above, missing on older databases.
      addColumnIfMissing(db, 'printers', 'tls_verify', 'INTEGER NOT NULL DEFAULT 1');
      addColumnIfMissing(db, 'sessions', 'created_at', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'sessions', 'last_seen_at', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'sessions', 'ip', 'TEXT');
      addColumnIfMissing(db, 'sessions', 'user_agent', 'TEXT');
    },
  },
];

export const LATEST_VERSION = migrations.at(-1)?.version ?? 0;

/** Only for the baseline: later migrations know the exact shape they start from. */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** A migration problem the operator has to act on; the message is meant to be shown as is. */
export class MigrationError extends Error {
  override name = 'MigrationError';
}

export function getUserVersion(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
}

function hasUserTables(db: DatabaseSync): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`).get();
}

export interface MigrateOptions {
  /** On-disk path of the database; enables the pre-migration backup. */
  dbPath?: string;
  log?: (message: string) => void;
}

/**
 * Brings the database to LATEST_VERSION. Throws a MigrationError (database
 * left at the last successfully applied version) when a migration fails or the
 * database was written by a newer release.
 */
export function migrate(db: DatabaseSync, options: MigrateOptions = {}, list: readonly Migration[] = migrations): number {
  const latest = list.at(-1)?.version ?? 0;
  const current = getUserVersion(db);
  if (current > latest) {
    throw new MigrationError(
      `Database schema version ${current} is newer than this release supports (${latest}). ` +
        'It was written by a newer version of bambu-controller: upgrade again, or restore the ' +
        'bambu-controller.db.bak-v* backup taken before that upgrade.',
    );
  }
  const pending = list.filter((m) => m.version > current);
  if (pending.length === 0) return current;

  // A version-0 database with tables comes from a release that predates
  // versioning; the baseline migration upgrades it in place (see above).
  const existing = hasUserTables(db);
  if (existing && options.dbPath) {
    try {
      backup(db, options.dbPath, current, options.log);
    } catch (err) {
      // Migrating without the safety net the operator may count on is worse
      // than not starting (typically a full disk).
      throw new MigrationError(`Could not back up the database before migrating: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }

  for (const migration of pending) {
    // IMMEDIATE takes the write lock up front so no other connection can slip
    // a write in between our reads and writes.
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw new MigrationError(
        `Database migration ${migration.version} (${migration.description}) failed and was rolled back; ` +
          `the database is still at version ${getUserVersion(db)}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    options.log?.(
      `Database migrated to version ${migration.version} (${migration.description})` +
        (existing && current === 0 && migration.version === 1 ? ', upgraded from a pre-versioning database' : ''),
    );
  }
  return getUserVersion(db);
}

/**
 * Consistent copy of the database before touching an existing install, so a
 * bad migration can be undone by hand. VACUUM INTO writes a compact snapshot
 * (WAL included) without closing the connection. Only the newest backup is
 * kept: older ones would just accumulate copies of the printer access codes.
 */
function backup(db: DatabaseSync, dbPath: string, version: number, log?: (message: string) => void) {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const target = `${dbPath}.bak-v${version}`;
  fs.rmSync(target, { force: true }); // VACUUM INTO refuses an existing file
  db.prepare('VACUUM INTO ?').run(target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {}
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`${base}.bak-v`) && path.join(dir, name) !== target) fs.rmSync(path.join(dir, name), { force: true });
  }
  log?.(`Backed up the database to ${target} before migrating`);
}
