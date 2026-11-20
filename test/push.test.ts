import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { JobSnapshot, PrinterEvent } from '../server/bambu/job-events.ts';
import { db } from '../server/db.ts';
import { checkPushEndpoint, isPublicAddress, pushResolver } from '../server/net-policy.ts';
import { messageFor, notifyPrinterEvent, saveSubscription } from '../server/push.ts';
import { encryptPayload, fromB64url, generateVapidJwk, vapidAuthorization, vapidKeysFromJwk } from '../server/webpush.ts';

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, len: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

/** Receiver side of RFC 8291 (what the browser does), to check our output round-trips. */
function decryptPayload(body: Buffer, ua: crypto.ECDH, auth: Buffer) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const ikm = hkdf(auth, ua.computeSecret(asPublic), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce, { authTagLength: 16 });
  decipher.setAuthTag(record.subarray(-16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
  assert.equal(padded.at(-1), 0x02);
  return padded.subarray(0, -1);
}

describe('web push encryption (RFC 8291)', () => {
  it('matches the RFC 8291 Appendix A test vector', () => {
    const body = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      fromB64url('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
      fromB64url('BTBZMqHH6r4Tts7J_aSIgg'),
      { asPrivate: fromB64url('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: fromB64url('DGv6ra1nlYgDCS1FRnbzlw') },
    );
    assert.equal(
      body.subarray(0, 86).toString('base64url'),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    );
    assert.equal(body.subarray(86).toString('base64url'), '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ');
    assert.equal(
      body.toString('base64url'),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('round-trips with a fresh key and salt every time', () => {
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const a = encryptPayload(Buffer.from('{"title":"hi"}'), ua.getPublicKey(), auth);
    const b = encryptPayload(Buffer.from('{"title":"hi"}'), ua.getPublicKey(), auth);
    assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16));
    assert.equal(decryptPayload(a, ua, auth).toString(), '{"title":"hi"}');
    assert.throws(() => encryptPayload(Buffer.alloc(4000), ua.getPublicKey(), auth), /too large/);
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs an ES256 JWT for the push service origin', () => {
    const keys = vapidKeysFromJwk(generateVapidJwk());
    const now = Date.now();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:me@example.com', now + 3600_000);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    assert.ok(match, header);
    const [, h, c, sig, k] = match;
    assert.equal(k, keys.publicKey);
    assert.equal(fromB64url(k).length, 65);
    assert.deepEqual(JSON.parse(fromB64url(h).toString()), { typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(fromB64url(c).toString());
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.sub, 'mailto:me@example.com');
    assert.equal(claims.exp, Math.floor((now + 3600_000) / 1000));
    assert.equal(fromB64url(sig).length, 64); // raw r || s, not DER

    const pub = fromB64url(k);
    const verifyKey = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, fromB64url(sig));
    assert.equal(ok, true);
  });
});

// Fake DNS: *.push.example is public, anything else resolves to the LAN.
const realLookup = pushResolver.lookup;
const fakeDns = async (host: string) =>
  host.endsWith('.push.example') ? ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] : host === 'mixed.example' ? ['93.184.216.34', '10.0.0.1'] : ['192.168.1.10'];

describe('push endpoint SSRF policy', () => {
  beforeEach(() => (pushResolver.lookup = fakeDns));
  afterEach(() => (pushResolver.lookup = realLookup));

  it('accepts an https endpoint on a public host', async () => {
    assert.equal(await checkPushEndpoint('https://fcm.push.example/fcm/send/abc'), null);
  });

  const rejected: [string, RegExp][] = [
    ['http://fcm.push.example/send/abc', /https/],
    ['https://fcm.push.example:8443/send/abc', /default https port/],
    ['https://user:pw@fcm.push.example/send/abc', /credentials/],
    ['https://127.0.0.1/send', /host name/],
    ['https://[::1]/send', /host name/],
    ['https://router.lan/send', /public address/],
    ['https://mixed.example/send', /public address/],
    ['not a url', /valid URL/],
    [`https://fcm.push.example/${'a'.repeat(1100)}`, /too long/],
  ];
  for (const [url, error] of rejected) {
    it(`rejects ${url.slice(0, 50)}`, async () => {
      assert.match((await checkPushEndpoint(url)) ?? '', error);
    });
  }

  it('classifies public and non-public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888']) assert.equal(isPublicAddress(ip), true, ip);
    for (const ip of [
      '10.0.0.1', '192.168.1.1', '172.16.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
      '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '2002:a00:1::1',
    ]) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });
});

const job: JobSnapshot = {
  gcodeState: 'FINISH', task: 'Benchy', gcodeFile: null, percent: 100, layer: 150, totalLayers: 150,
  remainingMinutes: 0, printError: 0, hms: [],
};
const printer = { id: 7, name: 'Garage X1C' };
const event = (e: Record<string, unknown>) => ({ job, at: Date.now(), ...e }) as PrinterEvent;

describe('notification messages', () => {
  it('stays quiet for jobs already running when the app started watching', () => {
    assert.equal(messageFor(printer, event({ type: 'job_started', observedMidway: true })), null);
    assert.equal(messageFor(printer, event({ type: 'job_resumed' })), null);
    assert.equal(messageFor(printer, event({ type: 'job_started', observedMidway: false }))?.kind, 'started');
  });

  it('describes failures and alerts with high urgency, per-printer tag and link', () => {
    const failed = messageFor(printer, event({ type: 'job_failed', printError: 0x0300400c }))!;
    assert.equal(failed.title, 'Garage X1C: print failed or cancelled');
    assert.match(failed.body, /Benchy · 100% · layer 150\/150 · error 0300_400C/);
    assert.equal(failed.urgency, 'high');
    assert.equal(failed.tag, 'printer-7-failed');
    assert.equal(failed.topic, 'printer-7-failed');
    assert.equal(failed.url, '/#/printer/7');

    const hms = messageFor(printer, event({ type: 'hms_raised', alerts: [{ attr: 0x07008000, code: 0x00030001 }] }))!;
    assert.equal(hms.body, 'HMS_0700_8000_0003_0001 (Common)');
    assert.equal(hms.urgency, 'high');

    assert.equal(messageFor(printer, event({ type: 'job_paused', printError: 0 }))!.urgency, 'normal');
    assert.match(messageFor(printer, event({ type: 'job_paused', printError: 0x07008011 }))!.title, /needs attention/);
  });
});

describe('notification fan-out', () => {
  const realFetch = globalThis.fetch;
  let calls: { url: string; headers: Record<string, string> }[] = [];
  let statusFor: (url: string) => number = () => 201;

  beforeEach(() => {
    pushResolver.lookup = fakeDns;
    calls = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response(null, { status: statusFor(url) });
    }) as typeof fetch;
  });
  afterEach(() => {
    pushResolver.lookup = realLookup;
    globalThis.fetch = realFetch;
  });

  function subscriber(name: string, endpoint: string) {
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const userId = Number(
      db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(name, 'x', Date.now()).lastInsertRowid,
    );
    const saved = saveSubscription(
      userId,
      { endpoint, p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
      null,
    );
    return { userId, id: saved.id };
  }

  it('sends only to subscriptions that want the event, and drops expired ones', async () => {
    const a = subscriber('fan-a', 'https://a.push.example/1');
    const b = subscriber('fan-b', 'https://b.push.example/2');
    db.prepare('UPDATE push_subscriptions SET on_finished = 0 WHERE id = ?').run(b.id);

    await notifyPrinterEvent(printer, event({ type: 'job_finished' }));
    assert.deepEqual(calls.map((c) => c.url), ['https://a.push.example/1']);
    assert.equal(calls[0].headers['Content-Encoding'], 'aes128gcm');
    assert.equal(calls[0].headers.Topic, 'printer-7-finished');
    assert.match(calls[0].headers.Authorization, /^vapid t=/);
    const row = db.prepare('SELECT last_success_at FROM push_subscriptions WHERE id = ?').get(a.id) as { last_success_at: number };
    assert.ok(row.last_success_at > 0);

    // Nobody asked for "started" (off by default).
    calls = [];
    await notifyPrinterEvent(printer, event({ type: 'job_started', observedMidway: false }));
    assert.equal(calls.length, 0);

    // The push service says b is gone: it's deleted; failures of others don't throw.
    calls = [];
    statusFor = (url) => (url.includes('b.push') ? 410 : 500);
    await notifyPrinterEvent(printer, event({ type: 'job_failed', printError: 0 }));
    assert.equal(calls.length, 2);
    assert.equal(db.prepare('SELECT id FROM push_subscriptions WHERE id = ?').get(b.id), undefined);
    assert.ok(db.prepare('SELECT id FROM push_subscriptions WHERE id = ?').get(a.id));
    statusFor = () => 201;
  });

  it('notifies the same HMS alert only once in a while', async () => {
    const alert = { type: 'hms_raised', alerts: [{ attr: 0x0c001000, code: 0x00020001 }] };
    await notifyPrinterEvent({ id: 99, name: 'p' }, event(alert));
    const first = calls.length;
    assert.ok(first > 0);
    await notifyPrinterEvent({ id: 99, name: 'p' }, event(alert));
    assert.equal(calls.length, first);
  });

  it('deletes subscriptions with their user', () => {
    const c = subscriber('fan-c', 'https://c.push.example/3');
    db.prepare('DELETE FROM users WHERE id = ?').run(c.userId);
    assert.equal(db.prepare('SELECT id FROM push_subscriptions WHERE id = ?').get(c.id), undefined);
  });
});
