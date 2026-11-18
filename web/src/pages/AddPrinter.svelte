<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { api, type DiscoveredPrinter } from '../lib/api';
  import { navigate } from '../lib/router.svelte';
  import { toast } from '../lib/toast.svelte';
  import PrinterForm, { type PrinterFormValue } from '../components/PrinterForm.svelte';

  let discovered = $state<DiscoveredPrinter[]>([]);
  let scanning = $state(false);
  let scanned = $state(false);
  let scanError = $state<string | null>(null);

  // Access-code dialog for a discovered printer.
  let selected = $state<DiscoveredPrinter | null>(null);
  let name = $state('');
  let accessCode = $state('');
  let connecting = $state(false);
  let connectError = $state<string | null>(null);
  let codeInput = $state<HTMLInputElement>();

  // Manual entry.
  let showManual = $state(false);
  let skipTest = $state(false);
  let form = $state<PrinterFormValue>({ name: '', model: '', serial: '', ip: '', accessCode: '', camera: 'auto' });

  async function scan() {
    scanning = true;
    scanError = null;
    try {
      const found = await api<DiscoveredPrinter[]>('/api/printers/discover', { method: 'POST' });
      // Merge so printers seen in earlier scans don't disappear.
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
        },
      });
      toast(`Connected to ${name}`, 'success');
      navigate(`/printer/${id}`);
    } catch (err) {
      connectError = (err as Error).message;
    } finally {
      connecting = false;
    }
  }

  async function saveManual(value: PrinterFormValue) {
    const { id } = await api<{ id: number }>('/api/printers', { body: { ...value, skipTest } });
    toast('Printer added', 'success');
    navigate(`/printer/${id}`);
  }
</script>

<div class="container stack narrow">
  <div class="row">
    <div class="stack" style="gap:0">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Printers</a><span>›</span></nav>
      <h1>Add printer</h1>
    </div>
  </div>

  <section class="card stack">
    <header style="margin:0">
      <h2>Printers on your network</h2>
      <button class="small" onclick={scan} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan again'}</button>
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
            <span class="small tone-warn">Cloud mode: enable LAN Only Mode (and Developer Mode) on the printer.</span>
          {/if}
        </div>
        <span class="spacer"></span>
        {#if p.alreadyAdded}
          <span class="badge plain">Already added</span>
        {:else}
          <button class="primary" onclick={() => choose(p)}>Connect</button>
        {/if}
      </div>
    {/each}

    {#if scanning && discovered.length === 0}
      <div class="searching muted"><span class="spinner"></span> Looking for printers (a few seconds)…</div>
    {:else if scanned && !scanning && discovered.length === 0}
      <div class="muted small">
        No printers found. Make sure the printer is on, connected to the same network, and in LAN mode — or add it
        manually below. (In Docker, discovery needs host networking.)
      </div>
    {/if}
  </section>

  <section class="card stack">
    <button class="ghost manual-toggle" onclick={() => (showManual = !showManual)}>
      {showManual ? '▾' : '▸'} Add manually (IP address, serial, access code)
    </button>
    {#if showManual}
      <PrinterForm bind:value={form} submitLabel="Add printer" onSubmit={saveManual} />
      <label class="row small muted"><input type="checkbox" bind:checked={skipTest} /> Save without checking the connection</label>
    {/if}
  </section>
</div>

{#if selected}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={(e) => e.target === e.currentTarget && !connecting && (selected = null)}>
    <form class="modal stack" onsubmit={connect}>
      <h2>Connect to {selected.name}</h2>
      <span class="muted small">{selected.model} · {selected.ip} · {selected.serial}</span>

      <label class="field">
        Access code
        <input
          bind:this={codeInput}
          bind:value={accessCode}
          class="mono code"
          required
          minlength="8"
          maxlength="8"
          autocomplete="off"
          spellcheck="false"
          placeholder="12345678"
          disabled={connecting}
        />
      </label>
      <p class="muted small" style="margin:0">
        Shown on the printer's screen under <i>Settings → Network</i> (LAN Only Mode / Access Code).
      </p>

      <label class="field">
        Name
        <input bind:value={name} maxlength="64" disabled={connecting} />
      </label>

      {#if connectError}<div class="alert error">{connectError}</div>{/if}

      <div class="row">
        <span class="spacer"></span>
        <button type="button" onclick={() => (selected = null)} disabled={connecting}>Cancel</button>
        <button class="primary" disabled={connecting || accessCode.trim().length !== 8}>
          {#if connecting}<span class="spinner"></span> Checking…{:else}Connect{/if}
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
