/** Print history types (mirror server/history.ts) and display helpers. */
import { formatNumber, t, type MessageKey } from './i18n.ts';

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

/** Tone per status; the label is the `jobStatus.<status>` message. */
export const JOB_STATUSES: Record<JobStatus, string> = {
  running: 'accent',
  paused: 'warn',
  finished: 'ok',
  failed: 'danger',
  interrupted: 'muted',
};

export function jobStatusInfo(status: string) {
  const tone = JOB_STATUSES[status as JobStatus];
  return tone ? { label: t(`jobStatus.${status}` as MessageKey), tone } : { label: status, tone: 'muted' };
}

/** Milliseconds as "2h 05m" / "12m" / "45s" (localized). */
export function formatMs(ms: number | null | undefined) {
  if (ms === null || ms === undefined || ms < 0) return '—';
  if (ms < 60_000) return t('duration.seconds', { s: String(Math.round(ms / 1000)) });
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0
    ? t('duration.hoursMinutes', { h: String(h), m: m.toString().padStart(2, '0') })
    : t('duration.minutes', { m: String(m) });
}

export function formatRate(rate: number | null) {
  return rate === null ? '—' : formatNumber(rate, { style: 'percent', maximumFractionDigits: 0 });
}

/** "42 / 150" layers, falling back to the percentage. */
export function jobProgress(job: Pick<PrintJob, 'lastLayer' | 'totalLayers' | 'lastPercent'>) {
  if (job.totalLayers) return `${job.lastLayer ?? 0} / ${job.totalLayers}`;
  if (job.lastPercent !== null) return t('unit.percent', { value: job.lastPercent });
  return '—';
}
