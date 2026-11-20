<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { DiscoveredPrinter } from '../../../shared/api.ts';
  import { PRINTER, type PrinterRequest } from '../../../shared/forms.ts';
  import { api } from '../lib/api';
  import { navigate } from '../lib/router.svelte';
  import { toast } from '../lib/toast.svelte';
  import { t } from '../lib/i18n.svelte';
  import PrinterForm, { type PrinterFormValue } from '../components/PrinterForm.svelte';
  import Trans from '../components/Trans.svelte';

  let discovered = $state<DiscoveredPrinter[]>([]);
  let scanning = $state(false);
  let scanned = $state(false);
  let scanError = $state<string | null>(null);

  let selected = $state<DiscoveredPrinter | null>(null);
  let name = $state('');
  let accessCode = $state('');
  let connecting = $state(false);
  let connectError = $state<string | null>(null);
  let codeInput = $state<HTMLInputElement>();

  let showManual = $state(false);
  let skipTest = $state(false);
  let form = $state<PrinterFormValue>({
    name: '',
    model: '',
    serial: '',
    ip: '',
    accessCode: '',
    camera: 'auto',
    tlsVerify: true,
  });
  let tlsVerify = $state(true);

  async function scan() {
    scanning = true;
    scanError = null;
    try {
      const found = await api<DiscoveredPrinter[]>('/api/printers/discover', { method: 'POST' });
      const bySerial = new Map(discovered.map((p) => [p.serial, p]));
      for (const p of found) bySerial.set(p.serial, p);
      discovered = [...bySerial.values()];
    } catch (err) {
      scanError = (err as Error).message;
    } finally {
      scanning = false;
      scanned = true;
    }
  }

  onMount(scan);

  async function choose(p: DiscoveredPrinter) {
    selected = p;
    name = p.name;
    accessCode = '';
    connectError = null;
    await tick();
    codeInput?.focus();
  }

  async function connect(event: SubmitEvent) {
    event.preventDefault();
    if (!selected) return;
    connecting = true;
    connectError = null;
    try {
      const { id } = await api<{ id: number }>('/api/printers', {
        body: {
          name: name.trim() || selected.name,
          model: selected.model,
          serial: selected.serial,
          ip: selected.ip,
          accessCode: accessCode.trim(),
          camera: 'auto',
          tlsVerify,
        } satisfies PrinterRequest,
      });
      toast(t('addPrinter.connected', { name }), 'success');
      navigate(`/printer/${id}`);
    } catch (err) {
      connectError = (err as Error).message;
    } finally {
      connecting = false;
    }
  }

  async function saveManual(value: PrinterFormValue) {
    const { id } = await api<{ id: number }>('/api/printers', { body: { ...value, skipTest } satisfies PrinterRequest });
    toast(t('addPrinter.added'), 'success');
    navigate(`/printer/${id}`);
  }
</script>

<div class="container stack narrow">
  <div class="row">
    <div class="stack" style="gap:0">
      <nav class="crumbs" aria-label={t('common.breadcrumb')}><a href="#/">{t('nav.printers')}</a><span>›</span></nav>
      <h1>{t('printers.add')}</h1>
    </div>
  </div>

  <section class="card stack">
    <header style="margin:0">
      <h2>{t('addPrinter.onNetwork')}</h2>
      <button class="small" onclick={scan} disabled={scanning}>{scanning ? t('addPrinter.scanning') : t('addPrinter.scanAgain')}</button>
    </header>

    {#if scanError}<div class="alert error">{scanError}</div>{/if}

    {#each discovered as p (p.serial)}
      <div class="found">
        <div class="icon">🖨</div>
        <div class="stack" style="gap:2px;min-width:0">
          <b>{p.name}</b>
          <span class="muted small">
            {p.model} · <span class="mono">{p.ip}</span> · <span class="mono">{p.serial}</span>
          </span>
          {#if p.connectMode && p.connectMode !== 'lan'}
            <span class="small tone-warn">{t('addPrinter.cloudMode')}</span>
          {/if}
        </div>
        <span class="spacer"></span>
        {#if p.alreadyAdded}
          <span class="badge plain">{t('addPrinter.alreadyAdded')}</span>
        {:else}
          <button class="primary" onclick={() => choose(p)}>{t('addPrinter.connect')}</button>
        {/if}
      </div>
    {/each}

    {#if scanning && discovered.length === 0}
      <div class="searching muted"><span class="spinner"></span> {t('addPrinter.looking')}</div>
    {:else if scanned && !scanning && discovered.length === 0}
      <div class="muted small">{t('addPrinter.noneFound')}</div>
    {/if}
  </section>

  <section class="card stack">
    <button class="ghost manual-toggle" onclick={() => (showManual = !showManual)}>
      {showManual ? '▾' : '▸'} {t('addPrinter.manual')}
    </button>
    {#if showManual}
      <PrinterForm bind:value={form} submitLabel={t('printers.add')} onSubmit={saveManual} />
      <label class="row small muted"><input type="checkbox" bind:checked={skipTest} /> {t('addPrinter.skipTest')}</label>
    {/if}
  </section>
</div>

<svelte:window onkeydown={(e) => e.key === 'Escape' && selected && !connecting && (selected = null)} />

{#if selected}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={(e) => e.target === e.currentTarget && !connecting && (selected = null)}>
    <form class="modal stack" onsubmit={connect} aria-labelledby="connect-title">
      <h2 id="connect-title">{t('addPrinter.connectTo', { name: selected.name })}</h2>
      <span class="muted small">{selected.model} · {selected.ip} · {selected.serial}</span>

      <label class="field">
        {t('form.accessCode')}
        <input
          bind:this={codeInput}
          bind:value={accessCode}
          class="mono code"
          required
          minlength={PRINTER.accessCode.minLength}
          maxlength={PRINTER.accessCode.maxLength}
          autocomplete="off"
          spellcheck="false"
          placeholder="12345678"
          disabled={connecting}
        />
      </label>
      <p class="muted small" style="margin:0">
        <Trans key="addPrinter.codeHint">{#snippet path()}<i>{t('addPrinter.codePath')}</i>{/snippet}</Trans>
      </p>

      <label class="field">
        {t('common.name')}
        <input bind:value={name} maxlength={PRINTER.name.maxLength} disabled={connecting} />
      </label>

      {#if connectError}<div class="alert error">{connectError}</div>{/if}

      {#if !tlsVerify || /certificate/i.test(connectError ?? '')}
        <label class="row small">
          <input type="checkbox" bind:checked={tlsVerify} disabled={connecting} />
          {t('addPrinter.verifyCert')}
        </label>
      {/if}

      <div class="row">
        <span class="spacer"></span>
        <button type="button" onclick={() => (selected = null)} disabled={connecting}>{t('common.cancel')}</button>
        <button class="primary" disabled={connecting || accessCode.trim().length !== 8}>
          {#if connecting}<span class="spinner"></span> {t('addPrinter.checking')}{:else}{t('addPrinter.connect')}{/if}
        </button>
      </div>
    </form>
  </div>
{/if}

<style>
  .narrow {
    max-width: 820px;
  }
  .found {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-2);
  }
  .icon {
    font-size: 1.6rem;
  }
  .searching {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 0;
  }
  .manual-toggle {
    justify-content: flex-start;
    padding: 0;
    color: var(--muted);
  }
  .code {
    font-size: 1.4rem;
    letter-spacing: 0.25em;
    text-align: center;
  }
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    display: inline-block;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
