<script lang="ts">
  import type { PrinterDetail } from '../lib/api';
  import { HOME_FLAGS, hasFlag } from '../lib/bambu';

  let {
    state: s,
    modules,
    connection,
  }: { state: Record<string, any>; modules: PrinterDetail['modules']; connection: PrinterDetail['connection'] } =
    $props();

  const firmware = $derived(modules.find((m) => m.name === 'ota')?.sw_ver ?? null);
  const yesNo = (v: boolean) => (v ? 'Yes' : 'No');
  let showRaw = $state(false);
</script>

<section class="card stack">
  <header style="margin:0"><h2>Printer info</h2></header>
  <dl class="kv">
    <dt>Firmware</dt>
    <dd>{firmware ?? '—'}</dd>
    <dt>Nozzle</dt>
    <dd>{s.nozzle_diameter ? `${s.nozzle_diameter} mm` : '—'} {s.nozzle_type ? `· ${s.nozzle_type.replace(/_/g, ' ')}` : ''}</dd>
    <dt>Wi-Fi signal</dt>
    <dd>{s.wifi_signal ?? '—'}{hasFlag(s, HOME_FLAGS.wiredNetwork) ? ' (wired)' : ''}</dd>
    <dt>Storage</dt>
    <dd>
      {#if typeof s.home_flag === 'number'}
        {hasFlag(s, HOME_FLAGS.sdCardAbnormal) ? 'SD card error' : hasFlag(s, HOME_FLAGS.sdCardPresent) ? 'SD card present' : 'No SD card'}
      {:else}—{/if}
    </dd>
    {#if typeof s.home_flag === 'number'}
      <dt>Door</dt>
      <dd>{hasFlag(s, HOME_FLAGS.doorOpen) ? 'Open' : 'Closed'}</dd>
      <dt>Homed</dt>
      <dd>{yesNo(hasFlag(s, HOME_FLAGS.xHomed) && hasFlag(s, HOME_FLAGS.yHomed) && hasFlag(s, HOME_FLAGS.zHomed))}</dd>
    {/if}
    {#if s.ipcam}
      <dt>Recording</dt>
      <dd>{s.ipcam.ipcam_record ?? '—'} · timelapse {s.ipcam.timelapse ?? '—'}</dd>
    {/if}
    <dt>Last report</dt>
    <dd>{connection.lastReportAt ? new Date(connection.lastReportAt).toLocaleTimeString() : '—'}</dd>
  </dl>

  {#if modules.length > 0}
    <details>
      <summary class="small muted">Modules ({modules.length})</summary>
      <table>
        <thead><tr><th>Module</th><th>Software</th><th>Hardware</th></tr></thead>
        <tbody>
          {#each modules as m}
            <tr><td>{m.name}</td><td class="mono small">{m.sw_ver ?? ''}</td><td class="mono small">{m.hw_ver ?? ''}</td></tr>
          {/each}
        </tbody>
      </table>
    </details>
  {/if}

  <details bind:open={showRaw}>
    <summary class="small muted">Raw status JSON</summary>
    {#if showRaw}<pre class="raw">{JSON.stringify(s, null, 2)}</pre>{/if}
  </details>
</section>

<style>
  .raw {
    max-height: 400px;
    overflow: auto;
    background: var(--bg-2);
    padding: 10px;
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
  }
</style>
