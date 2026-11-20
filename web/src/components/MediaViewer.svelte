<script lang="ts">
  import { joinPath, mediaOf } from '../../../shared/files.ts';
  import { t } from '../lib/i18n.svelte';

  let {
    printerId,
    dir,
    items,
    index = $bindable(),
    onClose,
  }: { printerId: number; dir: string; items: string[]; index: number; onClose: () => void } = $props();

  const name = $derived(items[index]);
  const full = $derived(joinPath(dir, name));
  const src = $derived(`/api/printers/${printerId}/files/stream?path=${encodeURIComponent(full)}`);
  const media = $derived(mediaOf(name));
  const kind = $derived(media?.kind ?? null);
  // X1-series timelapses have a matching thumbnail in /timelapse/thumbnail/<name>.jpg
  const poster = $derived(
    dir.startsWith('/timelapse') && kind === 'video'
      ? `/api/printers/${printerId}/files/stream?path=${encodeURIComponent(
          `/timelapse/thumbnail/${name.replace(/\.[^.]+$/, '')}.jpg`,
        )}`
      : undefined,
  );
  let failed = $state(false);

  $effect(() => {
    void src;
    failed = false;
  });

  const prev = () => index > 0 && (index -= 1);
  const next = () => index < items.length - 1 && (index += 1);

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowLeft' && kind === 'image') prev();
    else if (e.key === 'ArrowRight' && kind === 'image') next();
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="modal-backdrop" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <div class="viewer" role="dialog" aria-modal="true" aria-label={name}>
    <header>
      <b class="title" title={full}>{name}</b>
      <span class="muted small">{index + 1} / {items.length}</span>
      <span class="spacer"></span>
      <button class="small" onclick={prev} disabled={index === 0} title={t('media.previous')} aria-label={t('media.previous')}>◀</button>
      <button class="small" onclick={next} disabled={index === items.length - 1} title={t('media.next')} aria-label={t('media.next')}>▶</button>
      <a class="btn small" href="/api/printers/{printerId}/files/download?path={encodeURIComponent(full)}" title={t('common.download')} aria-label={t('common.download')}>⬇</a>
      <button class="small" onclick={onClose} title={t('common.closeEsc')} aria-label={t('common.close')}>✕</button>
    </header>

    <div class="stage">
      {#key src}
        {#if failed}
          <div class="muted">{t('media.failed')}</div>
        {:else if kind === 'video'}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video {src} {poster} controls autoplay playsinline preload="metadata" onerror={() => (failed = true)}></video>
        {:else if kind === 'image'}
          <img {src} alt={name} onerror={() => (failed = true)} />
        {/if}
      {/key}
    </div>

    {#if media?.transcoded}
      <p class="muted small note">{t('media.transcoded')}</p>
    {/if}
  </div>
</div>

<style>
  .viewer {
    width: min(1200px, 100%);
    max-height: calc(100vh - 32px);
    max-height: calc(100dvh - 32px);
    display: flex;
    flex-direction: column;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .stage {
    background: #000;
    display: grid;
    place-items: center;
    min-height: 240px;
    flex: 1;
    overflow: hidden;
  }
  video,
  img {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 140px);
    max-height: calc(100dvh - 140px);
  }
  .note {
    margin: 0;
    padding: 8px 12px;
  }
</style>
