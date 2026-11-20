import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../server/app.ts';
import { PrinterConnection } from '../server/bambu/printer.ts';
import { manager } from '../server/manager.ts';

/** Route schemas: malformed input is rejected with a readable 400 before any handler runs. */
let app: FastifyInstance;
let cookie = '';
let base = '';
const sent: unknown[] = [];

const json = { 'content-type': 'application/json', 'x-requested-with': 'test' };

async function call(options: InjectOptions) {
  const type = options.payload === undefined ? { 'x-requested-with': 'test' } : json;
  const res = await app.inject({ ...options, headers: { ...type, cookie, ...options.headers } });
  return { status: res.statusCode, error: res.json()?.error as string | undefined, res };
}

/** A 400 whose message is a plain sentence, not an Ajv dump. */
async function rejects(options: InjectOptions, message?: string | RegExp) {
  const { status, error } = await call(options);
  assert.equal(status, 400, `${options.method} ${options.url} → ${status} ${error}`);
  assert.equal(typeof error, 'string');
  assert.doesNotMatch(error!, /#\/|schema|must match|NOT have/, error);
  if (typeof message === 'string') assert.equal(error, message);
  else if (message) assert.match(error!, message);
}

before(async () => {
  app = await buildApp({ logLevel: false });
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: json,
    payload: { username: 'admin', password: 'Sup3r-Secret!' },
  });
  cookie = String(setup.headers['set-cookie']).split(';')[0];

  // No MQTT in tests: keep the connection from dialing the fake address.
  const start = PrinterConnection.prototype.start;
  PrinterConnection.prototype.start = () => {};
  const row = manager.create({
    name: 'Fake',
    model: 'P1S',
    serial: '01P00A000000002',
    ip: '127.0.0.1',
    access_code: '12345678',
    camera: 'none',
    tls_verify: 0,
  });
  PrinterConnection.prototype.start = start;
  manager.get(row.id)!.connection.send = async (payload) => void sent.push(payload);
  base = `/api/printers/${row.id}`;
});

after(async () => {
  for (const p of manager.all()) manager.remove(p.connection.row.id);
  await app.close();
});

describe('request validation', () => {
  it('checks authentication before validating input', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/printers/not-a-number' });
    assert.equal(res.statusCode, 401);
    const body = await app.inject({ method: 'POST', url: `${base}/command`, headers: json, payload: { action: 42 } });
    assert.equal(body.statusCode, 401);
  });

  it('rejects ids that are not positive integers', async () => {
    for (const id of ['abc', '0', '-1', '1.5', '1e3', '007', '99999999999999999999']) {
      await rejects({ method: 'GET', url: `/api/printers/${id}` }, 'Invalid id');
    }
    await rejects({ method: 'DELETE', url: '/api/history/abc' }, 'Invalid id');
    await rejects({ method: 'DELETE', url: '/api/users/x' }, 'Invalid id');
    await rejects({ method: 'PUT', url: '/api/push/subscriptions/1.0', payload: { preferences: {} } }, 'Invalid id');
    await rejects({ method: 'DELETE', url: '/api/auth/sessions/NOT-HEX' }, 'Session not found');
    // Well-formed but unknown ids still get a 404.
    assert.equal((await call({ method: 'GET', url: '/api/printers/424242' })).status, 404);
  });

  it('rejects malformed printer input with the form messages', async () => {
    const valid = { name: 'x', model: 'X1C', serial: '00M09C450700001', ip: '192.168.1.5', accessCode: '12345678' };
    await rejects({ method: 'POST', url: '/api/printers', payload: { ...valid, name: 42 } }, 'Name is required (max 64 characters)');
    await rejects({ method: 'POST', url: '/api/printers', payload: { ...valid, name: 'n'.repeat(65) } }, 'Name is required (max 64 characters)');
    await rejects({ method: 'POST', url: '/api/printers', payload: { ...valid, model: undefined } }, 'Model is required');
    await rejects({ method: 'POST', url: '/api/printers', payload: { ...valid, camera: 'webcam' } }, 'Invalid camera setting');
    await rejects({ method: 'POST', url: '/api/printers', payload: { ...valid, tlsVerify: 'no' } }, '"tlsVerify" must be a boolean');
    await rejects({ method: 'POST', url: '/api/printers', payload: { ...valid, admin: true } }, 'Unknown field "admin"');
    await rejects({ method: 'POST', url: '/api/printers', payload: [valid] }, 'Request body must be a JSON object');
    // `skipTest` only exists when adding a printer.
    await rejects({ method: 'PUT', url: base, payload: { ...valid, skipTest: true } }, 'Unknown field "skipTest"');
  });

  it('rejects malformed commands without sending anything', async () => {
    await rejects({ method: 'POST', url: `${base}/command`, payload: { action: 'selfDestruct' } }, 'Unknown action');
    await rejects({ method: 'POST', url: `${base}/command`, payload: { temp: 200 } }, 'Unknown action');
    await rejects({ method: 'POST', url: `${base}/command`, payload: { action: 7 } }, 'Unknown action');
    await rejects({ method: 'POST', url: `${base}/command`, payload: { action: 'bedTemp', temp: '60' } }, '"temp" must be a number');
    await rejects({ method: 'POST', url: `${base}/command`, payload: { action: 'bedTemp' } }, 'Missing field "temp"');
    await rejects({ method: 'POST', url: `${base}/command`, payload: { action: 'pause', force: true } }, 'Unknown field "force"');
    await rejects({ method: 'POST', url: `${base}/command`, payload: { action: 'jog', axis: 'W', distance: 1 } }, 'Invalid axis');
    await rejects({ method: 'POST', url: `${base}/command`, payload: { action: 'speed', level: 2.5 } }, '"level" must be an integer');
    await rejects({ method: 'POST', url: `${base}/command`, payload: { action: 'light', node: 'laser', on: true } }, /"node" must be one of/);
    await rejects({ method: 'POST', url: `${base}/command`, payload: { action: 'gcode', gcode: 'G28\n'.repeat(1001) } }, 'G-code is empty or too long');
    // Ranges are still checked by the command builder, with the same message as before.
    await rejects({ method: 'POST', url: `${base}/command`, payload: { action: 'nozzleTemp', temp: 999 } }, 'Value must be between 0 and 350');
    assert.equal(sent.length, 0);

    const ok = await call({ method: 'POST', url: `${base}/command`, payload: { action: 'nozzleTemp', temp: 210, extruder: null } });
    assert.equal(ok.status, 200);
    assert.equal(sent.length, 1);
  });

  it('rejects malformed file and print requests', async () => {
    await rejects({ method: 'GET', url: `${base}/files?path=${'a'.repeat(1025)}` }, 'Invalid path');
    await rejects({ method: 'GET', url: `${base}/files?path=a&path=b` }, 'Invalid path');
    await rejects({ method: 'POST', url: `${base}/print`, payload: { path: '/a.3mf', plate: 0 } }, 'Invalid plate');
    await rejects({ method: 'POST', url: `${base}/print`, payload: { path: '/a.3mf', plate: '2' } }, 'Invalid plate');
    await rejects({ method: 'POST', url: `${base}/print`, payload: { path: '/a.3mf', timelapse: 'yes' } }, '"timelapse" must be a boolean');
    await rejects({ method: 'POST', url: `${base}/print`, payload: { path: '/a.3mf', gcode: 'M112' } }, 'Unknown field "gcode"');
    await rejects({ method: 'POST', url: `${base}/print`, payload: {} }, 'Invalid path');
  });

  it('keeps multipart uploads working under a query schema', async () => {
    const boundary = 'testboundary';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="evil.sh"',
      'Content-Type: application/octet-stream',
      '',
      'echo hi',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await call({
      method: 'POST',
      url: `${base}/files/upload?path=/`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    // Reached the handler (which refuses the extension), so the body wasn't validated as JSON.
    assert.equal(res.status, 400);
    assert.equal(res.error, 'Only .3mf and .gcode files can be uploaded');
  });

  it('rejects malformed history and push requests', async () => {
    await rejects({ method: 'GET', url: '/api/history?limit=abc' }, 'limit must be an integer');
    await rejects({ method: 'GET', url: `${base}/history?offset=1.5` }, 'offset must be an integer');
    await rejects({ method: 'GET', url: `${base}/job/objects?refresh=yes` }, /"refresh" must be one of/);
    await rejects({ method: 'POST', url: '/api/push/subscriptions', payload: { subscription: 'x' } }, 'Invalid push subscription');
    await rejects({ method: 'POST', url: '/api/push/subscriptions', payload: {} }, 'Invalid push subscription');
    await rejects({ method: 'PUT', url: '/api/push/subscriptions/1', payload: { preferences: { hms: 'yes' } } }, '"preferences.hms" must be a boolean');
    await rejects({ method: 'PUT', url: '/api/push/subscriptions/1', payload: { preferences: [] } }, 'Invalid preferences');
  });

  it('rejects malformed credentials', async () => {
    await rejects({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 12345 } }, 'Invalid username or password');
    await rejects({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin' } }, 'Invalid username or password');
    await rejects({ method: 'POST', url: '/api/users', payload: { username: ['a'], password: 'Sup3r-Secret!' } }, /^Username must be/);
    await rejects({ method: 'POST', url: '/api/users', payload: { username: 'bob', password: 'Sup3r-Secret!', admin: true } }, 'Unknown field "admin"');
    await rejects({ method: 'POST', url: '/api/users', payload: { username: 'bob', password: 'x'.repeat(257) } }, 'Password is too long (max 256 characters)');
    await rejects({ method: 'POST', url: '/api/auth/password', payload: { current: 1, next: 'Sup3r-Secret!2' } }, 'Current password is incorrect');
  });
});
