import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.ts';
import { db } from '../server/db.ts';

/** Print history API against the real app (in-memory requests, temp database). */
let app: FastifyInstance;
let cookie = '';

const json = { 'content-type': 'application/json', 'x-requested-with': 'test' };

function addJob(printerId: number | null, name: string, status: string, startedAt: number, endedAt: number | null) {
  return Number(
    db
      .prepare(
        'INSERT INTO print_jobs (printer_id, printer_name, task, status, started_at, ended_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(printerId, name, `task ${startedAt}`, status, startedAt, endedAt, endedAt ?? startedAt).lastInsertRowid,
  );
}

let runningId = 0;
let finishedId = 0;

before(async () => {
  app = await buildApp();
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: json,
    payload: { username: 'admin', password: 'Sup3r-Secret!' },
  });
  cookie = String(res.headers['set-cookie']).split(';')[0];

  // A printer row only (no live connection is needed for history).
  db.prepare(
    "INSERT INTO printers (id, name, model, serial, ip, access_code, camera, created_at) VALUES (7, 'Workshop', 'P1S', 'SERIAL7', '127.0.0.1', 'x', 'auto', 0)",
  ).run();
  for (let i = 0; i < 30; i++) addJob(7, 'Workshop', i % 3 === 0 ? 'failed' : 'finished', i * 100_000, i * 100_000 + 60_000);
  finishedId = addJob(7, 'Workshop', 'finished', 5_000_000, 5_060_000);
  runningId = addJob(7, 'Workshop', 'running', 6_000_000, null);
  addJob(null, 'Removed printer', 'finished', 7_000_000, 7_030_000);
});

after(async () => {
  await app.close();
});

describe('history API', () => {
  it('requires authentication', async () => {
    for (const url of ['/api/history', '/api/history/stats', '/api/printers/7/history']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 401, url);
    }
  });

  it('lists all jobs newest first, paginated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/history?limit=5', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 33);
    assert.equal(body.jobs.length, 5);
    assert.equal(body.jobs[0].printerName, 'Removed printer');
    assert.equal(body.jobs[1].id, runningId);
    const next = await app.inject({ method: 'GET', url: '/api/history?limit=5&offset=5', headers: { cookie } });
    assert.ok(next.json().jobs[0].startedAt < body.jobs[4].startedAt);
  });

  it('lists the jobs of one printer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/printers/7/history?limit=100', headers: { cookie } });
    assert.equal(res.json().total, 32);
    assert.ok(res.json().jobs.every((j: any) => j.printerId === 7));
    const missing = await app.inject({ method: 'GET', url: '/api/printers/999/history', headers: { cookie } });
    assert.equal(missing.statusCode, 404);
  });

  it('clamps bad paging parameters', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/history?limit=100000&offset=-3', headers: { cookie } });
    assert.equal(res.json().jobs.length, 33);
  });

  it('reports statistics', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/history/stats', headers: { cookie } });
    const stats = res.json();
    assert.equal(stats.total, 33);
    assert.equal(stats.byStatus.failed, 10);
    assert.equal(stats.byStatus.finished, 22);
    assert.equal(stats.byStatus.running, 1);
    assert.equal(stats.successRate, 22 / 32);
    assert.equal(stats.printTimeMs, 31 * 60_000 + 30_000);
    assert.deepEqual(
      stats.printers.map((p: any) => [p.printerName, p.total]),
      [
        ['Removed printer', 1],
        ['Workshop', 32],
      ],
    );
    const one = await app.inject({ method: 'GET', url: '/api/printers/7/history/stats', headers: { cookie } });
    assert.equal(one.json().total, 32);
  });

  it('deletes a job (CSRF-protected, audited) but not one in progress', async () => {
    const noHeader = await app.inject({ method: 'DELETE', url: `/api/history/${finishedId}`, headers: { cookie } });
    assert.equal(noHeader.statusCode, 403);

    const running = await app.inject({
      method: 'DELETE',
      url: `/api/history/${runningId}`,
      headers: { cookie, 'x-requested-with': 'test' },
    });
    assert.equal(running.statusCode, 409);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/history/${finishedId}`,
      headers: { cookie, 'x-requested-with': 'test' },
    });
    assert.equal(res.statusCode, 200);
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/history/${finishedId}`,
      headers: { cookie, 'x-requested-with': 'test' },
    });
    assert.equal(again.statusCode, 404);

    const audit = await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } });
    assert.ok(audit.json().some((a: any) => a.action === 'history.delete' && a.detail.id === finishedId));
  });
});
