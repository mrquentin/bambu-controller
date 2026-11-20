import crypto from 'node:crypto';

/**
 * Web Push protocol primitives, implemented with node:crypto only:
 *  - VAPID (RFC 8292): an ES256 JWT that identifies this server to the
 *    browser vendor's push service.
 *  - Message encryption (RFC 8291 + RFC 8188 "aes128gcm"): the payload is
 *    encrypted for the browser, so the push service only relays ciphertext.
 */

/** RFC 8188 record size advertised in the header; one record must hold the whole message. */
const RECORD_SIZE = 4096;
/** Header = salt (16) + rs (4) + idlen (1) + uncompressed P-256 key (65). */
const HEADER_LENGTH = 16 + 4 + 1 + 65;
/** Plaintext limit: one record minus the padding delimiter and the GCM tag. */
const MAX_PAYLOAD = RECORD_SIZE - HEADER_LENGTH - 1 - 16;

const b64url = (buf: Uint8Array) => Buffer.from(buf).toString('base64url');
export const fromB64url = (s: string) => Buffer.from(s, 'base64url');

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

/** True when `key` is an uncompressed P-256 public key (0x04 || X || Y) on the curve. */
export function isP256PublicKey(key: Buffer) {
  if (key.length !== 65 || key[0] !== 0x04) return false;
  try {
    crypto.ECDH.convertKey(key, 'prime256v1');
    return true;
  } catch {
    return false;
  }
}

export interface EncryptOptions {
  /** Fixed application-server private key (tests only; normally a fresh key per message). */
  asPrivate?: Buffer;
  /** Fixed salt (tests only; normally 16 random bytes). */
  salt?: Buffer;
}

/**
 * Encrypt a push message for a subscription (RFC 8291 §3.4) and return the
 * `aes128gcm` request body: header followed by a single record.
 */
export function encryptPayload(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, options: EncryptOptions = {}): Buffer {
  if (plaintext.length > MAX_PAYLOAD) throw new Error(`Push payload too large (${plaintext.length} > ${MAX_PAYLOAD} bytes)`);
  const ecdh = crypto.createECDH('prime256v1');
  if (options.asPrivate) ecdh.setPrivateKey(options.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = options.salt ?? crypto.randomBytes(16);

  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const header = Buffer.alloc(HEADER_LENGTH);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce, { authTagLength: 16 });
  // 0x02 = padding delimiter of the last (here: only) record, no extra padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final()]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

export interface VapidKeys {
  /** Uncompressed public key, base64url: the browser's `applicationServerKey`. */
  publicKey: string;
  privateKey: crypto.KeyObject;
}

export function generateVapidJwk(): crypto.JsonWebKey {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ format: 'jwk' });
}

export function vapidKeysFromJwk(jwk: crypto.JsonWebKey): VapidKeys {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new Error('Invalid VAPID key');
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = b64url(Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]));
  return { publicKey, privateKey };
}

/**
 * `Authorization` header value for a push request (RFC 8292 §3): a JWT signed
 * with ES256 whose audience is the push service's origin.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, expiresAt = Date.now() + 12 * 3600_000) {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(expiresAt / 1000), sub: subject })),
  );
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}
