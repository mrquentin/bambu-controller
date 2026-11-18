<script lang="ts">
  let {
    printerId,
    kind,
    error,
  }: { printerId: number; kind: 'jpeg' | 'rtsps' | 'none'; error: string | null } = $props();

  let enabled = $state(localStorage.getItem('camera-autoplay') !== 'false');
  let nonce = $state(Date.now());
  let frame: HTMLDivElement;

  function toggle() {
    enabled = !enabled;
    nonce = Date.now();
    localStorage.setItem('camera-autoplay', String(enabled));
  }

  function reload() {
    nonce = Date.now();
  }

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else frame?.requestFullscreen();
  }

  // Free the upstream connection while the tab is hidden.
  let hidden = $state(document.hidden);
  $effect(() => {
    const onVisibility = () => {
      hidden = document.hidden;
      if (!hidden) reload();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });
</script>

<section class="card">
  <header>
    <h2>Camera</h2>
    <div class="row">
      {#if kind !== 'none'}
        <span class="muted small">{kind === 'jpeg' ? 'JPEG · port 6000' : 'RTSPS · port 322'}</span>
        <a class="btn small" href="/api/printers/{printerId}/camera/snapshot" download="snapshot.jpg">Snapshot</a>
        <button class="small" onclick={fullscreen} disabled={!enabled}>Fullscreen</button>
        <button class="small" onclick={toggle}>{enabled ? 'Stop' : 'Start'}</button>
      {/if}
    </div>
  </header>

  <div class="frame" bind:this={frame}>
    {#if kind === 'none'}
      <div class="placeholder muted">Camera disabled in printer settings</div>
    {:else if enabled && !hidden}
      <!-- The placeholder sits underneath; the first decoded frame paints over it. -->
      <div class="placeholder muted">
        {error ?? (kind === 'rtsps' ? 'Starting stream (ffmpeg)…' : 'Connecting to camera…')}
      </div>
      <img
        src="/api/printers/{printerId}/camera/stream?t={nonce}"
        alt=""
        onerror={() => setTimeout(reload, 3000)}
      />
    {:else}
      <button class="placeholder ghost" onclick={toggle}>▶ Start live view</button>
    {/if}
  </div>
  {#if kind === 'rtsps'}
    <p class="muted small" style="margin:8px 0 0">
      X1-series: enable <i>Settings → Network → LAN Mode Liveview</i> on the printer.
    </p>
  {/if}
</section>

<style>
  .frame {
    position: relative;
    aspect-ratio: 16 / 9;
    background: #000;
    border-radius: var(--radius-sm);
    overflow: hidden;
    display: grid;
    place-items: center;
  }
  .frame:fullscreen {
    border-radius: 0;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    grid-area: 1 / 1;
  }
  .placeholder {
    grid-area: 1 / 1;
    padding: 16px;
    text-align: center;
    font-size: 0.9rem;
  }
  button.placeholder {
    width: 100%;
    height: 100%;
    color: var(--muted);
  }
</style>
