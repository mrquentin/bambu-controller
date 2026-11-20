import assert from 'node:assert/strict';
import { once, type EventEmitter } from 'node:events';
import type net from 'node:net';
import tls from 'node:tls';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Aedes } from 'aedes';
import selfsigned from 'selfsigned';
import * as cmd from '../server/bambu/commands.ts';
import type { PrinterEvent } from '../server/bambu/job-events.ts';
import { PrinterConnection, testConnection } from '../server/bambu/printer.ts';
import type { PrinterRow } from '../server/db.ts';

/**
 * Drives a real PrinterConnection (mqtt.js over TLS) against an in-process
 * MQTT broker playing the printer. The app always dials port 8883, so the
 * broker listens there on a spare loopback address (127.0.0.1 may already be
 * taken by `npm run fake-printer`).
 */

const SERIAL = '01P00A000000042';
const ACCESS_CODE = '87654321';
const REPORT = `device/${SERIAL}/report`;
const REQUEST = `device/${SERIAL}/request`;

type Json = Record<string, any>;

let broker: Aedes;
let server: tls.Server;
let host = '';
/** Messages the app sent on the request topic, in order. */
let requests: Json[] = [];
/** What the "printer" answers to pushall. */
let pushallReport: Json = {};
const connections: PrinterConnection[] = [];

const publish = (payload: Json) =>
  new Promise<void>((resolve, reject) =>
    broker.publish(
      { cmd: 'publish', topic: REPORT, payload: Buffer.from(JSON.stringify(payload)), qos: 0, retain: false, dup: false },
      (err) => (err ? reject(err) : resolve()),
    ),
  );

async function listen(srv: tls.Server): Promise<string> {
  for (const candidate of ['127.0.0.42', '127.0.0.43', '127.0.0.1']) {
    try {
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(8883, candidate, () => {
          srv.off('error', reject);
          resolve();
        });
      });
      return candidate;
    } catch {
      // address not available on this OS (e.g. macOS only has 127.0.0.1) or port taken
    }
  }
  throw new Error('could not bind an MQTT test broker on port 8883');
}

/** Resolves once `predicate` holds, checked after every `update` (and right away). */
function until(conn: PrinterConnection, predicate: () => boolean, what: string, timeoutMs = 5000) {
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!predicate()) return;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${what} (status ${conn.status}, error ${conn.error})`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      conn.off('update', check);
    };
    conn.on('update', check);
    check();
  });
}

function collectEvents(conn: EventEmitter) {
  const events: PrinterEvent[] = [];
  conn.on('event', (e: PrinterEvent) => events.push(e));
  return events;
}

function connect(overrides: Partial<PrinterRow> = {}) {
  const row: PrinterRow = {
    id: connections.length + 1,
    name: 'Test printer',
    model: 'P1S',
    serial: SERIAL,
    ip: host,
    access_code: ACCESS_CODE,
    camera: 'none',
    tls_verify: 0,
    created_at: Date.now(),
    ...overrides,
  };
  const conn = new PrinterConnection(row);
  connections.push(conn);
  conn.start();
  return conn;
}

const waitForRequest = async (predicate: (r: Json) => boolean, what: string) => {
  const deadline = Date.now() + 5000;
  while (!requests.some(predicate)) {
    if (Date.now() > deadline) throw new Error(`printer never received ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

before(async () => {
  const pems = await selfsigned.generate([{ name: 'commonName', value: SERIAL }], { keySize: 2048 });
  broker = await Aedes.createBroker();
  broker.authenticate = (_client, username, password, done) => {
    const ok = username === 'bblp' && password?.toString() === ACCESS_CODE;
    done(ok ? null : Object.assign(new Error('Bad username or password'), { returnCode: 4 }), ok);
  };
  broker.on('publish', (packet, client) => {
    if (!client || packet.topic !== REQUEST) return;
    const msg = JSON.parse(packet.payload.toString());
    requests.push(msg);
    if (msg.pushing?.command === 'pushall') void publish({ print: pushallReport });
  });
  server = tls.createServer({ key: pems.private, cert: pems.cert }, broker.handle as (socket: net.Socket) => void);
  host = await listen(server);
});

beforeEach(() => {
  requests = [];
  pushallReport = {
    command: 'push_status',
    gcode_state: 'RUNNING',
    subtask_name: 'Benchy',
    gcode_file: '/data/Metadata/plate_1.gcode',
    mc_percent: 12,
    layer_num: 18,
    total_layer_num: 150,
    nozzle_temper: 219.8,
    bed_temper: 54.9,
    hms: [],
    ams: {
      ams: [
        {
          id: '0',
          humidity: '4',
          tray: [
            { id: '0', tray_type: 'PLA', remain: 80 },
            { id: '1', tray_type: 'PETG', remain: 45 },
          ],
        },
      ],
    },
  };
  for (const conn of connections.splice(0)) conn.stop();
});

after(async () => {
  for (const conn of connections.splice(0)) conn.stop();
  server.close();
  await new Promise<void>((resolve) => broker.close(() => resolve()));
});

describe('PrinterConnection against an MQTT broker', () => {
  it('connects, subscribes and asks for the version and a full status', async () => {
    const conn = connect();
    await until(conn, () => conn.status === 'online' && conn.state.gcode_state === 'RUNNING', 'pushall report');
    await waitForRequest((r) => r.info?.command === 'get_version', 'get_version');
    assert.ok(requests.some((r) => r.pushing?.command === 'pushall'));
    assert.equal(conn.state.subtask_name, 'Benchy');
    assert.ok(conn.lastReportAt > 0);
    assert.equal(conn.summary().percent, 12);
    assert.equal(conn.summary().nozzle, 220);
    assert.equal('access_code' in conn.snapshot().printer, false, 'the access code never leaves the server');
  });

  it('merges partial reports into the accumulated state and emits update', async () => {
    const conn = connect();
    await until(conn, () => conn.state.gcode_state === 'RUNNING', 'pushall report');

    let updates = 0;
    conn.on('update', () => updates++);
    await publish({ print: { command: 'push_status', nozzle_temper: 221.5 } });
    await publish({ print: { command: 'push_status', mc_percent: 13 } });
    await publish({ print: { command: 'push_status', ams: { ams: [{ id: '0', tray: [{ id: '1', remain: 40 }] }] } } });
    await until(conn, () => conn.state.ams.ams[0].tray[0].remain === 40, 'AMS delta');

    assert.ok(updates >= 3);
    assert.equal(conn.state.nozzle_temper, 221.5);
    assert.equal(conn.state.mc_percent, 13);
    assert.equal(conn.state.bed_temper, 54.9, 'fields absent from deltas are kept');
    assert.equal(conn.state.subtask_name, 'Benchy');
    assert.deepEqual(conn.state.ams.ams[0].tray[0], { id: '1', tray_type: 'PETG', remain: 40 });
    assert.equal(conn.state.ams.ams[0].humidity, '4');
  });

  it('emits lifecycle events as the job progresses', async () => {
    const conn = connect();
    const events = collectEvents(conn);
    await until(conn, () => events.length >= 1, 'first event');
    assert.equal(events[0].type, 'job_started');
    assert.equal(events[0].type === 'job_started' && events[0].observedMidway, true);
    assert.equal(events[0].job.task, 'Benchy');

    const step = async (patch: Json, type: PrinterEvent['type']) => {
      const count = events.length;
      await publish({ print: { command: 'push_status', ...patch } });
      await until(conn, () => events.length > count, type);
      assert.equal(events.at(-1)!.type, type);
      return events.at(-1)!;
    };

    const paused = await step({ gcode_state: 'PAUSE', print_error: 0x07008011 }, 'job_paused');
    assert.equal(paused.type === 'job_paused' && paused.printError, 0x07008011);
    await step({ gcode_state: 'RUNNING', print_error: 0 }, 'job_resumed');
    const hms = await step({ hms: [{ attr: 0x03001000, code: 0x00020001 }] }, 'hms_raised');
    assert.deepEqual(hms.type === 'hms_raised' && hms.alerts, [{ attr: 0x03001000, code: 0x00020001 }]);
    const finished = await step({ gcode_state: 'FINISH', mc_percent: 100 }, 'job_finished');
    assert.equal(finished.job.percent, 100);
    assert.equal(finished.job.task, 'Benchy', 'the snapshot carries fields from earlier reports');
    const started = await step({ gcode_state: 'PREPARE', subtask_name: 'Cube', mc_percent: 0 }, 'job_started');
    assert.equal(started.type === 'job_started' && started.observedMidway, false);
    await step({ gcode_state: 'FAILED', print_error: 0x0300400c }, 'job_failed');

    // A report without a state change emits nothing.
    const count = events.length;
    await publish({ print: { command: 'push_status', nozzle_temper: 30 } });
    await until(conn, () => conn.state.nozzle_temper === 30, 'temperature delta');
    assert.equal(events.length, count);
  });

  it('waits for a report carrying gcode_state before taking the event baseline', async () => {
    pushallReport = { command: 'push_status', nozzle_temper: 25 };
    const conn = connect();
    const events = collectEvents(conn);
    await until(conn, () => conn.state.nozzle_temper === 25, 'first report');
    await publish({ print: { command: 'push_status', gcode_state: 'IDLE' } });
    await publish({ print: { command: 'push_status', gcode_state: 'PREPARE', subtask_name: 'Clip' } });
    await until(conn, () => events.length > 0, 'job_started');
    assert.deepEqual(
      events.map((e) => e.type),
      ['job_started'],
    );
    assert.equal(events[0].type === 'job_started' && events[0].observedMidway, false);
  });

  it('records command replies in the log without merging them into the state', async () => {
    const conn = connect();
    await until(conn, () => conn.state.gcode_state === 'RUNNING', 'pushall report');
    await conn.send(cmd.pause());
    await waitForRequest((r) => r.print?.command === 'pause', 'pause');
    await publish({ print: { command: 'pause', result: 'success', reason: '' } });
    await until(conn, () => conn.log.some((e) => e.direction === 'in' && e.command === 'pause'), 'pause reply');
    assert.ok(conn.log.some((e) => e.direction === 'out' && e.command === 'pause'));
    assert.equal(conn.state.result, undefined);
    assert.equal(conn.state.gcode_state, 'RUNNING');
  });

  it('stores firmware modules from get_version', async () => {
    const conn = connect();
    await until(conn, () => conn.state.gcode_state === 'RUNNING', 'pushall report');
    await publish({ info: { command: 'get_version', module: [{ name: 'ota', sw_ver: '01.08.02.00' }] } });
    await until(conn, () => conn.modules.length === 1, 'modules');
    assert.equal(conn.modules[0].sw_ver, '01.08.02.00');
  });

  it('ignores payloads that are not JSON', async () => {
    const conn = connect();
    await until(conn, () => conn.state.gcode_state === 'RUNNING', 'pushall report');
    await new Promise<void>((resolve) =>
      broker.publish(
        { cmd: 'publish', topic: REPORT, payload: Buffer.from('not json'), qos: 0, retain: false, dup: false },
        () => resolve(),
      ),
    );
    await publish({ print: { command: 'push_status', mc_percent: 14 } });
    await until(conn, () => conn.state.mc_percent === 14, 'next report');
    assert.equal(conn.status, 'online');
  });

  it('reports a wrong access code', async () => {
    const conn = connect({ access_code: '00000000' });
    await until(conn, () => conn.status === 'error', 'auth error');
    assert.match(conn.error!, /access code/);
  });

  it('rejects a certificate not signed by the Bambu CA when verification is on', async () => {
    const conn = connect({ tls_verify: 1 });
    await until(conn, () => conn.status === 'error', 'TLS error');
    assert.match(conn.error!, /could not be verified against the Bambu Lab CA/);
    conn.stop();
  });

  it('goes offline when stopped and stops sending', async () => {
    const conn = connect();
    await until(conn, () => conn.status === 'online', 'connection');
    const offline = once(conn, 'update');
    conn.stop();
    await offline;
    assert.equal(conn.status, 'offline');
    await assert.rejects(conn.send(cmd.pushAll()), /not connected/);
  });
});

describe('testConnection', () => {
  it('succeeds once the printer answers', async () => {
    assert.deepEqual(await testConnection({ ip: host, serial: SERIAL, access_code: ACCESS_CODE, tls_verify: 0 }, 5000), { ok: true });
  });

  it('explains a wrong access code', async () => {
    assert.deepEqual(await testConnection({ ip: host, serial: SERIAL, access_code: '00000000', tls_verify: 0 }, 5000), { ok: false, error: 'Wrong access code (it changes when LAN mode is toggled).' });
  });
});
