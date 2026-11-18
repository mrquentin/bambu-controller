<script lang="ts">
  import type { PrinterDetail, SendFn } from '../lib/api';

  let { log, online, send }: { log: PrinterDetail['log']; online: boolean; send: SendFn } = $props();

  let gcode = $state('');
  let open = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!gcode.trim()) return;
    if (await send('gcode', { gcode }, 'G-code sent')) gcode = '';
  }

  const time = (at: number) => new Date(at).toLocaleTimeString();
</script>

<section class="card stack">
  <header style="margin:0">
    <h2>G-code console</h2>
  </header>
  <form class="row" onsubmit={submit}>
    <input class="mono" style="flex:1" placeholder="e.g. M106 P1 S255" bind:value={gcode} disabled={!online} />
    <button disabled={!online || !gcode.trim()}>Send</button>
  </form>
  <p class="muted small" style="margin:0">Use with care: commands are sent as-is via <code>gcode_line</code>.</p>

  <details bind:open>
    <summary class="small muted">Command log ({log.length})</summary>
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
        <div class="muted small">Nothing yet.</div>
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
