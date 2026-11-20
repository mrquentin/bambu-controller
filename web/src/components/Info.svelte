<script lang="ts">
  import type { PrinterDetail } from '../../../shared/api.ts';
  import { HOME_FLAGS, hasFlag } from '../lib/bambu';
  import { formatDate, t } from '../lib/i18n.svelte';

  let {
    state: s,
    modules,
    connection,
  }: { state: Record<string, any>; modules: PrinterDetail['modules']; connection: PrinterDetail['connection'] } =
    $props();

  const firmware = $derived(modules.find((m) => m.name === 'ota')?.sw_ver ?? null);
  const yesNo = (v: boolean) => (v ? t('common.yes') : t('common.no'));
  let showRaw = $state(false);
</script>

<section class="card stack">
  <header style="margin:0"><h2>{t('info.title')}</h2></header>
  <dl class="kv">
    <dt>{t('info.firmware')}</dt>
    <dd>{firmware ?? '—'}</dd>
    <dt>{t('info.nozzle')}</dt>
    <dd>{s.nozzle_diameter ? t('unit.mm', { value: s.nozzle_diameter }) : '—'} {s.nozzle_type ? `· ${s.nozzle_type.replace(/_/g, ' ')}` : ''}</dd>
    <dt>{t('info.wifi')}</dt>
    <dd>{s.wifi_signal ?? '—'}{hasFlag(s, HOME_FLAGS.wiredNetwork) ? ` ${t('info.wired')}` : ''}</dd>
    <dt>{t('info.storage')}</dt>
    <dd>
      {#if typeof s.home_flag === 'number'}
        {hasFlag(s, HOME_FLAGS.sdCardAbnormal) ? t('info.sdError') : hasFlag(s, HOME_FLAGS.sdCardPresent) ? t('info.sdPresent') : t('info.sdNone')}
      {:else}—{/if}
    </dd>
    {#if typeof s.home_flag === 'number'}
      <dt>{t('info.door')}</dt>
      <dd>{hasFlag(s, HOME_FLAGS.doorOpen) ? t('info.doorOpen') : t('info.doorClosed')}</dd>
      <dt>{t('info.homed')}</dt>
      <dd>{yesNo(hasFlag(s, HOME_FLAGS.xHomed) && hasFlag(s, HOME_FLAGS.yHomed) && hasFlag(s, HOME_FLAGS.zHomed))}</dd>
    {/if}
    {#if s.ipcam}
      <dt>{t('info.recording')}</dt>
      <dd>{s.ipcam.ipcam_record ?? '—'} · {t('info.timelapse', { value: s.ipcam.timelapse ?? '—' })}</dd>
    {/if}
    <dt>{t('info.lastReport')}</dt>
    <dd>{connection.lastReportAt ? formatDate(connection.lastReportAt, { timeStyle: 'medium' }) : '—'}</dd>
  </dl>

  {#if modules.length > 0}
    <details>
      <summary class="small muted">{t('info.modules', { count: modules.length })}</summary>
      <table>
        <thead><tr><th>{t('info.module')}</th><th>{t('info.software')}</th><th>{t('info.hardware')}</th></tr></thead>
        <tbody>
          {#each modules as m}
            <tr><td>{m.name}</td><td class="mono small">{m.sw_ver ?? ''}</td><td class="mono small">{m.hw_ver ?? ''}</td></tr>
          {/each}
        </tbody>
      </table>
    </details>
  {/if}

  <details bind:open={showRaw}>
    <summary class="small muted">{t('info.raw')}</summary>
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
