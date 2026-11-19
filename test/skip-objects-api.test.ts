import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type tls from 'node:tls';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import selfsigned from 'selfsigned';
import { buildApp } from '../server/app.ts';
import { PrinterFtps } from '../server/bambu/ftps.ts';
import { manager, type ManagedPrinter } from '../server/manager.ts';
import { PrinterConnection } from '../server/bambu/printer.ts';
import { startFakeFtps } from '../scripts/fake-ftps.ts';
import { buildSample3mf } from '../scripts/sample-3mf.ts';

/** Skip objects end to end: routes, command validation, audit, and FTPS ranged reads against a fake printer. */
let app: FastifyInstance;
let ftpServer: tls.Server;
let printer: ManagedPrinter;
let cookie = '';
const sample = buildSample3mf();
const files = new Map([['/cache/Benchy.gcode.3mf', sample]]);
const sent: unknown[] = [];

const headers = () => ({ cookie, 'content-type': 'application/json', 'x-requested-with': 'test' });
const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

before(async () => {
  app = await buildApp({ logLevel: false });
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'test' },
    payload: { username: 'admin', password: 'Sup3r-Secret!' },
  });
  cookie = String(setup.headers['set-cookie']).split(';')[0];

  const pems = await selfsigned.generate([{ name: 'commonName', value: '01P00A000000001' }], { keySize: 2048 });
  ftpServer = await startFakeFtps({
    host: '127.0.0.1',
    port: 0,
    password: '12345678',
    tlsOptions: { key: pems.private, cert: pems.cert },
    files,
  });

  // No MQTT in tests: keep the connection from dialing the fake address.
  const start = PrinterConnection.prototype.start;
  PrinterConnection.prototype.start = () => {};
  const row = manager.create({
    name: 'Fake',
    model: 'P1S',
    serial: '01P00A000000001',
    ip: '127.0.0.1',
    access_code: '12345678',
    camera: 'none',
    tls_verify: 0,
  });
  PrinterConnection.prototype.start = start;
  printer = manager.get(row.id)!;
  printer.connection.send = async (payload) => void sent.push(payload);
  printer.ftps.port = (ftpServer.address() as AddressInfo).port;
});

after(async () => {
  manager.remove(printer.connection.row.id);
  ftpServer.close();
  await app.close();
});

const setState = (state: Record<string, unknown>) => {
  printer.connection.state = state;
};
const base = () => `/api/printers/${printer.connection.row.id}`;

describe('PrinterFtps ranged reads', () => {
  it('finds the first existing file and reads byte ranges', async () => {
    const ftps = new PrinterFtps('127.0.0.1', '12345678', { serial: '01P00A000000001', tls_verify: 0 });
    ftps.port = (ftpServer.address() as AddressInfo).port;
    assert.deepEqual(await ftps.firstExisting(['/nope.3mf', '/cache/Benchy.gcode.3mf']), {
      path: '/cache/Benchy.gcode.3mf',
      size: sample.length,
    });
    assert.equal(await ftps.firstExisting(['/nope.3mf']), null);
    assert.deepEqual(await ftps.readRange('/cache/Benchy.gcode.3mf', 10, 100), sample.subarray(10, 110));
    const tail = await ftps.readRange('/cache/Benchy.gcode.3mf', sample.length - 50, 1000);
    assert.deepEqual(tail, sample.subarray(sample.length - 50));
  });
});

describe('job objects API', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: `${base()}/job/objects` });
    assert.equal(res.statusCode, 401);
  });

  it('404s for unknown printers', async () => {
    assert.equal((await get('/api/printers/9999/job/objects')).statusCode, 404);
  });

  it('409s when nothing is printing', async () => {
    setState({ gcode_state: 'IDLE' });
    const res = await get(`${base()}/job/objects`);
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /No print is running/);
  });

  it('404s with the tried paths when the project file is gone', async () => {
    setState({ gcode_state: 'RUNNING', subtask_name: 'Missing', gcode_file: '/data/Metadata/plate_1.gcode' });
    const res = await get(`${base()}/job/objects`);
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error, /\/cache\/Missing\.gcode\.3mf/);
  });

  it('lists the objects of the running plate, with skipped ones flagged', async () => {
    setState({ gcode_state: 'RUNNING', subtask_name: 'Benchy', gcode_file: '/data/Metadata/plate_1.gcode', s_obj: [513] });
    const res = await get(`${base()}/job/objects`);
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.file, '/cache/Benchy.gcode.3mf');
    assert.equal(body.plate, 1);
    assert.equal(body.hasPickMap, true);
    assert.equal(body.hasPlateImage, true);
    assert.deepEqual(
      body.objects.map((o: any) => [o.id, o.skipped]),
      [
        [79, false],
        [296, false],
        [513, true],
        [70000, false],
      ],
    );
  });

  it('serves the plate thumbnail and pick map as uncached PNGs', async () => {
    for (const name of ['plate.png', 'pick.png']) {
      const res = await get(`${base()}/job/${name}`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'image/png');
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.rawPayload.subarray(1, 4).toString(), 'PNG');
    }
  });

  it('validates skip commands against the job and audits object names', async () => {
    const command = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `${base()}/command`, headers: headers(), payload });

    for (const ids of [[], [0], ['79'], [424242]]) {
      const res = await command({ action: 'skipObjects', ids });
      assert.equal(res.statusCode, 400, JSON.stringify(ids));
    }
    assert.match((await command({ action: 'skipObjects', ids: [424242] })).json().error, /not part of the current print/);
    assert.equal(sent.length, 0);

    const res = await command({ action: 'skipObjects', ids: [296, 513] });
    assert.equal(res.statusCode, 200);
    assert.deepEqual((sent.pop() as any).print.obj_list, [296]); // 513 was already skipped

    const audit = await get('/api/audit');
    const entry = audit.json().find((a: any) => a.action === 'printer.command' && a.detail.command === 'skipObjects');
    assert.deepEqual(entry.detail.objects, [{ id: 296, name: 'Benchy <v2> & "friends"' }]);
  });

  it('404s for images the project does not have', async () => {
    setState({ gcode_state: 'RUNNING', subtask_name: 'Benchy', gcode_file: 'Metadata/plate_2.gcode' });
    assert.equal((await get(`${base()}/job/pick.png`)).statusCode, 404);
    assert.equal((await get(`${base()}/job/objects`)).json().hasPickMap, false);
  });
});
