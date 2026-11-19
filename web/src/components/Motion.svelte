<script lang="ts">
  import type { SendFn } from '../lib/api';
  import { nozzles } from '../lib/bambu';

  let { state: s, online, send }: { state: Record<string, any>; online: boolean; send: SendFn } = $props();

  let step = $state(10);
  let extrudeAmount = $state(10);

  const printing = $derived(['RUNNING', 'PREPARE'].includes(s.gcode_state));
  const disabled = $derived(!online || printing);
  const hotEnough = $derived(nozzles(s).some((n) => (n.current ?? 0) >= 170));

  const jog = (axis: 'X' | 'Y' | 'Z', direction: 1 | -1) => send('jog', { axis, distance: direction * step });

  async function home() {
    if (confirm('Home all axes?')) await send('home', {}, 'Homing');
  }
</script>

<section class="card stack">
  <header style="margin:0">
    <h2>Motion</h2>
    <div class="row">
      {#each [1, 10, 50] as v}
        <button class="small" class:active={step === v} onclick={() => (step = v)}>{v} mm</button>
      {/each}
    </div>
  </header>

  {#if printing}<div class="alert warn small">Motion controls are disabled while printing.</div>{/if}

  <div class="pads">
    <div class="xy">
      <span></span>
      <button onclick={() => jog('Y', 1)} {disabled} title="Y+">▲<small>Y+</small></button>
      <span></span>
      <button onclick={() => jog('X', -1)} {disabled} title="X-">◀<small>X-</small></button>
      <button onclick={home} {disabled} title="Home all axes">⌂</button>
      <button onclick={() => jog('X', 1)} {disabled} title="X+">▶<small>X+</small></button>
      <span></span>
      <button onclick={() => jog('Y', -1)} {disabled} title="Y-">▼<small>Y-</small></button>
      <span></span>
    </div>
    <div class="z">
      <button onclick={() => jog('Z', 1)} {disabled} title="Z+ (increase nozzle–bed distance)">Z+<small>apart</small></button>
      <button onclick={() => jog('Z', -1)} {disabled} title="Z− (decrease nozzle–bed distance)">Z−<small>closer</small></button>
    </div>
  </div>

  <div class="stack" style="gap:6px">
    <div class="row">
      <span class="small muted">Extruder</span>
      <span class="spacer"></span>
      <select bind:value={extrudeAmount} style="width:auto">
        {#each [5, 10, 20, 50] as v}<option value={v}>{v} mm</option>{/each}
      </select>
      <button class="small" disabled={disabled || !hotEnough} onclick={() => send('extrude', { distance: -extrudeAmount })}>Retract</button>
      <button class="small" disabled={disabled || !hotEnough} onclick={() => send('extrude', { distance: extrudeAmount })}>Extrude</button>
    </div>
    {#if !hotEnough}<span class="muted small">Heat the nozzle above 170 °C to extrude.</span>{/if}
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
