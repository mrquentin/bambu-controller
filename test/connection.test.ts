import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { IClientOptions, MqttClient } from 'mqtt';
import type { PrinterRow } from '../server/db.ts';
import { nextDelay } from '../server/bambu/backoff.ts';
import { DEFAULT_TIMING, PrinterConnection } from '../server/bambu/printer.ts';

const row: PrinterRow = {
  id: 1,
  name: 'Test',
  model: 'P1S',
  serial: '01P00A000000001',
  ip: '127.0.0.1',
  access_code: '12345678',
  camera: 'auto',
  tls_verify: 0,
  created_at: 0,
};

describe('nextDelay (backoff with full jitter)', () => {
  const opts = { base: 2_000, cap: 60_000 };

  it('doubles the ceiling per attempt up to the cap', () => {
    const max = [0, 1, 2, 3, 4, 5, 6, 10].map((a) => nextDelay(a, () => 1, opts));
    assert.deepEqual(max, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it('never goes below the base delay', () => {
    for (const a of [0, 3, 50]) assert.equal(nextDelay(a, () => 0, opts), 2_000);
    assert.equal(nextDelay(3, () => 0.5, opts), 9_000);
  });

  it('jumps close to the cap after an authentication failure', () => {
    assert.equal(nextDelay(0, () => 0, { ...opts, authFailed: true }), 30_000);
    assert.equal(nextDelay(0, () => 1, { ...opts, authFailed: true }), 60_000);
  });
});

/** Minimal stand-in for an mqtt.js client. */
class FakeClient extends EventEmitter {
  connected = false;
  ended = false;
  published: unknown[] = [];
  subscribe(_topic: string, _opts: unknown, cb: (err: Error | null) => void) {
    cb(null);
  }
  async publishAsync(_topic: string, body: string) {
    this.published.push(JSON.parse(body));
  }
  end() {
    this.ended = true;
    this.connected = false;
  }
  open() {
    this.connected = true;
    this.emit('connect');
  }
  drop() {
    this.connected = false;
    this.emit('close');
  }
  report(patch: Record<string, unknown> = {}) {
    this.emit('message', 'report', Buffer.from(JSON.stringify({ print: { command: 'push_status', ...patch } })));
  }
  pushalls() {
    return this.published.filter((p: any) => p.pushing?.command === 'pushall').length;
  }
}

describe('PrinterConnection reconnects and silence detection', () => {
  let clients: FakeClient[];
  let conn: PrinterConnection;
  const last = () => clients.at(-1)!;
  const make = (random = () => 1) =>
    new PrinterConnection(row, {
      random,
      connect: () => {
        const c = new FakeClient();
        clients.push(c);
        return c as unknown as MqttClient;
      },
    });

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
    clients = [];
  });
  afterEach(() => {
    conn?.stop();
    mock.timers.reset();
  });

  it('grows the delay per failed attempt, caps it and exposes nextRetryAt', () => {
    conn = make();
    conn.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      last().drop();
      assert.equal(conn.status, 'offline');
      const delay = conn.nextRetryAt - Date.now();
      delays.push(delay);
      assert.equal(conn.snapshot().connection.nextRetryAt, conn.nextRetryAt);
      mock.timers.tick(delay - 1);
      assert.equal(clients.length, i + 1, 'no retry before the delay');
      mock.timers.tick(1);
      assert.equal(clients.length, i + 2);
      assert.equal(conn.nextRetryAt, 0);
      assert.equal(conn.status, 'connecting');
    }
    assert.deepEqual(delays, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    assert.ok(clients.slice(0, -1).every((c) => c.ended), 'previous clients are closed');
  });

  it('resets the backoff once a connection kept reporting for a while', () => {
    conn = make();
    conn.start();
    for (let i = 0; i < 3; i++) {
      last().drop();
      mock.timers.tick(conn.nextRetryAt - Date.now());
    }
    last().open();
    last().report();
    // Short-lived connection: backoff keeps growing.
    last().drop();
    assert.equal(conn.nextRetryAt - Date.now(), 16_000);
    mock.timers.tick(16_000);
    last().open();
    for (let t = 0; t <= DEFAULT_TIMING.stableAfterMs; t += 5_000) {
      last().report();
      mock.timers.tick(5_000);
    }
    last().drop();
    assert.equal(conn.nextRetryAt - Date.now(), 2_000);
  });

  it('backs off to the cap range right after an authentication failure', () => {
    conn = make(() => 0);
    conn.start();
    last().emit('error', new Error('Connection refused: Not authorized'));
    assert.equal(conn.status, 'error');
    assert.match(conn.error!, /access code/);
    assert.equal(conn.nextRetryAt - Date.now(), 30_000);
    // The following close must not schedule a second timer.
    last().emit('close');
    mock.timers.tick(30_000);
    assert.equal(clients.length, 2);
    assert.equal(conn.status, 'error', 'keeps showing the error while retrying');
  });

  it('requests pushall, flags stale data, then forces a reconnect', () => {
    conn = make();
    conn.start();
    const c = last();
    c.open();
    c.report();
    assert.equal(c.pushalls(), 1, 'pushall on connect');

    mock.timers.tick(30_000);
    assert.equal(c.pushalls(), 2, 'pushall after 30 s of silence');
    assert.equal(conn.stale, false);
    mock.timers.tick(25_000);
    assert.equal(c.pushalls(), 2, 'not more than every 30 s');
    mock.timers.tick(5_000);
    assert.equal(conn.stale, true);
    assert.equal(conn.status, 'online');
    assert.equal(conn.summary().connection.stale, true);

    c.report();
    assert.equal(conn.stale, false, 'a report clears the flag');

    mock.timers.tick(DEFAULT_TIMING.reconnectAfterMs);
    assert.ok(c.ended, 'silent connection dropped');
    assert.equal(conn.stale, false);
    assert.equal(conn.status, 'offline');
    assert.match(conn.error!, /No data/);
    assert.ok(conn.nextRetryAt > Date.now());
    mock.timers.tick(conn.nextRetryAt - Date.now());
    assert.equal(clients.length, 2);
    last().open();
    assert.equal(conn.error, null);
  });

  it('stop() and update() cancel pending timers without leaking clients', () => {
    conn = make();
    conn.start();
    last().drop();
    assert.ok(conn.nextRetryAt);
    conn.stop();
    assert.equal(conn.nextRetryAt, 0);
    mock.timers.tick(10 * 60_000);
    assert.equal(clients.length, 1, 'no retry after stop');

    conn.start();
    last().drop();
    conn.update({ ...row, ip: '127.0.0.2' });
    assert.equal(clients.length, 3);
    mock.timers.tick(10 * 60_000);
    assert.equal(clients.length, 3, 'pending retry cancelled by update');
    assert.ok(clients.slice(0, -1).every((c) => c.ended));

    // Watchdog is cancelled too: a silent connection is not touched after stop().
    last().open();
    conn.stop();
    mock.timers.tick(10 * 60_000);
    assert.equal(clients.length, 3);
    assert.equal(conn.status, 'offline');
  });
});
