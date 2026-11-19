import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

/**
 * Encryption at rest for printer access codes (AES-256-GCM).
 *
 * Key source, in order:
 *  1. APP_SECRET env var (any string; hashed to 32 bytes). Recommended: keep
 *     it outside the data volume so a copied database alone is useless.
 *  2. data/secret.key, generated on first start (owner-only permissions).
 */
const PREFIX = 'enc:v1:';

function loadKey(): Buffer {
  const fromEnv = process.env.APP_SECRET;
  if (fromEnv) {
    if (fromEnv.length < 16) throw new Error('APP_SECRET must be at least 16 characters');
    return crypto.createHash('sha256').update(fromEnv).digest();
  }
  const keyFile = path.join(config.dataDir, 'secret.key');
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  }
  const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`${keyFile} is corrupt (expected 32 bytes, base64)`);
  return key;
}

const key = loadKey();

export function isEncrypted(value: string) {
  return value.startsWith(PREFIX);
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function decrypt(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: 16 });
  decipher.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Could not decrypt a stored access code — was APP_SECRET or secret.key changed?');
  }
}
