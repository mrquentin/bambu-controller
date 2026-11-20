<script lang="ts">
  import { api, type RemoteFile } from '../lib/api';
  import { formatBytes } from '../lib/bambu';
  import { toast, toastError } from '../lib/toast.svelte';
  import { t } from '../lib/i18n.svelte';
  import { confirmAction } from '../lib/confirm.svelte';
  import MediaViewer, { mediaKind } from './MediaViewer.svelte';
  import Trans from './Trans.svelte';

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

  // Only the latest listing request may update the view (fast clicks between folders).
  let loadSeq = 0;
  async function load(dir = path) {
    const seq = ++loadSeq;
    loading = true;
    error = null;
    try {
      const listing = await api<RemoteFile[]>(`/api/printers/${printerId}/files?path=${q(dir)}`);
      if (seq !== loadSeq) return;
      files = listing;
      path = dir;
    } catch (err) {
      if (seq === loadSeq) error = (err as Error).message;
    } finally {
      if (seq === loadSeq) loading = false;
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
    const ok = await confirmAction({
      title: t('files.confirmDeleteTitle'),
      message: t('files.confirmDelete', { name: file.name }),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/printers/${printerId}/files?path=${q(join(path, file.name))}`, { method: 'DELETE' });
      toast(t('files.deleted'), 'success');
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
      toast(t('files.uploaded', { name: file.name }), 'success');
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
      toast(t('files.printStarted'), 'success');
      printTarget = null;
    } catch (err) {
      toastError(err);
    }
  }
</script>

<section class="card stack">
  <header style="margin:0">
    <h2>{t('files.title')}</h2>
    <div class="row">
      <!-- Disabled while a folder loads: `path` only switches once its listing arrives. -->
      <label class="btn small" class:disabled={!online || uploading || loading}>
        {uploading ? t('files.uploading') : t('files.upload')}
        <input type="file" hidden onchange={upload} disabled={!online || uploading || loading} />
      </label>
      <button class="small" onclick={() => load()} disabled={!online || loading}>
        {loading ? t('common.loading') : t('common.reload')}
      </button>
    </div>
  </header>

  {#if files === null && loading}
    <div class="muted small">{t('files.connecting')}</div>
  {:else if files === null && !online}
    <div class="muted small">{t('files.offline')}</div>
  {/if}

  {#if files !== null || error}
    <div class="row">
      {#each SHORTCUTS as dir}
        <button class="small" class:active={path === dir} onclick={() => load(dir)} disabled={!online}>{dir}</button>
      {/each}
    </div>
    <div class="row small">
      {#if path !== '/'}<button class="small ghost" onclick={up} title={t('files.parent')} aria-label={t('files.parent')}>↑</button>{/if}
      <code>{path}</code>
    </div>
  {/if}

  {#if error}<div class="alert error small">{error}</div>{/if}

  {#if files && files.length === 0}
    <div class="muted small">{t('files.emptyFolder')}</div>
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
                    <button class="small primary" onclick={() => (printTarget = join(path, f.name))} disabled={!online}>{t('files.print')}</button>
                  {/if}
                  {#if mediaKind(f.name)}
                    {@const label = mediaKind(f.name) === 'video' ? t('files.play') : t('files.view')}
                    <button class="small" onclick={() => openViewer(f.name)} title={label} aria-label={label}>▶</button>
                  {/if}
                  <a class="btn small" href="/api/printers/{printerId}/files/download?path={q(join(path, f.name))}" title={t('common.download')} aria-label={t('common.download')}>⬇</a>
                  <button class="small danger" onclick={() => remove(f)} title={t('common.delete')} aria-label={t('common.delete')}>✕</button>
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

<svelte:window onkeydown={(e) => e.key === 'Escape' && printTarget && (printTarget = null)} />

{#if printTarget}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={(e) => e.target === e.currentTarget && (printTarget = null)}>
    <div class="modal stack" role="dialog" aria-modal="true" aria-labelledby="print-title">
      <h2 id="print-title">{t('files.startPrint')}</h2>
      <code class="small">{printTarget}</code>
      <label class="field">
        {t('files.plate')}
        <input type="number" min="1" max="99" bind:value={opts.plate} />
      </label>
      <label class="row"><input type="checkbox" bind:checked={opts.useAms} /> {t('files.useAms')}</label>
      <label class="row"><input type="checkbox" bind:checked={opts.bedLeveling} /> {t('files.bedLeveling')}</label>
      <label class="row"><input type="checkbox" bind:checked={opts.flowCali} /> {t('files.flowCali')}</label>
      <label class="row"><input type="checkbox" bind:checked={opts.vibrationCali} /> {t('files.vibrationCali')}</label>
      <label class="row"><input type="checkbox" bind:checked={opts.timelapse} /> {t('files.timelapse')}</label>
      <p class="muted small" style="margin:0">
        <Trans key="files.printHint">{#snippet ext()}<code>.gcode.3mf</code>{/snippet}</Trans>
      </p>
      <div class="row">
        <span class="spacer"></span>
        <button onclick={() => (printTarget = null)}>{t('common.cancel')}</button>
        <button class="primary" onclick={startPrint}>{t('files.startPrint')}</button>
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
  @media (max-width: 700px) {
    .table-wrap {
      max-height: none;
      min-height: 0;
    }
    tr {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding: 6px 0;
    }
    td {
      border-bottom: none;
      padding: 2px 4px;
    }
    td.name {
      grid-column: 1 / -1;
    }
    .actions > * {
      margin-left: 6px;
    }
  }
</style>
