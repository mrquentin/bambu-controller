<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import {
    PUSH_EVENTS,
    currentSubscription,
    endpointFingerprint,
    pushBlocker,
    subscribe,
    type PushDevice,
    type PushEventKind,
  } from '../lib/push';
  import { toast, toastError } from '../lib/toast.svelte';
  import { formatDate, formatTimeAgo, t } from '../lib/i18n.svelte';
  import { confirmAction } from '../lib/confirm.svelte';
  import Trans from './Trans.svelte';

  let { deviceName }: { deviceName: (ua: string | null) => string } = $props();

  const blocker = pushBlocker();
  let permission = $state<NotificationPermission>(blocker ? 'default' : Notification.permission);
  let devices = $state<PushDevice[]>([]);
  let myFingerprint = $state<string | null>(null);
  let loading = $state(true);
  let busy = $state(false);

  const thisDevice = $derived(devices.find((d) => d.fingerprint === myFingerprint) ?? null);
  const otherDevices = $derived(devices.filter((d) => d.fingerprint !== myFingerprint));

  async function load() {
    devices = await api<PushDevice[]>('/api/push/subscriptions').catch(() => []);
    if (!blocker) {
      const sub = await currentSubscription().catch(() => null);
      myFingerprint = sub ? await endpointFingerprint(sub.endpoint) : null;
    }
    loading = false;
  }

  onMount(load);

  async function enable() {
    busy = true;
    try {
      permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      const { publicKey } = await api<{ publicKey: string }>('/api/push/key');
      const sub = await subscribe(publicKey);
      await api('/api/push/subscriptions', { body: { subscription: sub.toJSON() } });
      myFingerprint = await endpointFingerprint(sub.endpoint);
      toast(t('notif.enabled'), 'success');
      await load();
    } catch (err) {
      toastError(err);
    } finally {
      busy = false;
    }
  }

  async function disable() {
    if (!thisDevice) return;
    busy = true;
    try {
      await api(`/api/push/subscriptions/${thisDevice.id}`, { method: 'DELETE' });
      await (await currentSubscription())?.unsubscribe();
      myFingerprint = null;
      toast(t('notif.disabled'), 'success');
      await load();
    } catch (err) {
      toastError(err);
    } finally {
      busy = false;
    }
  }

  async function setPreference(device: PushDevice, key: PushEventKind, value: boolean) {
    try {
      const saved = await api<PushDevice>(`/api/push/subscriptions/${device.id}`, {
        method: 'PUT',
        body: { preferences: { [key]: value } },
      });
      devices = devices.map((d) => (d.id === saved.id ? saved : d));
    } catch (err) {
      toastError(err);
      await load();
    }
  }

  async function sendTest() {
    if (!thisDevice) return;
    busy = true;
    try {
      await api(`/api/push/subscriptions/${thisDevice.id}/test`, { method: 'POST' });
      toast(t('notif.testSent'), 'success');
    } catch (err) {
      toastError(err);
      await load();
    } finally {
      busy = false;
    }
  }

  async function remove(device: PushDevice) {
    const ok = await confirmAction({
      title: t('notif.confirmRemoveTitle'),
      message: t('notif.confirmRemove', { device: deviceName(device.userAgent) }),
      confirmLabel: t('common.remove'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/push/subscriptions/${device.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      toastError(err);
    }
  }

  const when = (at: number | null) => (at ? formatTimeAgo(at) : t('common.never'));
</script>

<section class="card stack">
  <header style="margin:0">
    <h2>{t('notif.title')}</h2>
    {#if thisDevice}<span class="badge plain tone-ok">{t('notif.onHere')}</span>{/if}
  </header>

  {#if blocker === 'insecure'}
    <div class="alert warn small">
      <Trans key="notif.insecure">
        {#snippet https()}<strong>HTTPS</strong>{/snippet}
        {#snippet localhost()}<code>localhost</code>{/snippet}
        {#snippet certFile()}<code>TLS_CERT_FILE</code>{/snippet}
        {#snippet keyFile()}<code>TLS_KEY_FILE</code>{/snippet}
      </Trans>
    </div>
  {:else if blocker === 'ios-not-installed'}
    <div class="alert info small">
      <Trans key="notif.ios">{#snippet share()}<strong>{t('notif.iosShare')}</strong>{/snippet}</Trans>
    </div>
  {:else if blocker === 'unsupported'}
    <div class="alert warn small">{t('notif.unsupported')}</div>
  {:else if permission === 'denied'}
    <div class="alert warn small">{t('notif.denied')}</div>
  {:else if loading}
    <span class="muted small">{t('common.loading')}</span>
  {:else if thisDevice}
    <div class="prefs">
      {#each PUSH_EVENTS as e (e.key)}
        <label class="row pref">
          <input
            type="checkbox"
            checked={thisDevice.preferences[e.key]}
            onchange={(ev) => setPreference(thisDevice, e.key, ev.currentTarget.checked)}
          />
          {t(`notif.event.${e.key}`)}
        </label>
      {/each}
    </div>
    <div class="row">
      <button class="small" onclick={sendTest} disabled={busy}>{t('notif.sendTest')}</button>
      <button class="small danger" onclick={disable} disabled={busy}>{t('notif.turnOff')}</button>
    </div>
  {:else}
    <p class="muted small" style="margin:0">{t('notif.intro')}</p>
    <div><button class="primary" onclick={enable} disabled={busy}>{t('notif.enable')}</button></div>
  {/if}

  {#if otherDevices.length}
    <table class="stacked">
      <tbody>
        {#each otherDevices as d (d.id)}
          <tr>
            <td>
              {deviceName(d.userAgent)}
              <div class="muted small">
                {t('notif.deviceMeta', { date: formatDate(d.createdAt, { dateStyle: 'medium' }), when: when(d.lastSuccessAt) })}
              </div>
            </td>
            <td class="muted small">
              {t('notif.eventCount', { count: PUSH_EVENTS.filter((e) => d.preferences[e.key]).length, total: PUSH_EVENTS.length })}
            </td>
            <td style="text-align:right"><button class="small danger" onclick={() => remove(d)}>{t('common.remove')}</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <p class="muted small" style="margin:0">{t('notif.privacy')}</p>
</section>

<style>
  .prefs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 6px 16px;
  }
  .pref {
    flex-wrap: nowrap;
    font-size: 0.9rem;
    cursor: pointer;
  }
  @media (max-width: 700px) {
    .stacked tr {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      border-bottom: 1px solid var(--border);
      padding: 6px 0;
    }
    .stacked td {
      border-bottom: none;
      padding: 2px 4px;
    }
    .stacked td:first-child {
      grid-column: 1 / -1;
    }
  }
</style>
