/** Print history display helpers. */
import type { JobStatus, PrintJob } from '../../../shared/api.ts';
import { formatDuration } from './bambu.ts';
import { formatNumber, t, type MessageKey } from './i18n.ts';

/** Tone per status; the label is the `jobStatus.<status>` message. */
const JOB_STATUSES: Record<JobStatus, string> = {
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
  return formatDuration(ms / 60_000);
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
