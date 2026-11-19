<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { decodePickMap, objectAt, type JobObjects } from '../lib/skip-objects';

  let {
    printerId,
    state: s,
    online,
    onSkip,
    onClose,
  }: {
    printerId: number;
    state: Record<string, any>;
    online: boolean;
    onSkip: (ids: number[]) => Promise<boolean>;
    onClose: () => void;
  } = $props();

  const base = $derived(`/api/printers/${printerId}/job`);
  let job = $state<JobObjects | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let selected = $state<number[]>([]);
  let hovered = $state<number | null>(null);
  let busy = $state(false);
  let pick = $state.raw<{ ids: Int32Array; width: number; height: number } | null>(null);
  let pickError = $state(false);
  let plateFailed = $state(false);
  let overlay = $state<HTMLCanvasElement>();

  const running = $derived(s.gcode_state === 'RUNNING' || s.gcode_state === 'PAUSE');
  // Live `s_obj` from the printer plus what the file/server already knew.
  const skipped = $derived(
    new Set<number>([
      ...(job?.objects.filter((o) => o.skipped).map((o) => o.id) ?? []),
      ...(Array.isArray(s.s_obj) ? s.s_obj.map(Number) : []),
    ]),
  );
  const remaining = $derived(job ? job.objects.filter((o) => !skipped.has(o.id)).length : 0);
  const showImage = $derived(Boolean(job && ((job.hasPlateImage && !plateFailed) || (job.hasPickMap && !pickError))));

  async function load(refresh = false) {
    loading = true;
    error = null;
    pick = null;
    pickError = false;
    plateFailed = false;
    try {
      job = await api<JobObjects>(`${base}/objects${refresh ? '?refresh=1' : ''}`);
      selected = selected.filter((id) => job!.objects.some((o) => o.id === id));
      if (job.hasPickMap) void loadPickMap(new Set(job.objects.map((o) => o.id)));
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  /** Decode the pick map once into an id per pixel (offscreen canvas). */
  async function loadPickMap(known: Set<number>) {
    try {
      const img = new Image();
      img.src = `${base}/pick.png`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const ids = decodePickMap(data, known);
      if (!ids.some((id) => id !== 0)) throw new Error('pick map does not match the object list');
      pick = { ids, width: canvas.width, height: canvas.height };
    } catch {
      pickError = true; // fall back to the list
    }
  }

  onMount(() => {
    void load();
  });

  function rgb(cssVar: string): [number, number, number] {
    const v = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    const m = /^#([0-9a-f]{6})$/i.exec(v);
    const n = m ? parseInt(m[1], 16) : 0x19b26b;
    return [n >> 16, (n >> 8) & 0xff, n & 0xff];
  }

  // Paint selection / skipped / hover state over the plate thumbnail.
  $effect(() => {
    if (!overlay || !pick) return;
    const { ids, width, height } = pick;
    overlay.width = width;
    overlay.height = height;
    const ctx = overlay.getContext('2d')!;
    const out = ctx.createImageData(width, height);
    const accent = rgb('--accent');
    const plain = !job?.hasPlateImage || plateFailed; // no thumbnail: draw the objects ourselves
    const sel = new Set(selected);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      const o = i * 4;
      let c: [number, number, number, number] | null = null;
      if (skipped.has(id)) {
        const x = i % width;
        const y = (i / width) | 0;
        c = ((x + y) >> 2) & 1 ? [20, 20, 20, 200] : [90, 90, 90, 150]; // hatched
      } else if (sel.has(id)) {
        c = [accent[0], accent[1], accent[2], 170];
      } else if (id === hovered) {
        c = [accent[0], accent[1], accent[2], 80];
      } else if (plain) {
        c = [150, 158, 168, 255];
      }
      if (c) out.data.set(c, o);
    }
    ctx.putImageData(out, 0, 0);
  });

  function pickedAt(event: MouseEvent | PointerEvent) {
    if (!pick || !overlay) return null;
    const rect = overlay.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * pick.width;
    const y = ((event.clientY - rect.top) / rect.height) * pick.height;
    return objectAt(pick.ids, pick.width, x, y, Math.max(2, Math.round(pick.width * 0.02)));
  }

  function toggle(id: number) {
    if (skipped.has(id)) return;
    selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
  }

  function onPlateClick(event: MouseEvent) {
    const id = pickedAt(event);
    if (id !== null) toggle(id);
  }

  function onPlateMove(event: PointerEvent) {
    if (event.pointerType !== 'mouse') return;
    hovered = pickedAt(event);
  }

  async function confirmSkip() {
    const ids = selected.filter((id) => !skipped.has(id));
    if (!ids.length) return;
    const n = ids.length;
    const all = n >= remaining ? ' That is every remaining object, the print will end.' : '';
    if (!confirm(`Skip ${n} object${n === 1 ? '' : 's'}? This cannot be undone.${all}`)) return;
    busy = true;
    const ok = await onSkip(ids);
    busy = false;
    if (ok) onClose();
  }

  const nameOf = (id: number | null) => job?.objects.find((o) => o.id === id)?.name ?? '';
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onClose()} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <div class="modal stack skip" role="dialog" aria-modal="true" aria-labelledby="skip-title">
    <header class="row">
      <h2 id="skip-title">Skip objects</h2>
      <span class="spacer"></span>
      {#if job}<span class="muted small">Plate {job.plate}</span>{/if}
      <button class="small ghost" onclick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
    </header>

    {#if loading && !job}
      <div class="muted small">Reading the project file from the printer…</div>
    {:else if error}
      <div class="alert error small">{error}</div>
      <div class="row">
        <span class="spacer"></span>
        <button class="small" onclick={() => load(true)} disabled={loading}>{loading ? 'Retrying…' : 'Retry'}</button>
      </div>
    {:else if job}
      {#if showImage}
        <div class="plate" class:plain={!job.hasPlateImage || plateFailed}>
          {#if job.hasPlateImage && !plateFailed}
            <img src="{base}/plate.png" alt="Plate {job.plate}" onerror={() => (plateFailed = true)} draggable="false" />
          {/if}
          {#if pick}
            <!-- The checkbox list below is the keyboard / screen reader path. -->
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <canvas
              bind:this={overlay}
              onclick={onPlateClick}
              onpointermove={onPlateMove}
              onpointerleave={() => (hovered = null)}
              class:pointer={hovered !== null}
            ></canvas>
          {/if}
        </div>
        <div class="muted small hint">
          {#if pick}
            {hovered !== null ? nameOf(hovered) : 'Tap objects on the plate or tick them below.'}
          {:else if job.hasPickMap && !pickError}
            Loading the object map…
          {:else}
            No usable object map in this project: pick the objects from the list.
          {/if}
        </div>
      {/if}

      <ul class="objects">
        {#each job.objects as o (o.id)}
          {@const done = skipped.has(o.id)}
          <li>
            <label class="row" class:done>
              <input
                type="checkbox"
                checked={done || selected.includes(o.id)}
                disabled={done}
                onchange={() => toggle(o.id)}
              />
              <span class="name">{o.name}</span>
              <span class="muted small">{done ? 'skipped' : `#${o.id}`}</span>
            </label>
          </li>
        {/each}
      </ul>

      {#if !running}<div class="alert warn small">The print is no longer running.</div>{/if}

      <div class="row">
        <span class="muted small">{selected.length} selected · {remaining} remaining</span>
        <span class="spacer"></span>
        <button onclick={onClose}>Cancel</button>
        <button class="danger" onclick={confirmSkip} disabled={!online || !running || busy || selected.length === 0}>
          Skip {selected.length || ''} object{selected.length === 1 ? '' : 's'}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .skip {
    width: min(560px, 100%);
  }
  .skip > header {
    flex-wrap: nowrap;
  }
  .plate {
    position: relative;
    width: min(100%, 420px);
    margin: 0 auto;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--card-2);
    user-select: none;
    -webkit-user-select: none;
    touch-action: manipulation;
  }
  .plate img {
    display: block;
    width: 100%;
    height: auto;
  }
  .plate canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    cursor: crosshair;
  }
  .plate canvas.pointer {
    cursor: pointer;
  }
  /* Without a thumbnail the canvas sets the size. */
  .plate.plain canvas {
    position: static;
    display: block;
    height: auto;
  }
  .hint {
    text-align: center;
    min-height: 1.3em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .objects {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 240px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .objects li + li {
    border-top: 1px solid var(--border);
  }
  .objects label {
    padding: 8px 10px;
    flex-wrap: nowrap;
    cursor: pointer;
  }
  .objects label.done {
    cursor: default;
    opacity: 0.6;
  }
  .objects label.done .name {
    text-decoration: line-through;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  @media (max-width: 700px) {
    .objects label {
      padding: 10px;
    }
  }
</style>
