<script lang="ts">
  import { onMount } from 'svelte';
  import type { PrinterDetail } from '../../../shared/api.ts';
  import { api } from '../lib/api';
  import { navigate } from '../lib/router.svelte';
  import { printerPage } from '../../../shared/pages.ts';
  import { toast, toastError } from '../lib/toast.svelte';
  import { t } from '../lib/i18n.svelte';
  import { confirmAction } from '../lib/confirm.svelte';
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
        tlsVerify: d.printer.tls_verify !== 0,
      };
    } catch (err) {
      error = (err as Error).message;
    }
  });

  async function save(value: PrinterFormValue) {
    await api(`/api/printers/${id}`, { method: 'PUT', body: value });
    toast(t('editPrinter.updated'), 'success');
    navigate(`/printer/${id}`);
  }

  async function remove() {
    const ok = await confirmAction({
      title: t('editPrinter.confirmRemoveTitle'),
      message: t('editPrinter.confirmRemove', { name: printerName }),
      confirmLabel: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/printers/${id}`, { method: 'DELETE' });
      toast(t('editPrinter.removed'), 'success');
      navigate('/');
    } catch (err) {
      toastError(err);
    }
  }
</script>

<div class="container stack">
  <div class="row">
    <div class="stack" style="gap:0">
      <nav class="crumbs" aria-label={t('common.breadcrumb')}>
        <a href="#/">{t('nav.printers')}</a><span>›</span>
        <a href={printerPage(id)}>{printerName || t('editPrinter.printer')}</a><span>›</span>
      </nav>
      <h1>{t('editPrinter.title')}</h1>
    </div>
  </div>
  {#if error}<div class="alert error">{error}</div>{/if}
  {#if form}
    <section class="card">
      <PrinterForm bind:value={form} editing submitLabel={t('editPrinter.save')} onSubmit={save} />
    </section>
    <section class="card row">
      <div class="stack" style="gap:2px">
        <h2>{t('editPrinter.removeTitle')}</h2>
        <span class="muted small">{t('editPrinter.removeHint')}</span>
      </div>
      <span class="spacer"></span>
      <button class="danger" onclick={remove}>{t('common.remove')}</button>
    </section>
  {/if}
</div>
