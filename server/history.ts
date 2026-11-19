import type { EventEmitter } from 'node:events';
import { jobSnapshot, type JobSnapshot, type PrinterEvent } from './bambu/job-events.ts';
import { db, type PrinterRow } from './db.ts';

/**
 * Print history: turns the job lifecycle events of every printer into rows of
 * `print_jobs`.
 *
 * - `job_started` opens a row. A job seen "midway" (app restart, reconnect)
 *   with the same task as the printer's open row adopts it instead of
 *   creating a duplicate; any other open row is closed as `interrupted`.
 * - `job_finished` / `job_failed` close it; pause time is accumulated.
 * - Progress (layer, percent) is written on lifecycle events and at most once
 *   a minute in between, not on every report.
 * - The printer state is also checked on every report: a row still open
 *   while the printer is IDLE / FINISH / FAILED was missed (the job ended
 *   while the app was down, or the printer went straight to IDLE) and is
 *   closed from what the printer reports.
 */

export type JobStatus = 'running' | 'paused' | 'finished' | 'failed' | 'interrupted';

export interface PrintJobRow {
  id: number;
  printer_id: number | null;
  printer_name: string;
  task: string | null;
  gcode_file: string | null;
  status: JobStatus;
  started_at: number;
  ended_at: number | null;
  updated_at: number;
  observed_midway: number;
  total_layers: number | null;
  last_layer: number | null;
  last_percent: number | null;
  remaining_minutes: number | null;
  print_error: number | null;
  paused_ms: number;
  paused_at: number | null;
}

/** Minimal view of a `PrinterConnection` (keeps the recorder testable). */
export interface WatchedPrinter extends Pick<EventEmitter, 'on' | 'off'> {
  row: Pick<PrinterRow, 'id' | 'name'>;
  state: Record<string, any>;
}

const PROGRESS_INTERVAL_MS = 60_000;
const ACTIVE = new Set(['PREPARE', 'RUNNING', 'PAUSE', 'SLICING']);
const ENDED = new Set(['IDLE', 'FINISH', 'FAILED']);

/** In-memory companion of an open (running / paused) row. */
interface OpenJob {
  id: number;
  task: string | null;
  status: 'running' | 'paused';
  pausedAt: number | null;
  /** When progress was last written to the row. */
  writtenAt: number;
  layer: number | null;
  percent: number | null;
  /** The job was seen active since the app started, so an end seen now happened now. */
  seenActive: boolean;
}

export class HistoryRecorder {
  private open = new Map<number, OpenJob>();
  private listeners = new Map<number, { target: WatchedPrinter; onEvent: (e: PrinterEvent) => void; onUpdate: () => void }>();

  /** `clock` is injectable so tests can replay reports at chosen times. */
  private clock: () => number;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** Close rows left open for printers that were removed while the app was down. */
  closeOrphans() {
    db.prepare(
      "UPDATE print_jobs SET status = 'interrupted', ended_at = updated_at, paused_at = NULL WHERE printer_id IS NULL AND status IN ('running', 'paused')",
    ).run();
  }

  watch(printer: WatchedPrinter) {
    const id = printer.row.id;
    this.unwatch(id);
    this.loadOpen(id);
    const onEvent = (event: PrinterEvent) => this.handleEvent(printer.row, event);
    const onUpdate = () => this.handleState(id, jobSnapshot(printer.state), this.clock());
    printer.on('event', onEvent);
    printer.on('update', onUpdate);
    this.listeners.set(id, { target: printer, onEvent, onUpdate });
  }

  /**
   * Stop recording a printer. Progress is flushed so a restart resumes from
   * it; `removed` (printer deleted) closes its open job as interrupted.
   */
  unwatch(printerId: number, options: { removed?: boolean } = {}, now = this.clock()) {
    const l = this.listeners.get(printerId);
    if (l) {
      l.target.off('event', l.onEvent);
      l.target.off('update', l.onUpdate);
      this.listeners.delete(printerId);
    }
    const job = this.open.get(printerId);
    if (!job) return;
    if (options.removed) this.close(printerId, 'interrupted', null, now);
    else this.writeProgress(job, null, now);
    this.open.delete(printerId);
  }

  handleEvent(printer: Pick<PrinterRow, 'id' | 'name'>, event: PrinterEvent) {
    const current = this.open.get(printer.id);
    const { job, at } = event;
    switch (event.type) {
      case 'job_started': {
        if (current && event.observedMidway && current.task === job.task) {
          current.seenActive = true;
          this.applyPauseState(current, job, at);
          this.writeProgress(current, job, at);
          return;
        }
        if (current) this.close(printer.id, 'interrupted', job, at, { sameJob: false, estimateEnd: !current.seenActive });
        this.start(printer, job, at, event.observedMidway);
        return;
      }
      case 'job_paused':
        if (current) {
          this.applyPauseState(current, job, at);
          this.writeProgress(current, job, at);
        }
        return;
      case 'job_resumed':
        if (current) {
          this.applyPauseState(current, job, at);
          this.writeProgress(current, job, at);
        }
        return;
      case 'job_finished':
        if (current) this.close(printer.id, 'finished', job, at);
        return;
      case 'job_failed':
        if (current) this.close(printer.id, 'failed', job, at);
        return;
    }
  }

  /** Called on every report: throttled progress, and closing jobs whose end was missed. */
  handleState(printerId: number, job: JobSnapshot, now = this.clock()) {
    const current = this.open.get(printerId);
    if (!current || !job.gcodeState) return;
    if (ACTIVE.has(job.gcodeState)) {
      current.seenActive = true;
      const changed = job.layer !== current.layer || job.percent !== current.percent;
      if (changed && now - current.writtenAt >= PROGRESS_INTERVAL_MS) this.writeProgress(current, job, now);
      return;
    }
    if (!ENDED.has(job.gcodeState)) return;
    const sameJob = job.task === current.task;
    const status: JobStatus =
      sameJob && job.gcodeState === 'FINISH' ? 'finished' : sameJob && job.gcodeState === 'FAILED' ? 'failed' : 'interrupted';
    this.close(printerId, status, sameJob ? job : null, now, { estimateEnd: !current.seenActive });
  }

  private loadOpen(printerId: number) {
    const rows = db
      .prepare("SELECT * FROM print_jobs WHERE printer_id = ? AND status IN ('running', 'paused') ORDER BY id DESC")
      .all(printerId) as unknown as PrintJobRow[];
    const [latest, ...stale] = rows;
    // Only one job can be open per printer; anything older lost track of its end.
    for (const row of stale) {
      db.prepare("UPDATE print_jobs SET status = 'interrupted', ended_at = updated_at, paused_at = NULL WHERE id = ?").run(row.id);
    }
    if (!latest) return;
    this.open.set(printerId, {
      id: latest.id,
      task: latest.task,
      status: latest.status as 'running' | 'paused',
      pausedAt: latest.paused_at,
      writtenAt: latest.updated_at,
      layer: latest.last_layer,
      percent: latest.last_percent,
      seenActive: false,
    });
  }

  private start(printer: Pick<PrinterRow, 'id' | 'name'>, job: JobSnapshot, at: number, observedMidway: boolean) {
    const paused = job.gcodeState === 'PAUSE';
    const result = db
      .prepare(
        `INSERT INTO print_jobs (printer_id, printer_name, task, gcode_file, status, started_at, updated_at, observed_midway,
           total_layers, last_layer, last_percent, remaining_minutes, paused_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        printer.id,
        printer.name,
        job.task,
        job.gcodeFile,
        paused ? 'paused' : 'running',
        at,
        at,
        observedMidway ? 1 : 0,
        job.totalLayers,
        job.layer,
        job.percent,
        job.remainingMinutes,
        paused ? at : null,
      );
    this.open.set(printer.id, {
      id: Number(result.lastInsertRowid),
      task: job.task,
      status: paused ? 'paused' : 'running',
      pausedAt: paused ? at : null,
      writtenAt: at,
      layer: job.layer,
      percent: job.percent,
      seenActive: true,
    });
  }

  /** Track pause/resume from the reported state; pause time is folded into paused_ms on resume. */
  private applyPauseState(job: OpenJob, snapshot: JobSnapshot, at: number) {
    if (snapshot.gcodeState === 'PAUSE' && job.status !== 'paused') {
      job.status = 'paused';
      job.pausedAt = at;
    } else if (snapshot.gcodeState !== 'PAUSE' && job.status === 'paused') {
      this.endPause(job, at);
    }
  }

  private endPause(job: OpenJob, at: number) {
    if (job.pausedAt !== null) {
      db.prepare('UPDATE print_jobs SET paused_ms = paused_ms + ? WHERE id = ?').run(Math.max(0, at - job.pausedAt), job.id);
    }
    job.status = 'running';
    job.pausedAt = null;
  }

  private writeProgress(job: OpenJob, snapshot: JobSnapshot | null, at: number) {
    if (snapshot) {
      job.layer = snapshot.layer ?? job.layer;
      job.percent = snapshot.percent ?? job.percent;
    }
    db.prepare(
      `UPDATE print_jobs SET status = ?, paused_at = ?, updated_at = ?,
         last_layer = COALESCE(?, last_layer), last_percent = COALESCE(?, last_percent),
         total_layers = COALESCE(?, total_layers), remaining_minutes = COALESCE(?, remaining_minutes),
         print_error = COALESCE(?, print_error)
       WHERE id = ?`,
    ).run(
      job.status,
      job.pausedAt,
      at,
      job.layer,
      job.percent,
      snapshot?.totalLayers ?? null,
      snapshot?.remainingMinutes ?? null,
      snapshot?.printError || null,
      job.id,
    );
    job.writtenAt = at;
  }

  /**
   * Close the printer's open job. `estimateEnd`: the end happened while the
   * app wasn't watching, so use the last observation (plus the remaining time
   * it predicted, for a finished job) rather than now.
   */
  private close(
    printerId: number,
    status: JobStatus,
    snapshot: JobSnapshot | null,
    at: number,
    options: { sameJob?: boolean; estimateEnd?: boolean } = {},
  ) {
    const job = this.open.get(printerId);
    if (!job) return;
    this.open.delete(printerId);
    const row = db.prepare('SELECT updated_at, remaining_minutes FROM print_jobs WHERE id = ?').get(job.id) as
      | { updated_at: number; remaining_minutes: number | null }
      | undefined;
    if (!row) return; // deleted meanwhile
    let endedAt = at;
    if (options.estimateEnd) {
      endedAt = status === 'finished' ? Math.min(at, row.updated_at + (row.remaining_minutes ?? 0) * 60_000) : row.updated_at;
    }
    if (job.status === 'paused') this.endPause(job, endedAt);
    // A snapshot of the *next* job (interrupted by a new one) must not overwrite this one's progress.
    const own = options.sameJob === false ? null : snapshot;
    this.writeProgress(job, own, endedAt);
    if (status === 'finished') {
      // The final report doesn't always reach 100% / the last layer before FINISH.
      db.prepare('UPDATE print_jobs SET last_percent = 100, last_layer = COALESCE(total_layers, last_layer) WHERE id = ?').run(job.id);
    }
    db.prepare('UPDATE print_jobs SET status = ?, ended_at = ?, paused_at = NULL WHERE id = ?').run(status, endedAt, job.id);
  }
}

export const history = new HistoryRecorder();

// ---------------------------------------------------------------- queries

export interface PrintJob {
  id: number;
  printerId: number | null;
  printerName: string;
  task: string | null;
  gcodeFile: string | null;
  status: JobStatus;
  startedAt: number;
  endedAt: number | null;
  observedMidway: boolean;
  totalLayers: number | null;
  lastLayer: number | null;
  lastPercent: number | null;
  printError: number | null;
  pausedMs: number;
  /** Time spent printing (excluding pauses); for open jobs, up to now. */
  durationMs: number;
}

function toJob(r: PrintJobRow & { current_name: string | null }, now: number): PrintJob {
  const end = r.ended_at ?? now;
  const pausedMs = r.paused_ms + (r.paused_at !== null && r.ended_at === null ? Math.max(0, now - r.paused_at) : 0);
  return {
    id: r.id,
    printerId: r.printer_id,
    // Follow renames while the printer exists.
    printerName: r.current_name ?? r.printer_name,
    task: r.task,
    gcodeFile: r.gcode_file,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    observedMidway: Boolean(r.observed_midway),
    totalLayers: r.total_layers,
    lastLayer: r.last_layer,
    lastPercent: r.last_percent,
    printError: r.print_error,
    pausedMs,
    durationMs: Math.max(0, end - r.started_at - pausedMs),
  };
}

export function listJobs(options: { printerId?: number; limit: number; offset: number }, now = Date.now()) {
  const where = options.printerId === undefined ? '' : 'WHERE j.printer_id = ?';
  const params = options.printerId === undefined ? [] : [options.printerId];
  const rows = db
    .prepare(
      `SELECT j.*, p.name AS current_name FROM print_jobs j LEFT JOIN printers p ON p.id = j.printer_id
       ${where} ORDER BY j.started_at DESC, j.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, options.limit, options.offset) as unknown as (PrintJobRow & { current_name: string | null })[];
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM print_jobs j ${where}`).get(...params) as { total: number };
  return { jobs: rows.map((r) => toJob(r, now)), total };
}

export function getJob(id: number) {
  return db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id) as unknown as PrintJobRow | undefined;
}

export function deleteJob(id: number) {
  return db.prepare('DELETE FROM print_jobs WHERE id = ?').run(id).changes > 0;
}

export interface JobStats {
  total: number;
  byStatus: Record<JobStatus, number>;
  /**
   * finished / (finished + failed). Interrupted jobs are left out: their
   * outcome is unknown (the app lost track of them). null without data.
   */
  successRate: number | null;
  /** Printing time of ended jobs, pauses excluded. */
  printTimeMs: number;
}

function emptyStats(): JobStats {
  return { total: 0, byStatus: { running: 0, paused: 0, finished: 0, failed: 0, interrupted: 0 }, successRate: null, printTimeMs: 0 };
}

function addStatusRow(stats: JobStats, r: { status: JobStatus; n: number; ms: number | null }) {
  if (r.status in stats.byStatus) stats.byStatus[r.status] += r.n;
  stats.total += r.n;
  stats.printTimeMs += r.ms ?? 0;
  const decided = stats.byStatus.finished + stats.byStatus.failed;
  stats.successRate = decided ? stats.byStatus.finished / decided : null;
}

/** Totals, plus a breakdown per printer (jobs of removed printers are grouped by their name). */
export function jobStats(printerId?: number) {
  const where = printerId === undefined ? '' : 'WHERE j.printer_id = ?';
  const rows = db
    .prepare(
      `SELECT j.printer_id, COALESCE(p.name, j.printer_name) AS name, j.status, COUNT(*) AS n,
         SUM(CASE WHEN j.ended_at IS NOT NULL THEN MAX(0, j.ended_at - j.started_at - j.paused_ms) END) AS ms
       FROM print_jobs j LEFT JOIN printers p ON p.id = j.printer_id
       ${where} GROUP BY j.printer_id, name, j.status`,
    )
    .all(...(printerId === undefined ? [] : [printerId])) as {
    printer_id: number | null;
    name: string;
    status: JobStatus;
    n: number;
    ms: number | null;
  }[];
  const overall = emptyStats();
  const perPrinter = new Map<string, JobStats & { printerId: number | null; printerName: string }>();
  for (const r of rows) {
    addStatusRow(overall, r);
    const key = r.printer_id === null ? `name:${r.name}` : `id:${r.printer_id}`;
    let entry = perPrinter.get(key);
    if (!entry) perPrinter.set(key, (entry = { printerId: r.printer_id, printerName: r.name, ...emptyStats() }));
    addStatusRow(entry, r);
  }
  return {
    ...overall,
    printers: [...perPrinter.values()].sort((a, b) => a.printerName.localeCompare(b.printerName)),
  };
}
