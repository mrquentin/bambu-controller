<script lang="ts">
  import { LIMITS, type PrinterCommand } from '../../../shared/commands.ts';
  import type { SendFn } from '../lib/api';
  import { chamber, nozzles, type Nozzle } from '../lib/bambu';
  import { t } from '../lib/i18n.svelte';

  let {
    state: s,
    online,
    send,
    chamberControl,
  }: { state: Record<string, any>; online: boolean; send: SendFn; chamberControl: boolean } = $props();

  const nozzleList = $derived(nozzles(s));
  const ch = $derived(chamber(s));

  // Inputs keyed by heater id. Empty means "not edited".
  let inputs = $state<Record<string, string>>({});

  async function apply(key: string, command: (temp: number) => PrinterCommand) {
    const temp = Number(inputs[key]);
    if (inputs[key] === undefined || inputs[key] === '' || !Number.isFinite(temp)) return;
    if (await send(command(temp), t('temp.targetSet', { temp }))) inputs[key] = '';
  }

  const nozzleTemp = (n: Nozzle) => (temp: number): PrinterCommand =>
    n.index === null ? { action: 'nozzleTemp', temp } : { action: 'nozzleTemp', temp, extruder: n.index };
  const bedTemp = (temp: number): PrinterCommand => ({ action: 'bedTemp', temp });
  const chamberTemp = (temp: number): PrinterCommand => ({ action: 'chamberTemp', temp });

  const fmt = (v: number | null) => (v === null ? '—' : t('unit.degrees', { value: Math.round(v) }));
</script>

<section class="card">
  <header><h2>{t('temp.title')}</h2></header>
  <div class="stack">
    {#each nozzleList as n (n.label)}
      {@const key = `nozzle-${n.index ?? 'single'}`}
      <div class="heater">
        <div>
          <div class="muted small">{n.label}</div>
          <div class="value">{fmt(n.current)} <span class="muted small">/ {fmt(n.target)}</span></div>
        </div>
        <form class="row" onsubmit={(e) => { e.preventDefault(); apply(key, nozzleTemp(n)); }}>
          <input type="number" min={LIMITS.nozzleTemp.min} max={LIMITS.nozzleTemp.max} placeholder="°C" aria-label={n.label} bind:value={inputs[key]} disabled={!online} />
          <button class="small" disabled={!online}>{t('temp.set')}</button>
          <button type="button" class="small ghost" disabled={!online} title={t('temp.turnOff')}
            onclick={() => { inputs[key] = '0'; apply(key, nozzleTemp(n)); }}>{t('common.off')}</button>
        </form>
      </div>
    {/each}

    <div class="heater">
      <div>
        <div class="muted small">{t('temp.bed')}</div>
        <div class="value">{fmt(s.bed_temper ?? null)} <span class="muted small">/ {fmt(s.bed_target_temper ?? null)}</span></div>
      </div>
      <form class="row" onsubmit={(e) => { e.preventDefault(); apply('bed', bedTemp); }}>
        <input type="number" min={LIMITS.bedTemp.min} max={LIMITS.bedTemp.max} placeholder="°C" aria-label={t('temp.bed')} bind:value={inputs.bed} disabled={!online} />
        <button class="small" disabled={!online}>{t('temp.set')}</button>
        <button type="button" class="small ghost" disabled={!online} title={t('temp.turnOff')}
          onclick={() => { inputs.bed = '0'; apply('bed', bedTemp); }}>{t('common.off')}</button>
      </form>
    </div>

    {#if ch.current !== null || chamberControl}
      <div class="heater">
        <div>
          <div class="muted small">{t('temp.chamber')}</div>
          <div class="value">
            {fmt(ch.current)}
            {#if chamberControl}<span class="muted small">/ {fmt(ch.target)}</span>{/if}
          </div>
        </div>
        {#if chamberControl}
          <form class="row" onsubmit={(e) => { e.preventDefault(); apply('chamber', chamberTemp); }}>
            <input type="number" min={LIMITS.chamberTemp.min} max={LIMITS.chamberTemp.max} placeholder="°C" aria-label={t('temp.chamber')} bind:value={inputs.chamber} disabled={!online} />
            <button class="small" disabled={!online}>{t('temp.set')}</button>
          </form>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  .heater {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .value {
    font-size: 1.35rem;
    font-weight: 600;
  }
  input {
    width: 80px;
  }
  .heater form {
    flex-wrap: nowrap;
  }
</style>
