import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'bambu-controller.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

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
`);

export type CameraSetting = 'auto' | 'jpeg' | 'rtsps' | 'none';

export interface PrinterRow {
  id: number;
  name: string;
  model: string;
  serial: string;
  ip: string;
  access_code: string;
  camera: CameraSetting;
  created_at: number;
}

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
}
