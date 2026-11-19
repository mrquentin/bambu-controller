<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type PrinterSummary } from '../lib/api';
  import { formatDuration, gcodeStateInfo } from '../lib/bambu';
  import ConnectionBadge from '../components/ConnectionBadge.svelte';

  let printers = $state<PrinterSummary[] | null>(null);
  let error = $state<string | null>(null);

  async function load() {
    try {
      printers = await api<PrinterSummary[]>('/api/printers');
      error = null;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  onMount(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  });
</script>

<div class="container stack">
  <div class="row">
    <h1>Printers</h1>
    <span class="spacer"></span>
    <a class="btn history-link" href="#/history">History</a>
    <a class="btn primary" href="#/add">
      + Add printer
    </a>
  </div>

  {#if error}<div class="alert error">{error}</div>{/if}

  {#if printers === null}
    <div class="empty">Loading…</div>
  {:else if printers.length === 0}
    <div class="card empty">
      <p>No printers yet.</p>
      <p class="small">
        Enable <b>LAN Only Mode</b> (and <b>Developer Mode</b> on recent firmware) on the printer, note the access code,
        then add it here.
      </p>
      <a class="btn" href="#/add">Add your first printer</a>
    </div>
  {:else}
    <div class="grid list">
      {#each printers as p (p.printer.id)}
        {@const st = gcodeStateInfo(p.gcodeState)}
        <a class="card printer" href="#/printer/{p.printer.id}">
          <div class="row">
            <div class="stack" style="gap:2px">
              <h2>{p.printer.name}</h2>
              <span class="muted small">{p.printer.model} · {p.printer.ip}</span>
            </div>
            <span class="spacer"></span>
            <ConnectionBadge connection={p.connection} />
          </div>

          {#if p.connection.status === 'online'}
            <div class="row">
              <span class="badge plain tone-{st.tone}">{st.label}</span>
              {#if p.hmsCount > 0}<span class="badge plain tone-warn">{p.hmsCount} alert{p.hmsCount > 1 ? 's' : ''}</span>{/if}
            </div>
            {#if p.gcodeState === 'RUNNING' || p.gcodeState === 'PAUSE' || p.gcodeState === 'PREPARE'}
              <div class="stack" style="gap:6px">
                <div class="row small">
                  <span class="task">{p.task ?? 'Print job'}</span>
                  <span class="spacer"></span>
                  <b>{p.percent ?? 0}%</b>
                </div>
                <div class="progress"><div style="width:{p.percent ?? 0}%"></div></div>
                <div class="row small muted">
                  <span>Layer {p.layer ?? '—'}/{p.totalLayers ?? '—'}</span>
                  <span class="spacer"></span>
                  <span>{formatDuration(p.remainingMinutes)} left</span>
                </div>
              </div>
            {/if}
            <div class="row small muted temps">
              <span>Nozzle <b>{p.nozzle ?? '—'}°</b>{p.nozzleTarget ? ` / ${p.nozzleTarget}°` : ''}</span>
              <span>Bed <b>{p.bed ?? '—'}°</b>{p.bedTarget ? ` / ${p.bedTarget}°` : ''}</span>
            </div>
          {:else if p.connection.error}
            <div class="alert error small">{p.connection.error}</div>
          {/if}
        </a>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Phones only: the top bar's History link is hidden there (see App.svelte). */
  .history-link {
    display: none;
  }
  @media (max-width: 480px) {
    .history-link {
      display: inline-flex;
    }
  }
  .list {
    grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
  }
  .printer {
    display: flex;
    flex-direction: column;
    gap: 12px;
    color: inherit;
    transition: border-color 0.12s;
  }
  .printer:hover {
    border-color: var(--hover-border);
    text-decoration: none;
  }
  .temps b {
    color: var(--text);
  }
  .task {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 75%;
  }
</style>
