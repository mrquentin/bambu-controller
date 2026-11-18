<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type PrinterDetail } from '../lib/api';
  import { navigate } from '../lib/router.svelte';
  import { toast, toastError } from '../lib/toast.svelte';
  import PrinterForm, { type PrinterFormValue } from '../components/PrinterForm.svelte';

  let { id }: { id: number } = $props();

  let form = $state<PrinterFormValue | null>(null);
  // Saved name for the breadcrumb (not the live form field).
  let printerName = $state('');
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const d = await api<PrinterDetail>(`/api/printers/${id}`);
      printerName = d.printer.name;
      form = {
        name: d.printer.name,
        model: d.printer.model,
        serial: d.printer.serial,
        ip: d.printer.ip,
        accessCode: '',
        camera: d.printer.camera,
      };
    } catch (err) {
      error = (err as Error).message;
    }
  });

  async function save(value: PrinterFormValue) {
    await api(`/api/printers/${id}`, { method: 'PUT', body: value });
    toast('Printer updated', 'success');
    navigate(`/printer/${id}`);
  }

  async function remove() {
    if (!confirm(`Remove "${form?.name}"? This only deletes it from this app.`)) return;
    try {
      await api(`/api/printers/${id}`, { method: 'DELETE' });
      toast('Printer removed', 'success');
      navigate('/');
    } catch (err) {
      toastError(err);
    }
  }
</script>

<div class="container stack">
  <div class="row">
    <div class="stack" style="gap:0">
      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="#/">Printers</a><span>›</span>
        <a href="#/printer/{id}">{printerName || 'Printer'}</a><span>›</span>
      </nav>
      <h1>Edit printer</h1>
    </div>
  </div>
  {#if error}<div class="alert error">{error}</div>{/if}
  {#if form}
    <section class="card">
      <PrinterForm bind:value={form} editing submitLabel="Save changes" onSubmit={save} />
    </section>
    <section class="card row">
      <div class="stack" style="gap:2px">
        <h2>Remove printer</h2>
        <span class="muted small">Disconnects and deletes this printer from the app.</span>
      </div>
      <span class="spacer"></span>
      <button class="danger" onclick={remove}>Remove</button>
    </section>
  {/if}
</div>
