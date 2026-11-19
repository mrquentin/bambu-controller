<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { api } from '../lib/api';
  import { formatMs, formatRate, jobProgress, jobStatusInfo, type HistoryStats, type PrintJob } from '../lib/history';
  import { toast, toastError } from '../lib/toast.svelte';

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
        api<{ jobs: PrintJob[]; total: number }>(`${base}?limit=${Math.max(PAGE, Math.min(100, jobs.length))}`),
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
      const list = await api<{ jobs: PrintJob[]; total: number }>(`${base}?limit=${PAGE}&offset=${jobs.length}`);
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
    if (!confirm(`Delete "${job.task ?? 'Untitled'}" from the history?`)) return;
    try {
      await api(`/api/history/${job.id}`, { method: 'DELETE' });
      toast('Removed from history', 'success');
      jobs = jobs.filter((j) => j.id !== job.id);
      load();
    } catch (err) {
      toastError(err);
    }
  }

  onMount(() => {
    // Keeps durations of running jobs and new jobs current.
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  });

  $effect(() => {
    void refreshKey;
    void base;
    untrack(load); // load() reads `jobs`, which must not become a dependency
  });

  const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const active = (job: PrintJob) => job.status === 'running' || job.status === 'paused';
</script>

{#if error}
  <div class="alert error">{error}</div>
{:else if !stats}
  <div class="empty">Loading…</div>
{:else}
  <div class="stack history">
    <section class="tiles">
      <div class="card tile">
        <span class="muted small">Prints</span>
        <strong>{stats.total}</strong>
      </div>
      <div class="card tile">
        <span class="muted small">Success rate</span>
        <strong>{formatRate(stats.successRate)}</strong>
        <span class="muted small">{stats.byStatus.finished} finished · {stats.byStatus.failed} failed</span>
      </div>
      <div class="card tile">
        <span class="muted small">Print time</span>
        <strong>{formatMs(stats.printTimeMs)}</strong>
      </div>
      <div class="card tile">
        <span class="muted small">Interrupted</span>
        <strong>{stats.byStatus.interrupted}</strong>
        <span class="muted small">outcome unknown</span>
      </div>
    </section>

    {#if printerId === undefined && stats.printers.length > 1}
      <section class="card stack">
        <header style="margin:0"><h2>Per printer</h2></header>
        <table class="per-printer">
          <thead>
            <tr><th>Printer</th><th>Prints</th><th>Success</th><th>Print time</th></tr>
          </thead>
          <tbody>
            {#each stats.printers as p (p.printerId ?? `name:${p.printerName}`)}
              <tr>
                <td>
                  {#if p.printerId !== null}<a href="#/printer/{p.printerId}/history">{p.printerName}</a>
                  {:else}{p.printerName} <span class="muted small">(removed)</span>{/if}
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
        <h2>Jobs</h2>
        <button class="small" onclick={load}>Reload</button>
      </header>
      {#if jobs.length === 0}
        <p class="muted small" style="margin:0">
          No prints recorded yet. Jobs are recorded while the app is running and connected to the printer.
        </p>
      {:else}
        <table class="jobs">
          <thead>
            <tr><th>Job</th><th>Status</th><th>Started</th><th>Duration</th><th>Layers</th><th></th></tr>
          </thead>
          <tbody>
            {#each jobs as job (job.id)}
              {@const st = jobStatusInfo(job.status)}
              <tr>
                <td class="task">
                  {job.task ?? 'Untitled'}
                  {#if printerId === undefined}<div class="muted small">{job.printerName}</div>{/if}
                </td>
                <td><span class="badge tone-{st.tone}">{st.label}</span></td>
                <td class="small" data-label="Started" title={job.observedMidway ? 'Already printing when the app first saw it: started earlier' : undefined}>
                  {job.observedMidway ? '≤ ' : ''}{when(job.startedAt)}
                </td>
                <td class="small" data-label="Duration">
                  {job.observedMidway ? '≥ ' : ''}{formatMs(job.durationMs)}
                  {#if job.pausedMs >= 60_000}<div class="muted small">paused {formatMs(job.pausedMs)}</div>{/if}
                </td>
                <td class="small" data-label="Layers">{jobProgress(job)}</td>
                <td class="actions">
                  {#if !active(job)}
                    <button class="small ghost" onclick={() => remove(job)} aria-label="Delete from history" title="Delete from history">✕</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if jobs.length < total}
          <button class="small" onclick={loadMore} disabled={loadingMore}>Load more ({total - jobs.length} left)</button>
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
    .jobs td[data-label] > div {
      display: inline;
      margin-left: 6px;
    }
    .tile strong {
      font-size: 1.25rem;
    }
  }
</style>
