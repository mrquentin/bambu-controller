import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it } from 'node:test';
import { JobTracker, jobSnapshot } from '../server/bambu/job-events.ts';
import { db } from '../server/db.ts';
import { HistoryRecorder, jobStats, listJobs } from '../server/history.ts';

/**
 * Drives the recorder the way PrinterConnection does: merge a report into the
 * state, emit the detected lifecycle events, then `update`.
 */
class FakePrinter extends EventEmitter {
  row: { id: number; name: string };
  state: Record<string, any> = {};
  private jobs = new JobTracker();

  constructor(id: number, name: string) {
    super();
    this.row = { id, name };
  }

  report(patch: Record<string, unknown>, at: number) {
    now = at;
    Object.assign(this.state, patch);
    for (const event of this.jobs.observe(this.state, at).events) this.emit('event', event);
    this.emit('update');
  }

  /** What the app sees after a restart: no previous snapshot. */
  forget() {
    this.jobs.reset();
  }
}

/** Recorder clock, set to the time of the report being replayed. */
let now = 0;
const clock = () => now;

let nextId = 1;
function addPrinter(name: string) {
  const id = nextId++;
  db.prepare(
    "INSERT INTO printers (id, name, model, serial, ip, access_code, camera, created_at) VALUES (?, ?, 'P1S', ?, '127.0.0.1', 'x', 'auto', 0)",
  ).run(id, name, `SERIAL${id}`);
  return new FakePrinter(id, name);
}

const jobs = (printerId: number) => listJobs({ printerId, limit: 100, offset: 0 }).jobs;

describe('print history recorder', () => {
  beforeEach(() => db.exec('DELETE FROM print_jobs'));

  it('records a print from start to finish, with pause time', () => {
    const recorder = new HistoryRecorder(clock);
    const p = addPrinter('A');
    recorder.watch(p);
    p.report({ gcode_state: 'IDLE' }, 0);
    p.report({ gcode_state: 'PREPARE', subtask_name: 'Benchy', total_layer_num: 100, layer_num: 0, mc_percent: 0 }, 1_000);
    p.report({ gcode_state: 'RUNNING', layer_num: 10, mc_percent: 10 }, 2_000);
    p.report({ gcode_state: 'PAUSE' }, 10_000);
    assert.equal(jobs(p.row.id)[0].status, 'paused');
    p.report({ gcode_state: 'RUNNING' }, 40_000);
    p.report({ gcode_state: 'FINISH', layer_num: 99, mc_percent: 99 }, 100_000);

    const [job] = jobs(p.row.id);
    assert.equal(job.status, 'finished');
    assert.equal(job.task, 'Benchy');
    assert.equal(job.startedAt, 1_000);
    assert.equal(job.endedAt, 100_000);
    assert.equal(job.pausedMs, 30_000);
    assert.equal(job.durationMs, 69_000);
    assert.equal(job.lastPercent, 100);
    assert.equal(job.lastLayer, 100);
    assert.equal(job.observedMidway, false);
  });

  it('records failures with the error code', () => {
    const recorder = new HistoryRecorder(clock);
    const p = addPrinter('B');
    recorder.watch(p);
    p.report({ gcode_state: 'IDLE' }, 0);
    p.report({ gcode_state: 'RUNNING', subtask_name: 'Vase', layer_num: 5 }, 1_000);
    p.report({ gcode_state: 'FAILED', print_error: 50348044 }, 5_000);
    const [job] = jobs(p.row.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.printError, 50348044);
    assert.equal(job.lastLayer, 5);
  });

  it('adopts the open job after an app restart instead of duplicating it', () => {
    const p = addPrinter('C');
    const first = new HistoryRecorder(clock);
    first.watch(p);
    p.report({ gcode_state: 'IDLE' }, 0);
    p.report({ gcode_state: 'RUNNING', subtask_name: 'Cube', layer_num: 3 }, 1_000);
    first.unwatch(p.row.id, {}, 2_000); // shutdown

    p.forget();
    const second = new HistoryRecorder(clock);
    second.watch(p);
    p.report({ gcode_state: 'RUNNING', layer_num: 40 }, 60_000);
    p.report({ gcode_state: 'FINISH' }, 90_000);

    const list = jobs(p.row.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'finished');
    assert.equal(list[0].startedAt, 1_000);
    assert.equal(list[0].endedAt, 90_000);
  });

  it('closes the open job as interrupted when a different job is found after a restart', () => {
    const p = addPrinter('D');
    const first = new HistoryRecorder(clock);
    first.watch(p);
    p.report({ gcode_state: 'IDLE' }, 0);
    p.report({ gcode_state: 'RUNNING', subtask_name: 'Old' }, 1_000);
    first.unwatch(p.row.id, {}, 2_000);

    p.forget();
    const second = new HistoryRecorder(clock);
    second.watch(p);
    p.report({ gcode_state: 'RUNNING', subtask_name: 'New' }, 60_000);

    const [newer, older] = jobs(p.row.id);
    assert.equal(older.task, 'Old');
    assert.equal(older.status, 'interrupted');
    assert.equal(older.endedAt, 2_000, 'ended at the last observation, not at the restart');
    assert.equal(newer.task, 'New');
    assert.equal(newer.status, 'running');
    assert.equal(newer.observedMidway, true);
  });

  it('closes the previous job as interrupted when a new one starts back to back', () => {
    const recorder = new HistoryRecorder(clock);
    const p = addPrinter('E');
    recorder.watch(p);
    p.report({ gcode_state: 'IDLE' }, 0);
    p.report({ gcode_state: 'RUNNING', subtask_name: 'One', layer_num: 7 }, 1_000);
    p.report({ gcode_state: 'RUNNING', subtask_name: 'Two', layer_num: 1 }, 5_000);
    const [two, one] = jobs(p.row.id);
    assert.equal(one.status, 'interrupted');
    assert.equal(one.endedAt, 5_000);
    assert.equal(one.lastLayer, 7, "the new job's progress must not leak into the old row");
    assert.equal(two.status, 'running');
  });

  it('closes a job that ended while the app was down from the state the printer reports', () => {
    const p = addPrinter('F');
    const first = new HistoryRecorder(clock);
    first.watch(p);
    p.report({ gcode_state: 'IDLE' }, 0);
    p.report({ gcode_state: 'RUNNING', subtask_name: 'Gear', mc_remaining_time: 10 }, 1_000);
    first.unwatch(p.row.id, {}, 2_000);

    p.forget();
    const second = new HistoryRecorder(clock);
    second.watch(p);
    p.report({ gcode_state: 'FINISH' }, 3_600_000);
    const [job] = jobs(p.row.id);
    assert.equal(job.status, 'finished');
    // Last observation + the remaining time it predicted, not the time of the restart.
    assert.equal(job.endedAt, 2_000 + 10 * 60_000);
  });

  it('marks a job interrupted when the printer goes straight back to idle', () => {
    const recorder = new HistoryRecorder(clock);
    const p = addPrinter('G');
    recorder.watch(p);
    p.report({ gcode_state: 'IDLE' }, 0);
    p.report({ gcode_state: 'RUNNING', subtask_name: 'Clip' }, 1_000);
    p.report({ gcode_state: 'IDLE' }, 9_000);
    const [job] = jobs(p.row.id);
    assert.equal(job.status, 'interrupted');
    assert.equal(job.endedAt, 9_000);
  });

  it('throttles progress writes', () => {
    const recorder = new HistoryRecorder(clock);
    const p = addPrinter('H');
    recorder.watch(p);
    p.report({ gcode_state: 'IDLE' }, 0);
    p.report({ gcode_state: 'RUNNING', subtask_name: 'Big', layer_num: 1 }, 1_000);
    recorder.handleState(p.row.id, jobSnapshot({ ...p.state, layer_num: 2 }), 30_000);
    assert.equal(jobs(p.row.id)[0].lastLayer, 1);
    recorder.handleState(p.row.id, jobSnapshot({ ...p.state, layer_num: 3 }), 61_000);
    assert.equal(jobs(p.row.id)[0].lastLayer, 3);
  });

  it('keeps jobs of removed printers and closes their open job', () => {
    const recorder = new HistoryRecorder(clock);
    const p = addPrinter('Gone');
    recorder.watch(p);
    p.report({ gcode_state: 'IDLE' }, 0);
    p.report({ gcode_state: 'RUNNING', subtask_name: 'Last' }, 1_000);
    recorder.unwatch(p.row.id, { removed: true }, 5_000);
    db.prepare('DELETE FROM printers WHERE id = ?').run(p.row.id);
    p.report({ gcode_state: 'FINISH' }, 6_000); // no longer listened to

    const job = listJobs({ limit: 100, offset: 0 }).jobs.find((j) => j.task === 'Last')!;
    assert.equal(job.printerId, null);
    assert.equal(job.printerName, 'Gone');
    assert.equal(job.status, 'interrupted');
  });

  it('computes statistics per status and per printer', () => {
    const recorder = new HistoryRecorder(clock);
    const a = addPrinter('Stats A');
    const b = addPrinter('Stats B');
    recorder.watch(a);
    recorder.watch(b);
    for (const [p, end, t] of [
      [a, 'FINISH', 0],
      [a, 'FAILED', 100_000],
      [b, 'FINISH', 200_000],
    ] as const) {
      p.report({ gcode_state: 'IDLE' }, t);
      p.report({ gcode_state: 'RUNNING', subtask_name: `job ${t}` }, t + 1_000);
      p.report({ gcode_state: end }, t + 11_000);
    }
    const stats = jobStats();
    assert.equal(stats.total, 3);
    assert.equal(stats.byStatus.finished, 2);
    assert.equal(stats.byStatus.failed, 1);
    assert.equal(stats.successRate, 2 / 3);
    assert.equal(stats.printTimeMs, 30_000);
    const perA = stats.printers.find((s) => s.printerId === a.row.id)!;
    assert.equal(perA.total, 2);
    assert.equal(perA.successRate, 0.5);
    assert.equal(jobStats(b.row.id).total, 1);
  });
});
