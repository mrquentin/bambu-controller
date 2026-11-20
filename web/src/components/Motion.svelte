<script lang="ts">
  import type { SendFn } from '../lib/api';
  import { nozzles } from '../lib/bambu';
  import { t } from '../lib/i18n.svelte';

  let { state: s, online, send }: { state: Record<string, any>; online: boolean; send: SendFn } = $props();

  let step = $state(10);
  let extrudeAmount = $state(10);

  const printing = $derived(['RUNNING', 'PREPARE'].includes(s.gcode_state));
  const disabled = $derived(!online || printing);
  const hotEnough = $derived(nozzles(s).some((n) => (n.current ?? 0) >= 170));

  const jog = (axis: 'X' | 'Y' | 'Z', direction: 1 | -1) => send('jog', { axis, distance: direction * step });

  async function home() {
    if (confirm(t('motion.confirmHome'))) await send('home', {}, t('motion.homing'));
  }
</script>

<section class="card stack">
  <header style="margin:0">
    <h2>{t('motion.title')}</h2>
    <div class="row">
      {#each [1, 10, 50] as v}
        <button class="small" class:active={step === v} onclick={() => (step = v)}>{t('unit.mm', { value: v })}</button>
      {/each}
    </div>
  </header>

  {#if printing}<div class="alert warn small">{t('motion.disabledWhilePrinting')}</div>{/if}

  <div class="pads">
    <div class="xy">
      <span></span>
      <button onclick={() => jog('Y', 1)} {disabled} title="Y+">▲<small>Y+</small></button>
      <span></span>
      <button onclick={() => jog('X', -1)} {disabled} title="X-">◀<small>X-</small></button>
      <button onclick={home} {disabled} title={t('motion.home')} aria-label={t('motion.home')}>⌂</button>
      <button onclick={() => jog('X', 1)} {disabled} title="X+">▶<small>X+</small></button>
      <span></span>
      <button onclick={() => jog('Y', -1)} {disabled} title="Y-">▼<small>Y-</small></button>
      <span></span>
    </div>
    <div class="z">
      <button onclick={() => jog('Z', 1)} {disabled} title={t('motion.zUp')}>Z+<small>{t('motion.apart')}</small></button>
      <button onclick={() => jog('Z', -1)} {disabled} title={t('motion.zDown')}>Z−<small>{t('motion.closer')}</small></button>
    </div>
  </div>

  <div class="stack" style="gap:6px">
    <div class="row">
      <span class="small muted">{t('motion.extruder')}</span>
      <span class="spacer"></span>
      <select bind:value={extrudeAmount} style="width:auto" aria-label={t('motion.extruder')}>
        {#each [5, 10, 20, 50] as v}<option value={v}>{t('unit.mm', { value: v })}</option>{/each}
      </select>
      <button class="small" disabled={disabled || !hotEnough} onclick={() => send('extrude', { distance: -extrudeAmount })}>{t('motion.retract')}</button>
      <button class="small" disabled={disabled || !hotEnough} onclick={() => send('extrude', { distance: extrudeAmount })}>{t('motion.extrude')}</button>
    </div>
    {#if !hotEnough}<span class="muted small">{t('motion.heatToExtrude')}</span>{/if}
  </div>
</section>

<style>
  .pads {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    justify-content: center;
    align-items: center;
  }
  .xy {
    display: grid;
    grid-template-columns: repeat(3, 56px);
    grid-template-rows: repeat(3, 56px);
    gap: 6px;
  }
  .z {
    display: grid;
    grid-template-rows: repeat(2, 56px);
    gap: 6px;
  }
  .z button {
    width: 76px;
  }
  .pads button {
    flex-direction: column;
    gap: 0;
    padding: 4px;
    font-size: 1.05rem;
  }
  .pads small {
    font-size: 0.65rem;
    color: var(--muted);
  }
</style>
