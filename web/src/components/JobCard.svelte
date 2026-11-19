<script lang="ts">
  import type { PrinterDetail, SendFn } from '../lib/api';
  import { SPEED_LEVELS, formatDuration, formatEta, gcodeStateInfo, stageLabel } from '../lib/bambu';
  import { skipReplyError } from '../lib/skip-objects';
  import { toast } from '../lib/toast.svelte';
  import SkipObjects from './SkipObjects.svelte';

  let {
    state: s,
    online,
    send,
    printerId,
    log = [],
  }: { state: Record<string, any>; online: boolean; send: SendFn; printerId: number; log?: PrinterDetail['log'] } =
    $props();

  const st = $derived(gcodeStateInfo(s.gcode_state));
  const active = $derived(['RUNNING', 'PAUSE', 'PREPARE', 'SLICING'].includes(s.gcode_state));
  const paused = $derived(s.gcode_state === 'PAUSE');
  const stage = $derived(stageLabel(s));
  const eta = $derived(formatEta(s.mc_remaining_time));
  const lights = $derived<{ node: string; mode: string }[]>(Array.isArray(s.lights_report) ? s.lights_report : []);

  async function stop() {
    if (confirm('Stop the current print? This cannot be undone.')) await send('stop', {}, 'Stop requested');
  }

  // Skip objects: only while printing. Printer rejections arrive in the command log.
  const canSkip = $derived(s.gcode_state === 'RUNNING' || s.gcode_state === 'PAUSE');
  let skipOpen = $state(false);
  let skipSentAt = 0;
  let skipReported = 0;

  async function skip(ids: number[]) {
    // Server timestamps: only replies logged after this point count.
    skipSentAt = log.reduce((max, e) => Math.max(max, e.at), 0) || 1;
    return send('skipObjects', { ids }, `Skipping ${ids.length} object${ids.length === 1 ? '' : 's'}`);
  }

  $effect(() => {
    for (const entry of log) {
      if (!skipSentAt || entry.at <= skipSentAt || entry.at <= skipReported) continue;
      const error = skipReplyError(entry);
      if (error === null) continue;
      skipReported = entry.at;
      toast(`The printer refused to skip objects: ${error}`, 'error');
    }
  });

  const lightLabel = (node: string) =>
    ({ chamber_light: 'Chamber light', chamber_light2: 'Chamber light 2', work_light: 'Work light' })[node] ?? node;
</script>

<section class="card stack job">
  <header style="margin:0">
    <h2>Print job</h2>
    <span class="badge plain tone-{st.tone}">{st.label}</span>
  </header>

  {#if active || s.gcode_state === 'FINISH' || s.gcode_state === 'FAILED'}
    <div class="stack" style="gap:6px">
      <div class="row">
        <b class="task">{s.subtask_name || s.gcode_file || 'Print job'}</b>
        <span class="spacer"></span>
        <b style="font-size:1.3rem">{s.mc_percent ?? 0}%</b>
      </div>
      <div class="progress"><div style="width:{s.mc_percent ?? 0}%"></div></div>
      <div class="row small muted">
        <span>Layer {s.layer_num ?? '—'} / {s.total_layer_num ?? '—'}</span>
        <span class="spacer"></span>
        <span>{formatDuration(s.mc_remaining_time)} left{eta ? ` · ETA ${eta}` : ''}</span>
      </div>
      {#if stage && active}<div class="small">Stage: <b>{stage}</b></div>{/if}
      {#if s.print_error}<div class="alert error small">Print error code {s.print_error}</div>{/if}
    </div>
  {:else}
    <div class="muted small">No active print. Start one from the <b>Files</b> section.</div>
  {/if}

  <div class="row">
    {#if paused}
      <button class="primary" onclick={() => send('resume', {}, 'Resume requested')} disabled={!online}>▶ Resume</button>
    {:else}
      <button onclick={() => send('pause', {}, 'Pause requested')} disabled={!online || !active}>❚❚ Pause</button>
    {/if}
    <button class="danger" onclick={stop} disabled={!online || !active}>■ Stop</button>
    {#if canSkip}
      <button onclick={() => (skipOpen = true)} disabled={!online} title="Skip parts of this print">⊘ Skip objects</button>
    {/if}
    <span class="spacer"></span>
    {#each lights as l (l.node)}
      <button
        class="small"
        class:active={l.mode === 'on'}
        onclick={() => send('light', { node: l.node, on: l.mode !== 'on' })}
        disabled={!online}
        title="Toggle {lightLabel(l.node)}"
      >
        💡 {lightLabel(l.node)}
      </button>
    {:else}
      <button class="small" onclick={() => send('light', { node: 'chamber_light', on: true })} disabled={!online}>💡 On</button>
      <button class="small" onclick={() => send('light', { node: 'chamber_light', on: false })} disabled={!online}>Off</button>
    {/each}
  </div>

  <div class="stack" style="gap:6px;margin-top:auto">
    <span class="muted small">Print speed</span>
    <div class="speeds">
      {#each SPEED_LEVELS as lvl}
        <button
          class="small"
          class:active={s.spd_lvl === lvl.level}
          onclick={() => send('speed', { level: lvl.level })}
          disabled={!online}
        >
          {lvl.label} <span class="muted">{lvl.pct}%</span>
        </button>
      {/each}
    </div>
  </div>
</section>

{#if skipOpen}
  <SkipObjects {printerId} state={s} {online} onSkip={skip} onClose={() => (skipOpen = false)} />
{/if}

<style>
  .task {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .speeds {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .job {
    container-type: inline-size;
  }
  @container (max-width: 460px) {
    .speeds {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
