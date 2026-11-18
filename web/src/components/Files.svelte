<script lang="ts">
  import { api, type RemoteFile } from '../lib/api';
  import { formatBytes } from '../lib/bambu';
  import { toast, toastError } from '../lib/toast.svelte';
  import MediaViewer, { mediaKind } from './MediaViewer.svelte';

  let { printerId, online }: { printerId: number; online: boolean } = $props();

  const SHORTCUTS = ['/', '/cache', '/model', '/timelapse'];

  let path = $state('/');
  let files = $state<RemoteFile[] | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let uploading = $state(false);
  let printTarget = $state<string | null>(null);
  let opts = $state({ plate: 1, bedLeveling: true, timelapse: false, useAms: true, flowCali: true, vibrationCali: false });

  // Media viewer: plays videos / shows images from the current folder.
  const mediaFiles = $derived((files ?? []).filter((f) => !f.isDirectory && mediaKind(f.name)).map((f) => f.name));
  let viewerIndex = $state<number | null>(null);
  const openViewer = (name: string) => (viewerIndex = mediaFiles.indexOf(name));

  const join = (dir: string, name: string) => `${dir === '/' ? '' : dir}/${name}`;
  const q = (p: string) => encodeURIComponent(p);

  async function load(dir = path) {
    loading = true;
    error = null;
    try {
      files = await api<RemoteFile[]>(`/api/printers/${printerId}/files?path=${q(dir)}`);
      path = dir;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  function up() {
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    load(`/${parts.join('/')}`);
  }

  // Load the listing as soon as the tab opens (or once the printer comes online).
  let autoLoaded = false;
  $effect(() => {
    if (online && !autoLoaded) {
      autoLoaded = true;
      load('/');
    }
  });

  async function remove(file: RemoteFile) {
    if (!confirm(`Delete ${file.name} from the printer?`)) return;
    try {
      await api(`/api/printers/${printerId}/files?path=${q(join(path, file.name))}`, { method: 'DELETE' });
      toast('File deleted', 'success');
      load();
    } catch (err) {
      toastError(err);
    }
  }

  async function upload(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploading = true;
    try {
      const body = new FormData();
      body.append('file', file);
      await api(`/api/printers/${printerId}/files/upload?path=${q(path)}`, { body });
      toast(`Uploaded ${file.name}`, 'success');
      load();
    } catch (err) {
      toastError(err);
    } finally {
      uploading = false;
      input.value = '';
    }
  }

  async function startPrint() {
    if (!printTarget) return;
    try {
      await api(`/api/printers/${printerId}/print`, { body: { path: printTarget, ...opts } });
      toast('Print started', 'success');
      printTarget = null;
    } catch (err) {
      toastError(err);
    }
  }
</script>

<section class="card stack">
  <header style="margin:0">
    <h2>Files</h2>
    <div class="row">
      <label class="btn small" class:disabled={!online || uploading}>
        {uploading ? 'Uploading…' : 'Upload'}
        <input type="file" hidden onchange={upload} disabled={!online || uploading} />
      </label>
      <button class="small" onclick={() => load()} disabled={!online || loading}>
        {loading ? 'Loading…' : 'Reload'}
      </button>
    </div>
  </header>

  {#if files === null && loading}
    <div class="muted small">Connecting to the printer's storage…</div>
  {:else if files === null && !online}
    <div class="muted small">The printer is offline.</div>
  {/if}

  {#if files !== null || error}
    <div class="row">
      {#each SHORTCUTS as dir}
        <button class="small" class:active={path === dir} onclick={() => load(dir)} disabled={!online}>{dir}</button>
      {/each}
    </div>
    <div class="row small">
      {#if path !== '/'}<button class="small ghost" onclick={up}>↑</button>{/if}
      <code>{path}</code>
    </div>
  {/if}

  {#if error}<div class="alert error small">{error}</div>{/if}

  {#if files && files.length === 0}
    <div class="muted small">Empty folder.</div>
  {:else if files}
    <div class="table-wrap">
      <table>
        <tbody>
          {#each files as f (f.name)}
            <tr>
              <td class="name">
                {#if f.isDirectory}
                  <button class="link" onclick={() => load(join(path, f.name))}>📁 {f.name}</button>
                {:else if mediaKind(f.name)}
                  <button class="link" onclick={() => openViewer(f.name)}>
                    {mediaKind(f.name) === 'video' ? '🎬' : '🖼'} {f.name}
                  </button>
                {:else}
                  <span>{f.name}</span>
                {/if}
              </td>
              <td class="muted small nowrap">{f.isDirectory ? '' : formatBytes(f.size)}</td>
              <td class="actions">
                {#if !f.isDirectory}
                  {#if /\.3mf$/i.test(f.name)}
                    <button class="small primary" onclick={() => (printTarget = join(path, f.name))} disabled={!online}>Print</button>
                  {/if}
                  {#if mediaKind(f.name)}
                    <button class="small" onclick={() => openViewer(f.name)} title={mediaKind(f.name) === 'video' ? 'Play' : 'View'}>▶</button>
                  {/if}
                  <a class="btn small" href="/api/printers/{printerId}/files/download?path={q(join(path, f.name))}">⬇</a>
                  <button class="small danger" onclick={() => remove(f)} title="Delete">✕</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

{#if viewerIndex !== null && viewerIndex >= 0}
  <MediaViewer {printerId} dir={path} items={mediaFiles} bind:index={viewerIndex} onClose={() => (viewerIndex = null)} />
{/if}

{#if printTarget}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={(e) => e.target === e.currentTarget && (printTarget = null)}>
    <div class="modal stack">
      <h2>Start print</h2>
      <code class="small">{printTarget}</code>
      <label class="field">
        Plate number
        <input type="number" min="1" max="99" bind:value={opts.plate} />
      </label>
      <label class="row"><input type="checkbox" bind:checked={opts.useAms} /> Use AMS</label>
      <label class="row"><input type="checkbox" bind:checked={opts.bedLeveling} /> Bed leveling</label>
      <label class="row"><input type="checkbox" bind:checked={opts.flowCali} /> Flow calibration</label>
      <label class="row"><input type="checkbox" bind:checked={opts.vibrationCali} /> Vibration compensation</label>
      <label class="row"><input type="checkbox" bind:checked={opts.timelapse} /> Timelapse</label>
      <p class="muted small" style="margin:0">
        The file must be a sliced <code>.gcode.3mf</code>. AMS slots are used in the order chosen when slicing.
      </p>
      <div class="row">
        <span class="spacer"></span>
        <button onclick={() => (printTarget = null)}>Cancel</button>
        <button class="primary" onclick={startPrint}>Start print</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .table-wrap {
    max-height: calc(100vh - 320px);
    min-height: 200px;
    overflow: auto;
  }
  .name {
    word-break: break-all;
  }
  .actions {
    text-align: right;
    white-space: nowrap;
  }
  .actions > * {
    margin-left: 4px;
  }
  .nowrap {
    white-space: nowrap;
  }
  button.link {
    background: none;
    border: none;
    padding: 0;
    color: var(--text);
  }
  button.link:hover {
    color: var(--accent);
    background: none;
  }
  label.btn.disabled {
    opacity: 0.45;
    pointer-events: none;
  }
</style>
