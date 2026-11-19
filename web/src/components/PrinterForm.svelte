<script lang="ts" module>
  export interface PrinterFormValue {
    name: string;
    model: string;
    serial: string;
    ip: string;
    accessCode: string;
    camera: 'auto' | 'jpeg' | 'rtsps' | 'none';
    tlsVerify: boolean;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';

  let {
    value = $bindable(),
    editing = false,
    submitLabel,
    onSubmit,
  }: {
    value: PrinterFormValue;
    editing?: boolean;
    submitLabel: string;
    onSubmit: (value: PrinterFormValue) => Promise<void>;
  } = $props();

  let models = $state<string[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    models = await api<string[]>('/api/models').catch(() => []);
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = null;
    try {
      await onSubmit(value);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<form class="stack" onsubmit={submit}>
  <div class="grid two">
    <label class="field">
      Name
      <input bind:value={value.name} required maxlength="64" placeholder="My printer" />
    </label>
    <label class="field">
      Model
      <select bind:value={value.model} required>
        <option value="" disabled>Select…</option>
        {#each models as m}<option value={m}>{m}</option>{/each}
        {#if value.model && !models.includes(value.model)}<option value={value.model}>{value.model}</option>{/if}
      </select>
    </label>
    <label class="field">
      IP address
      <input bind:value={value.ip} required placeholder="192.168.1.50" />
    </label>
    <label class="field">
      Serial number
      <input bind:value={value.serial} required class="mono" placeholder="01S00A000000000" />
    </label>
    <label class="field">
      Access code
      <input
        bind:value={value.accessCode}
        required={!editing}
        class="mono"
        autocomplete="off"
        placeholder={editing ? 'Leave blank to keep current' : '8 characters, from the printer screen'}
      />
    </label>
    <label class="field">
      Camera
      <select bind:value={value.camera}>
        <option value="auto">Auto (by model)</option>
        <option value="jpeg">JPEG stream (port 6000 — A1 / P1)</option>
        <option value="rtsps">RTSPS (port 322 — X1 / H2 / P2S)</option>
        <option value="none">Disabled</option>
      </select>
    </label>
  </div>

  <label class="row small">
    <input type="checkbox" bind:checked={value.tlsVerify} />
    <span>
      Verify printer certificate <span class="muted">(recommended — checks it is signed by Bambu Lab and matches the serial)</span>
    </span>
  </label>

  <p class="muted small">
    The access code and serial number are on the printer: <i>Settings → Network / LAN only mode</i> and
    <i>Settings → Device</i>. The access code changes whenever LAN mode is toggled.
  </p>

  {#if error}<div class="alert error">{error}</div>{/if}

  <div class="row">
    <button class="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
  </div>
</form>

<style>
  .two {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
</style>
