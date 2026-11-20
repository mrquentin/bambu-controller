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
  import { t } from '../lib/i18n.svelte';
  import Trans from './Trans.svelte';

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
      {t('common.name')}
      <input bind:value={value.name} required maxlength="64" placeholder={t('form.namePlaceholder')} />
    </label>
    <label class="field">
      {t('form.model')}
      <select bind:value={value.model} required>
        <option value="" disabled>{t('form.select')}</option>
        {#each models as m}<option value={m}>{m}</option>{/each}
        {#if value.model && !models.includes(value.model)}<option value={value.model}>{value.model}</option>{/if}
      </select>
    </label>
    <label class="field">
      {t('form.ip')}
      <input bind:value={value.ip} required placeholder="192.168.1.50" />
    </label>
    <label class="field">
      {t('form.serial')}
      <input bind:value={value.serial} required class="mono" placeholder="01S00A000000000" />
    </label>
    <label class="field">
      {t('form.accessCode')}
      <input
        bind:value={value.accessCode}
        required={!editing}
        class="mono"
        autocomplete="off"
        placeholder={editing ? t('form.accessCodeKeep') : t('form.accessCodeNew')}
      />
    </label>
    <label class="field">
      {t('form.camera')}
      <select bind:value={value.camera}>
        <option value="auto">{t('form.cameraAuto')}</option>
        <option value="jpeg">{t('form.cameraJpeg')}</option>
        <option value="rtsps">{t('form.cameraRtsps')}</option>
        <option value="none">{t('form.cameraNone')}</option>
      </select>
    </label>
  </div>

  <label class="row small">
    <input type="checkbox" bind:checked={value.tlsVerify} />
    <span>
      {t('form.verifyCert')} <span class="muted">{t('form.verifyCertHint')}</span>
    </span>
  </label>

  <p class="muted small">
    <Trans key="form.where">
      {#snippet network()}<i>{t('form.whereNetwork')}</i>{/snippet}
      {#snippet device()}<i>{t('form.whereDevice')}</i>{/snippet}
    </Trans>
  </p>

  {#if error}<div class="alert error">{error}</div>{/if}

  <div class="row">
    <button class="primary" type="submit" disabled={busy}>{busy ? t('form.saving') : submitLabel}</button>
  </div>
</form>

<style>
  .two {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  }
</style>
