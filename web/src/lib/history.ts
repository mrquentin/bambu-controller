/** Print history types (mirror server/history.ts) and display helpers. */

export type JobStatus = 'running' | 'paused' | 'finished' | 'failed' | 'interrupted';

export interface PrintJob {
  id: number;
  printerId: number | null;
  printerName: string;
  task: string | null;
  gcodeFile: string | null;
  status: JobStatus;
  startedAt: number;
  endedAt: number | null;
  /** Already running when the app first saw it: the real start is earlier. */
  observedMidway: boolean;
  totalLayers: number | null;
  lastLayer: number | null;
  lastPercent: number | null;
  printError: number | null;
  pausedMs: number;
  durationMs: number;
}

export interface JobStats {
  total: number;
  byStatus: Record<JobStatus, number>;
  successRate: number | null;
  printTimeMs: number;
}

export interface HistoryStats extends JobStats {
  printers: (JobStats & { printerId: number | null; printerName: string })[];
}

export const JOB_STATUSES: Record<JobStatus, { label: string; tone: string }> = {
  running: { label: 'Printing', tone: 'accent' },
  paused: { label: 'Paused', tone: 'warn' },
  finished: { label: 'Finished', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  interrupted: { label: 'Interrupted', tone: 'muted' },
};

export function jobStatusInfo(status: string) {
  return JOB_STATUSES[status as JobStatus] ?? { label: status, tone: 'muted' };
}

/** Milliseconds as "2h 05m" / "12m" / "45s". */
export function formatMs(ms: number | null | undefined) {
  if (ms === null || ms === undefined || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
}

export function formatRate(rate: number | null) {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/** "42 / 150" layers, falling back to the percentage. */
export function jobProgress(job: Pick<PrintJob, 'lastLayer' | 'totalLayers' | 'lastPercent'>) {
  if (job.totalLayers) return `${job.lastLayer ?? 0} / ${job.totalLayers}`;
  if (job.lastPercent !== null) return `${job.lastPercent}%`;
  return '—';
}
