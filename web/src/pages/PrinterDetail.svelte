<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, api, type PrinterDetail } from '../lib/api';
  import { isGatewayError, reportServerReachable } from '../lib/connectivity.svelte';
  import { toast, toastError } from '../lib/toast.svelte';
  import { t, type MessageKey } from '../lib/i18n.svelte';
  import ConnectionBadge from '../components/ConnectionBadge.svelte';
  import Camera from '../components/Camera.svelte';
  import JobCard from '../components/JobCard.svelte';
  import Temperatures from '../components/Temperatures.svelte';
  import Fans from '../components/Fans.svelte';
  import Motion from '../components/Motion.svelte';
  import Ams from '../components/Ams.svelte';
  import Hms from '../components/Hms.svelte';
  import Files from '../components/Files.svelte';
  import Console from '../components/Console.svelte';
  import Info from '../components/Info.svelte';
  import History from '../components/History.svelte';

  type Tab = 'control' | 'files' | 'history' | 'info';
  let { id, tab }: { id: number; tab: Tab } = $props();

  const tabs: { id: Tab; label: MessageKey }[] = [
    { id: 'control', label: 'printer.tabControl' },
    { id: 'files', label: 'printer.tabFiles' },
    { id: 'history', label: 'printer.tabHistory' },
    { id: 'info', label: 'printer.tabInfo' },
  ];

  let data = $state<PrinterDetail | null>(null);
  let error = $state<string | null>(null);

  onMount(() => {
    let source: EventSource;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    function connect() {
      source = new EventSource(`/api/printers/${id}/events`);
      source.onmessage = (event) => {
        data = JSON.parse(event.data);
        error = null;
        reportServerReachable();
      };
      source.onerror = async () => {
        // Distinguish "not found / logged out" from transient network errors
        // (those show the offline banner and keep retrying).
        try {
          await api(`/api/printers/${id}`);
        } catch (err) {
          if (err instanceof ApiError && !isGatewayError(err.status)) {
            error = err.message;
            source.close();
            return;
          }
        }
        // The browser retries by itself unless the stream got an HTTP error.
        if (source.readyState === EventSource.CLOSED && !stopped) retry = setTimeout(connect, 5000);
      };
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      source.close();
    };
  });

  const online = $derived(data?.connection.status === 'online');
  const s = $derived(data?.state ?? {});

  async function send(action: string, params: Record<string, unknown> = {}, successMessage?: string) {
    try {
      await api(`/api/printers/${id}/command`, { body: { action, ...params } });
      if (successMessage) toast(successMessage, 'success');
      return true;
    } catch (err) {
      toastError(err);
      return false;
    }
  }
</script>

{#if error}
  <div class="container"><div class="alert error">{error}</div></div>
{:else if !data}
  <div class="empty">{t('printer.connecting')}</div>
{:else}
  <div class="container stack">
    <div class="row head">
      <div class="stack title" style="gap:0">
        <nav class="crumbs" aria-label={t('common.breadcrumb')}><a href="#/">{t('nav.printers')}</a><span>›</span></nav>
        <h1>{data.printer.name}</h1>
        <span class="muted small">{data.printer.model} · {data.printer.ip} · <span class="mono">{data.printer.serial}</span></span>
      </div>
      <span class="spacer"></span>
      <ConnectionBadge connection={data.connection} />
      <button class="small" onclick={() => send('refresh', {}, t('printer.refreshRequested'))} disabled={!online}>{t('printer.refresh')}</button>
      <a class="btn small" href="#/printer/{id}/edit">{t('common.edit')}</a>
    </div>

    {#if data.connection.status !== 'online' && data.connection.error}
      <div class="alert error">{data.connection.error}</div>
    {:else if data.connection.status !== 'online'}
      <div class="alert warn">{t('printer.notConnected', { ip: data.printer.ip })}</div>
    {/if}

    <nav class="tabs" aria-label={t('printer.sections')}>
      {#each tabs as tb}
        <a href="#/printer/{id}{tb.id === 'control' ? '' : `/${tb.id}`}" class:current={tab === tb.id} aria-current={tab === tb.id ? 'page' : undefined}>
          {t(tb.label)}
          {#if tb.id === 'control' && Array.isArray(s.hms) && s.hms.length > 0}<span class="dot" title={t('printer.healthAlerts')}></span>{/if}
        </a>
      {/each}
    </nav>

    {#if tab === 'control'}
      <!-- Row-based grid: cards that sit side by side share a row, so their
           bottoms line up without leaving a big gap under the shorter column. -->
      <div class="control">
        <div class="area-camera"><Camera printerId={id} kind={data.camera.kind} error={data.camera.error} /></div>
        <div class="area-side col">
          <Temperatures state={s} {online} {send} chamberControl={data.capabilities.chamberControl} />
          <Fans state={s} {online} {send} />
        </div>
        <div class="area-job"><JobCard state={s} {online} {send} printerId={id} log={data.log} /></div>
        <div class="area-motion"><Motion state={s} {online} {send} /></div>
        <div class="area-wide col"><Hms state={s} /><Ams state={s} {online} {send} /></div>
      </div>
    {:else if tab === 'files'}
      <Files printerId={id} {online} />
    {:else if tab === 'history'}
      <History printerId={id} refreshKey={s.gcode_state} />
    {:else}
      <div class="layout info">
        <div class="col"><Info state={s} modules={data.modules} connection={data.connection} /></div>
        <div class="col"><Console log={data.log} {online} {send} /></div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(320px, 1fr);
    gap: 16px;
    /* Columns share the row height; the last card in each column stretches
       so both columns end on the same line. */
    align-items: stretch;
  }
  .control {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(320px, 1fr);
    grid-template-areas:
      'camera side'
      'job motion'
      'wide wide';
    gap: 16px;
  }
  .area-camera {
    grid-area: camera;
  }
  .area-side {
    grid-area: side;
  }
  .area-job {
    grid-area: job;
  }
  .area-motion {
    grid-area: motion;
  }
  .area-wide {
    grid-area: wide;
  }
  .area-wide:empty {
    display: none;
  }
  /* Single cards fill their grid cell so neighbours end at the same line. */
  .control > div:not(.col) {
    display: flex;
    flex-direction: column;
  }
  .control > div:not(.col) > :global(*) {
    flex: 1;
  }
  .layout.info {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }
  .col > :global(:last-child) {
    flex: 1;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .head .title {
    min-width: 0;
    flex: 1 1 260px;
    overflow-wrap: anywhere;
  }
  .tabs a {
    position: relative;
    padding: 10px 16px;
    color: var(--muted);
    font-weight: 500;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tabs a:hover {
    color: var(--text);
    text-decoration: none;
  }
  .tabs a.current {
    color: var(--text);
    border-bottom-color: var(--accent);
  }
  .dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warn);
    margin-left: 4px;
    vertical-align: middle;
  }
  /* Tablet: camera spans the full width, the remaining cards pair up. */
  @media (max-width: 1100px) {
    .control {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      grid-template-areas:
        'camera camera'
        'side side'
        'job motion'
        'wide wide';
    }
    .area-side {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
  }
  @media (max-width: 900px) {
    .layout.info {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  /* Phone: a single column, ordered by what matters most while printing. */
  @media (max-width: 700px) {
    .control {
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas:
        'camera'
        'job'
        'side'
        'motion'
        'wide';
      gap: 12px;
    }
    .area-side {
      display: flex;
      gap: 12px;
    }
    .tabs a {
      padding: 10px 12px;
      white-space: nowrap;
    }
  }
</style>
