<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { api } from '../lib/api';
  import { printerPage } from '../../../shared/pages.ts';
  import { jobOpen, type HistoryStats, type JobPage, type PrintJob } from '../../../shared/api.ts';
  import { formatMs, formatRate, jobProgress, jobStatusInfo } from '../lib/history';
  import { toast, toastError } from '../lib/toast.svelte';
  import { formatDate, t } from '../lib/i18n.svelte';
  import { confirmAction } from '../lib/confirm.svelte';

  /**
   * Statistics and job list, for one printer or (without `printerId`) all of
   * them. Changing `refreshKey` (e.g. the printer's gcode state) reloads.
   */
  let { printerId, refreshKey }: { printerId?: number; refreshKey?: unknown } = $props();

  const PAGE = 25;
  const base = $derived(printerId === undefined ? '/api/history' : `/api/printers/${printerId}/history`);

  let stats = $state<HistoryStats | null>(null);
  let jobs = $state<PrintJob[]>([]);
  let total = $state(0);
  let error = $state<string | null>(null);
  let loadingMore = $state(false);

  /** Reload stats and every job shown so far (keeps "load more" pages). */
  async function load() {
    try {
      const [s, list] = await Promise.all([
        api<HistoryStats>(`${base}/stats`),
        api<JobPage>(`${base}?limit=${Math.max(PAGE, Math.min(100, jobs.length))}`),
      ]);
      stats = s;
      jobs = list.jobs;
      total = list.total;
      error = null;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function loadMore() {
    loadingMore = true;
    try {
      const list = await api<JobPage>(`${base}?limit=${PAGE}&offset=${jobs.length}`);
      const known = new Set(jobs.map((j) => j.id));
      jobs = [...jobs, ...list.jobs.filter((j) => !known.has(j.id))];
      total = list.total;
    } catch (err) {
      toastError(err);
    } finally {
      loadingMore = false;
    }
  }

  async function remove(job: PrintJob) {
    const ok = await confirmAction({
      title: t('history.confirmDeleteTitle'),
      message: t('history.confirmDelete', { name: job.task ?? t('common.untitled') }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/history/${job.id}`, { method: 'DELETE' });
      toast(t('history.deleted'), 'success');
      jobs = jobs.filter((j) => j.id !== job.id);
      load();
    } catch (err) {
      toastError(err);
    }
  }

  onMount(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    void refreshKey;
    void base;
    untrack(load); // load() reads `jobs`, which must not become a dependency
  });

  const when = (at: number) => formatDate(at, { dateStyle: 'medium', timeStyle: 'short' });
</script>

{#if error}
  <div class="alert error">{error}</div>
{:else if !stats}
  <div class="empty">{t('common.loading')}</div>
{:else}
  <div class="stack history">
    <section class="tiles">
      <div class="card tile">
        <span class="muted small">{t('history.prints')}</span>
        <strong>{stats.total}</strong>
      </div>
      <div class="card tile">
        <span class="muted small">{t('history.successRate')}</span>
        <strong>{formatRate(stats.successRate)}</strong>
        <span class="muted small">{t('history.finishedFailed', { finished: stats.byStatus.finished, failed: stats.byStatus.failed })}</span>
      </div>
      <div class="card tile">
        <span class="muted small">{t('history.printTime')}</span>
        <strong>{formatMs(stats.printTimeMs)}</strong>
      </div>
      <div class="card tile">
        <span class="muted small">{t('history.interrupted')}</span>
        <strong>{stats.byStatus.interrupted}</strong>
        <span class="muted small">{t('history.outcomeUnknown')}</span>
      </div>
    </section>

    {#if printerId === undefined && stats.printers.length > 1}
      <section class="card stack">
        <header style="margin:0"><h2>{t('history.perPrinter')}</h2></header>
        <table class="per-printer">
          <thead>
            <tr><th>{t('history.printer')}</th><th>{t('history.prints')}</th><th>{t('history.success')}</th><th>{t('history.printTime')}</th></tr>
          </thead>
          <tbody>
            {#each stats.printers as p (p.printerId ?? `name:${p.printerName}`)}
              <tr>
                <td>
                  {#if p.printerId !== null}<a href={printerPage(p.printerId, 'history')}>{p.printerName}</a>
                  {:else}{p.printerName} <span class="muted small">{t('history.removedPrinter')}</span>{/if}
                </td>
                <td>{p.total}</td>
                <td>{formatRate(p.successRate)}</td>
                <td>{formatMs(p.printTimeMs)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}

    <section class="card stack">
      <header style="margin:0">
        <h2>{t('history.jobs')}</h2>
        <button class="small" onclick={load}>{t('common.reload')}</button>
      </header>
      {#if jobs.length === 0}
        <p class="muted small" style="margin:0">{t('history.none')}</p>
      {:else}
        <table class="jobs">
          <thead>
            <tr><th>{t('history.job')}</th><th>{t('history.status')}</th><th>{t('history.started')}</th><th>{t('history.duration')}</th><th>{t('history.layers')}</th><th></th></tr>
          </thead>
          <tbody>
            {#each jobs as job (job.id)}
              {@const st = jobStatusInfo(job.status)}
              <tr>
                <td class="task">
                  {job.task ?? t('common.untitled')}
                  {#if printerId === undefined}<div class="muted small">{job.printerName}</div>{/if}
                </td>
                <td><span class="badge tone-{st.tone}">{st.label}</span></td>
                <td class="small" data-label={t('history.started')} title={job.observedMidway ? t('history.observedMidway') : undefined}>
                  {job.observedMidway ? '≤ ' : ''}{when(job.startedAt)}
                </td>
                <td class="small" data-label={t('history.duration')}>
                  {job.observedMidway ? '≥ ' : ''}{formatMs(job.durationMs)}
                  {#if job.pausedMs >= 60_000}<div class="muted small">{t('history.paused', { duration: formatMs(job.pausedMs) })}</div>{/if}
                </td>
                <td class="small" data-label={t('history.layers')}>{jobProgress(job)}</td>
                <td class="actions">
                  {#if !jobOpen(job.status)}
                    <button class="small ghost" onclick={() => remove(job)} aria-label={t('history.deleteEntry')} title={t('history.deleteEntry')}>✕</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if jobs.length < total}
          <button class="small" onclick={loadMore} disabled={loadingMore}>{t('history.loadMore', { count: total - jobs.length })}</button>
        {/if}
      {/if}
    </section>
  </div>
{/if}

<style>
  .tiles {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tile strong {
    font-size: 1.5rem;
    font-weight: 600;
  }
  .task {
    overflow-wrap: anywhere;
  }
  .jobs td {
    vertical-align: top;
  }
  .actions {
    text-align: right;
    width: 1%;
  }
  .history section > button {
    align-self: center;
  }
  @media (max-width: 900px) {
    .tiles {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
  }
  /* Phone: each job becomes a small block instead of a wide table row. */
  @media (max-width: 700px) {
    .jobs thead {
      display: none;
    }
    .jobs tr {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 2px 8px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
    }
    .jobs td {
      border-bottom: none;
      padding: 0 4px;
    }
    .jobs td.task {
      grid-column: 1;
      font-weight: 500;
    }
    .jobs td.actions {
      grid-column: 2;
      grid-row: 1;
      width: auto;
    }
    .jobs td:nth-child(2) {
      grid-column: 1 / -1;
    }
    .jobs td[data-label] {
      grid-column: 1 / -1;
      color: var(--muted);
    }
    .jobs td[data-label]::before {
      content: attr(data-label) ': ';
    }
    /* French typography: narrow no-break space before the colon. */
    .jobs td[data-label]:lang(fr)::before {
      content: attr(data-label) '\202F: ';
    }
    .jobs td[data-label] > div {
      display: inline;
      margin-left: 6px;
    }
    .tile strong {
      font-size: 1.25rem;
    }
  }
</style>
