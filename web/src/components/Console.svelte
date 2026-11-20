<script lang="ts">
  import type { PrinterDetail, SendFn } from '../lib/api';
  import { formatDate, t } from '../lib/i18n.svelte';
  import Trans from './Trans.svelte';

  let { log, online, send }: { log: PrinterDetail['log']; online: boolean; send: SendFn } = $props();

  let gcode = $state('');
  let open = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!gcode.trim()) return;
    if (await send('gcode', { gcode }, t('console.sent'))) gcode = '';
  }

  const time = (at: number) => formatDate(at, { timeStyle: 'medium' });
</script>

<section class="card stack">
  <header style="margin:0">
    <h2>{t('console.title')}</h2>
  </header>
  <form class="row" onsubmit={submit}>
    <input class="mono" style="flex:1" placeholder={t('console.placeholder')} aria-label="G-code" bind:value={gcode} disabled={!online} />
    <button disabled={!online || !gcode.trim()}>{t('console.send')}</button>
  </form>
  <p class="muted small" style="margin:0">
    <Trans key="console.warning">{#snippet command()}<code>gcode_line</code>{/snippet}</Trans>
  </p>

  <details bind:open>
    <summary class="small muted">{t('console.log', { count: log.length })}</summary>
    <div class="log">
      {#each [...log].reverse() as entry}
        <div class="entry">
          <span class="muted">{time(entry.at)}</span>
          <span class:out={entry.direction === 'out'} class:in={entry.direction === 'in'}>
            {entry.direction === 'out' ? '→' : '←'} {entry.command}
          </span>
          <pre>{JSON.stringify(entry.payload)}</pre>
        </div>
      {:else}
        <div class="muted small">{t('console.empty')}</div>
      {/each}
    </div>
  </details>
</section>

<style>
  .log {
    max-height: 280px;
    overflow: auto;
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .entry {
    font-size: 0.8rem;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 8px;
  }
  .entry pre {
    grid-column: 1 / -1;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--muted);
  }
  .out {
    color: var(--info);
  }
  .in {
    color: var(--ok);
  }
</style>
