<script lang="ts">
  import type { SendFn } from '../lib/api';
  import { AMS_HUMIDITY, trayColor } from '../lib/bambu';

  let { state: s, online, send }: { state: Record<string, any>; online: boolean; send: SendFn } = $props();

  const units = $derived<any[]>(Array.isArray(s.ams?.ams) ? s.ams.ams : []);
  const external = $derived(s.vt_tray ?? null);
  const trayNow = $derived(Number(s.ams?.tray_now ?? 255));
  const printing = $derived(['RUNNING', 'PREPARE', 'PAUSE'].includes(s.gcode_state));

  // AMS HT units use ids >= 128 and hold a single tray.
  const globalTrayId = (amsId: number, trayId: number) => (amsId >= 128 ? amsId : amsId * 4 + trayId);

  async function load(amsId: number, trayId: number) {
    if (confirm('Load this filament? The printer will heat the nozzle and swap filament.')) {
      await send('loadFilament', { tray: globalTrayId(amsId, trayId) }, 'Load requested');
    }
  }

  async function unload() {
    if (confirm('Unload the current filament?')) await send('unloadFilament', {}, 'Unload requested');
  }
</script>

{#if units.length > 0 || external}
  <section class="card stack">
    <header style="margin:0">
      <h2>Filament</h2>
      <button class="small" onclick={unload} disabled={!online || printing || trayNow === 255}>Unload</button>
    </header>

    <div class="units">
    {#each units as unit (unit.id)}
      <div class="unit">
        <div class="row small muted">
          <b style="color:var(--text)">AMS {Number(unit.id) >= 128 ? `HT ${Number(unit.id) - 127}` : Number(unit.id) + 1}</b>
          {#if unit.humidity_raw}<span>💧 {unit.humidity_raw}%</span>
          {:else if unit.humidity}<span>💧 {AMS_HUMIDITY[unit.humidity] ?? unit.humidity}</span>{/if}
          {#if unit.temp && unit.temp !== '0.0'}<span>🌡 {unit.temp}°C</span>{/if}
        </div>
        <div class="trays">
          {#each unit.tray ?? [] as tray (tray.id)}
            {@const gid = globalTrayId(Number(unit.id), Number(tray.id))}
            {@const empty = !tray.tray_type}
            <button
              class="tray"
              class:loaded={gid === trayNow}
              disabled={!online || printing || empty || gid === trayNow}
              onclick={() => load(Number(unit.id), Number(tray.id))}
              title={empty ? 'Empty slot' : `Load ${tray.tray_sub_brands || tray.tray_type}`}
            >
              <span class="swatch" style="background:{empty ? 'transparent' : trayColor(tray.tray_color)}"></span>
              <span class="type">{empty ? 'Empty' : tray.tray_type}</span>
              <span class="muted brand">{tray.tray_sub_brands || ' '}</span>
              {#if !empty && typeof tray.remain === 'number' && tray.remain >= 0}
                <span class="muted small">{tray.remain}%</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/each}
    </div>

    {#if external}
      <div class="row small">
        <span class="muted">External spool</span>
        <span class="swatch" style="background:{external.tray_type ? trayColor(external.tray_color) : 'transparent'}"></span>
        <span>{external.tray_type || 'Empty'}</span>
        {#if trayNow === 254}<span class="badge plain tone-ok">Loaded</span>{/if}
      </div>
    {/if}
    <p class="muted small" style="margin:0">Click a slot to load it.</p>
  </section>
{/if}

<style>
  .units {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr));
    gap: 16px;
  }
  .unit {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .trays {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
  }
  .tray {
    flex-direction: column;
    gap: 4px;
    padding: 10px 6px;
    white-space: normal;
  }
  .tray:disabled {
    opacity: 1;
    cursor: default;
  }
  .tray.loaded {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .swatch {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid var(--border);
    display: inline-block;
  }
  .row .swatch {
    width: 16px;
    height: 16px;
  }
  .type {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .brand {
    font-size: 0.72rem;
    overflow-wrap: anywhere;
    text-align: center;
    line-height: 1.2;
    min-height: 1.2em;
  }
  @media (max-width: 420px) {
    .trays {
      gap: 6px;
    }
    .tray {
      padding: 8px 4px;
    }
  }
</style>
