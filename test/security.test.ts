import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, passwordProblem, verifyPassword } from '../server/auth.ts';
import { isLocalAddress } from '../server/net-policy.ts';
import { decrypt, encrypt, isEncrypted } from '../server/secrets.ts';

describe('access code encryption at rest', () => {
  it('round-trips and uses a fresh IV every time', () => {
    const a = encrypt('12345678');
    const b = encrypt('12345678');
    assert.ok(isEncrypted(a));
    assert.notEqual(a, b);
    assert.equal(decrypt(a), '12345678');
  });

  it('passes legacy plain-text values through', () => {
    assert.equal(decrypt('abcdefgh'), 'abcdefgh');
  });

  it('detects tampering (GCM authentication)', () => {
    const enc = encrypt('12345678');
    const raw = Buffer.from(enc.slice('enc:v1:'.length), 'base64');
    raw[raw.length - 1] ^= 0xff;
    assert.throws(() => decrypt(`enc:v1:${raw.toString('base64')}`), /Could not decrypt/);
  });
});

describe('password hashing', () => {
  it('verifies the right password only', async () => {
    const hash = await hashPassword('Correct-Horse-1');
    assert.match(hash, /^scrypt\$/);
    assert.equal(await verifyPassword('Correct-Horse-1', hash), true);
    assert.equal(await verifyPassword('correct-horse-1', hash), false);
    assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  });
});

describe('password policy', () => {
  const cases: [string, string, boolean][] = [
    ['Short1!', 'alice', false],
    ['password123', 'alice', false], // two classes, < 16 chars
    ['Password123', 'alice', false], // three classes, but on the common-password list
    ['Shelf-Printer7', 'alice', true], // three classes
    ['alice-Rocks-2026', 'alice', false], // contains username
    ['correct horse battery staple', 'alice', true], // passphrase
    ['Bambulab', 'alice', false],
    ['x'.repeat(300), 'alice', false],
  ];
  for (const [password, user, ok] of cases) {
    it(`${ok ? 'accepts' : 'rejects'} ${JSON.stringify(password.slice(0, 30))}`, () => {
      assert.equal(passwordProblem(password, user) === null, ok);
    });
  }
});

describe('printer network policy', () => {
  it('accepts LAN, loopback, link-local and CGNAT addresses', () => {
    for (const ip of ['192.168.1.20', '10.1.2.3', '172.20.0.5', '127.0.0.1', '169.254.1.1', '100.100.1.1', 'fe80::1', '::1', 'fd00::5']) {
      assert.equal(isLocalAddress(ip), true, ip);
    }
  });

  it('rejects public addresses and hostnames', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2001:4860:4860::8888', 'printer.local']) {
      assert.equal(isLocalAddress(ip), false, ip);
    }
  });
});
