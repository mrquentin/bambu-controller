<script lang="ts">
  import type { SendFn } from '../lib/api';
  import { chamber, nozzles } from '../lib/bambu';

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

  async function apply(key: string, action: string, extra: Record<string, unknown> = {}) {
    const temp = Number(inputs[key]);
    if (inputs[key] === undefined || inputs[key] === '' || !Number.isFinite(temp)) return;
    if (await send(action, { temp, ...extra }, `Target set to ${temp}°C`)) inputs[key] = '';
  }

  const fmt = (v: number | null) => (v === null ? '—' : `${Math.round(v)}°`);
</script>

<section class="card">
  <header><h2>Temperatures</h2></header>
  <div class="stack">
    {#each nozzleList as n (n.label)}
      {@const key = `nozzle-${n.index ?? 'single'}`}
      <div class="heater">
        <div>
          <div class="muted small">{n.label}</div>
          <div class="value">{fmt(n.current)} <span class="muted small">/ {fmt(n.target)}</span></div>
        </div>
        <form class="row" onsubmit={(e) => { e.preventDefault(); apply(key, 'nozzleTemp', n.index === null ? {} : { extruder: n.index }); }}>
          <input type="number" min="0" max="300" placeholder="°C" bind:value={inputs[key]} disabled={!online} />
          <button class="small" disabled={!online}>Set</button>
          <button type="button" class="small ghost" disabled={!online} title="Turn off"
            onclick={() => { inputs[key] = '0'; apply(key, 'nozzleTemp', n.index === null ? {} : { extruder: n.index }); }}>Off</button>
        </form>
      </div>
    {/each}

    <div class="heater">
      <div>
        <div class="muted small">Bed</div>
        <div class="value">{fmt(s.bed_temper ?? null)} <span class="muted small">/ {fmt(s.bed_target_temper ?? null)}</span></div>
      </div>
      <form class="row" onsubmit={(e) => { e.preventDefault(); apply('bed', 'bedTemp'); }}>
        <input type="number" min="0" max="120" placeholder="°C" bind:value={inputs.bed} disabled={!online} />
        <button class="small" disabled={!online}>Set</button>
        <button type="button" class="small ghost" disabled={!online} title="Turn off"
          onclick={() => { inputs.bed = '0'; apply('bed', 'bedTemp'); }}>Off</button>
      </form>
    </div>

    {#if ch.current !== null || chamberControl}
      <div class="heater">
        <div>
          <div class="muted small">Chamber</div>
          <div class="value">
            {fmt(ch.current)}
            {#if chamberControl}<span class="muted small">/ {fmt(ch.target)}</span>{/if}
          </div>
        </div>
        {#if chamberControl}
          <form class="row" onsubmit={(e) => { e.preventDefault(); apply('chamber', 'chamberTemp'); }}>
            <input type="number" min="0" max="65" placeholder="°C" bind:value={inputs.chamber} disabled={!online} />
            <button class="small" disabled={!online}>Set</button>
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
