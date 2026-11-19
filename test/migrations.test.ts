import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { LATEST_VERSION, MigrationError, getUserVersion, migrate, migrations, type Migration } from '../server/migrations.ts';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambu-controller-migrations-'));
  const dbPath = path.join(dir, 'bambu-controller.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  return { dir, dbPath, db };
}

/** Everything that defines the schema, independent of how the SQL was written. */
function schemaOf(db: DatabaseSync) {
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  return Object.fromEntries(
    tables.map((t) => [
      t,
      {
        columns: db.prepare(`PRAGMA table_info(${t})`).all(),
        indexes: (db.prepare(`PRAGMA index_list(${t})`).all() as { name: string; unique: number }[])
          .map((i) => ({ ...i, columns: db.prepare(`PRAGMA index_info(${i.name})`).all() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        foreignKeys: db.prepare(`PRAGMA foreign_key_list(${t})`).all(),
      },
    ]),
  );
}

// The oldest released schema (first commit): no tls_verify, sessions without
// the metadata columns, no print history and no push subscriptions.
const OLDEST_SCHEMA = `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE printers (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    model       TEXT    NOT NULL,
    serial      TEXT    NOT NULL UNIQUE,
    ip          TEXT    NOT NULL,
    access_code TEXT    NOT NULL,
    camera      TEXT    NOT NULL DEFAULT 'auto',
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE audit_log (
    id       INTEGER PRIMARY KEY,
    at       INTEGER NOT NULL,
    user_id  INTEGER,
    username TEXT,
    ip       TEXT,
    action   TEXT    NOT NULL,
    outcome  TEXT    NOT NULL DEFAULT 'success',
    detail   TEXT
  );
  CREATE INDEX audit_log_at ON audit_log(at);
`;

// What the last pre-versioning release produced on a fresh install: the
// statements of the former db.ts, in order (tables, then the additive ALTERs).
const LAST_UNVERSIONED_SCHEMA = `
  ${OLDEST_SCHEMA}
  ALTER TABLE printers ADD COLUMN tls_verify INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN ip TEXT;
  ALTER TABLE sessions ADD COLUMN user_agent TEXT;
  CREATE TABLE print_jobs (
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
  CREATE INDEX print_jobs_printer ON print_jobs(printer_id, started_at);
  CREATE INDEX print_jobs_started ON print_jobs(started_at);
  CREATE TABLE push_subscriptions (
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
  CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
`;

test('a fresh database ends at the latest version with the pre-versioning schema', () => {
  const { dir, dbPath, db } = tempDb();
  assert.equal(migrate(db, { dbPath }), LATEST_VERSION);
  assert.equal(getUserVersion(db), LATEST_VERSION);
  // Nothing to protect on a fresh install.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.bak-v')), []);

  const reference = new DatabaseSync(':memory:');
  reference.exec(LAST_UNVERSIONED_SCHEMA);
  assert.deepEqual(schemaOf(db), schemaOf(reference));
  assert.deepEqual(Object.keys(schemaOf(db)), [
    'audit_log',
    'print_jobs',
    'printers',
    'push_subscriptions',
    'sessions',
    'users',
  ]);
});

test('running the migrations again is a no-op', () => {
  const { dbPath, db } = tempDb();
  migrate(db, { dbPath });
  const before = schemaOf(db);
  assert.equal(migrate(db, { dbPath }), LATEST_VERSION);
  assert.deepEqual(schemaOf(db), before);
});

test('a database from the oldest release is upgraded in place and keeps its rows', () => {
  const { dir, dbPath, db } = tempDb();
  db.exec(OLDEST_SCHEMA);
  db.prepare(`INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'admin', 'hash', 100)`).run();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('tok', 1, 999)`).run();
  db.prepare(
    `INSERT INTO printers (id, name, model, serial, ip, access_code, camera, created_at)
     VALUES (1, 'X1C', 'X1C', '00M00A000000000', '192.0.2.10', 'enc:code', 'auto', 200)`,
  ).run();
  db.prepare(`INSERT INTO audit_log (at, user_id, username, ip, action) VALUES (300, 1, 'admin', '192.0.2.1', 'login')`).run();
  assert.equal(getUserVersion(db), 0);

  assert.equal(migrate(db, { dbPath }), LATEST_VERSION);

  const reference = new DatabaseSync(':memory:');
  reference.exec(LAST_UNVERSIONED_SCHEMA);
  assert.deepEqual(schemaOf(db), schemaOf(reference));

  assert.deepEqual({ ...db.prepare('SELECT * FROM users').get() }, {
    id: 1,
    username: 'admin',
    password_hash: 'hash',
    created_at: 100,
  });
  assert.deepEqual({ ...db.prepare('SELECT * FROM sessions').get() }, {
    token_hash: 'tok',
    user_id: 1,
    expires_at: 999,
    created_at: 0,
    last_seen_at: 0,
    ip: null,
    user_agent: null,
  });
  const printer = db.prepare('SELECT serial, access_code, tls_verify FROM printers').get();
  assert.deepEqual({ ...printer }, { serial: '00M00A000000000', access_code: 'enc:code', tls_verify: 1 });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, 1);

  // The new tables are usable, including their foreign keys to old rows.
  db.prepare(
    `INSERT INTO print_jobs (printer_id, printer_name, status, started_at, updated_at) VALUES (1, 'X1C', 'running', 1, 1)`,
  ).run();
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (1, 'https://p', 'k', 'a', 1)`).run();

  // A backup of the pre-migration database was taken, owner-only, with the rows.
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.bak-v'));
  assert.deepEqual(backups, ['bambu-controller.db.bak-v0']);
  const backupPath = path.join(dir, backups[0]!);
  if (process.platform !== 'win32') assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
  const copy = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(getUserVersion(copy), 0);
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM printers').get() as { n: number }).n, 1);
  copy.close();
});

test('a database from the last pre-versioning release is stamped without changes', () => {
  const { db } = tempDb();
  db.exec(LAST_UNVERSIONED_SCHEMA);
  const before = schemaOf(db);
  assert.equal(migrate(db), LATEST_VERSION);
  assert.deepEqual(schemaOf(db), before);
});

test('a database newer than the code is refused', () => {
  const { db } = tempDb();
  migrate(db);
  db.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
  assert.throws(() => migrate(db), (err: Error) => err instanceof MigrationError && /newer than this release/.test(err.message));
  assert.equal(getUserVersion(db), LATEST_VERSION + 1);
});

test('a failing migration rolls back and leaves the previous version', () => {
  const { dir, dbPath, db } = tempDb();
  migrate(db, { dbPath });
  db.prepare(`INSERT INTO users (username, password_hash, created_at) VALUES ('admin', 'hash', 1)`).run();
  const list: Migration[] = [
    ...migrations,
    {
      version: LATEST_VERSION + 1,
      description: 'test migration',
      up(d) {
        d.exec('ALTER TABLE users ADD COLUMN extra TEXT');
        d.exec('INSERT INTO nope VALUES (1)');
      },
    },
  ];
  assert.throws(
    () => migrate(db, { dbPath }, list),
    (err: Error) => err instanceof MigrationError && /test migration\) failed and was rolled back/.test(err.message),
  );
  assert.equal(getUserVersion(db), LATEST_VERSION);
  const columns = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(!columns.includes('extra'));
  assert.equal(db.isTransaction, false);
  // Only the newest backup is kept.
  fs.writeFileSync(path.join(dir, 'bambu-controller.db.bak-v0'), 'old');
  assert.throws(() => migrate(db, { dbPath }, list), MigrationError);
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes('.bak-v')),
    [`bambu-controller.db.bak-v${LATEST_VERSION}`],
  );
});

