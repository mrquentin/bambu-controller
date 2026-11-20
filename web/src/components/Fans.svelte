<script lang="ts">
  import type { SendFn } from '../lib/api';
  import { fanPercent } from '../lib/bambu';
  import { t } from '../lib/i18n.svelte';

  let { state: s, online, send }: { state: Record<string, any>; online: boolean; send: SendFn } = $props();

  // fan index used by M106 P<n>: 1 = part, 2 = aux, 3 = chamber
  const fans = $derived([
    { id: 1, label: t('fans.part'), value: fanPercent(s.cooling_fan_speed) },
    { id: 2, label: t('fans.aux'), value: fanPercent(s.big_fan1_speed) },
    { id: 3, label: t('fans.chamber'), value: fanPercent(s.big_fan2_speed) },
  ]);
  const heatbreak = $derived(fanPercent(s.heatbreak_fan_speed));

  // Slider positions while the user drags; cleared once the printer reports back.
  let dragging = $state<Record<number, number>>({});

  async function commit(fan: number) {
    const percent = dragging[fan];
    if (percent === undefined) return;
    await send('fan', { fan, percent });
    setTimeout(() => delete dragging[fan], 1500);
  }
</script>

<section class="card">
  <header>
    <h2>{t('fans.title')}</h2>
    {#if heatbreak !== null}<span class="muted small">{t('fans.heatbreak', { value: t('unit.percent', { value: heatbreak }) })}</span>{/if}
  </header>
  <div class="stack">
    {#each fans as fan (fan.id)}
      {@const shown = dragging[fan.id] ?? fan.value ?? 0}
      <div class="fan">
        <span class="small">{fan.label}</span>
        <input
          type="range"
          aria-label={fan.label}
          min="0"
          max="100"
          step="10"
          value={shown}
          style="--pct: {shown}%"
          disabled={!online}
          oninput={(e) => (dragging[fan.id] = Number((e.target as HTMLInputElement).value))}
          onchange={() => commit(fan.id)}
        />
        <b class="small pct">{fan.value === null && dragging[fan.id] === undefined ? '—' : t('unit.percent', { value: shown })}</b>
      </div>
    {/each}
  </div>
</section>

<style>
  .fan {
    display: grid;
    grid-template-columns: 110px 1fr 44px;
    align-items: center;
    gap: 10px;
  }
  .pct {
    text-align: right;
  }
  @media (max-width: 420px) {
    .fan {
      grid-template-columns: 84px 1fr 40px;
      gap: 8px;
    }
  }
</style>
