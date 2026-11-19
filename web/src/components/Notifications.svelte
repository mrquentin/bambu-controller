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
      toast('Notifications enabled on this device', 'success');
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
      toast('Notifications turned off on this device', 'success');
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
      toast('Test notification sent', 'success');
    } catch (err) {
      toastError(err);
      await load();
    } finally {
      busy = false;
    }
  }

  async function remove(device: PushDevice) {
    if (!confirm(`Stop notifications on ${deviceName(device.userAgent)}?`)) return;
    try {
      await api(`/api/push/subscriptions/${device.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      toastError(err);
    }
  }

  const when = (t: number | null) => (t ? new Date(t).toLocaleString() : 'never');
</script>

<section class="card stack">
  <header style="margin:0">
    <h2>Notifications</h2>
    {#if thisDevice}<span class="badge plain tone-ok">On for this device</span>{/if}
  </header>

  {#if blocker === 'insecure'}
    <div class="alert warn small">
      Notifications need a secure connection: open the app over <strong>HTTPS</strong> (or on <code>localhost</code>).
      Serve it with <code>TLS_CERT_FILE</code> / <code>TLS_KEY_FILE</code> or behind an HTTPS reverse proxy.
    </div>
  {:else if blocker === 'ios-not-installed'}
    <div class="alert info small">
      On iPhone and iPad, notifications only work in the installed app: tap <strong>Share → Add to Home Screen</strong>,
      then open Bambu Controller from the home screen and enable them here (iOS 16.4+).
    </div>
  {:else if blocker === 'unsupported'}
    <div class="alert warn small">This browser doesn't support push notifications.</div>
  {:else if permission === 'denied'}
    <div class="alert warn small">
      Notifications are blocked for this site. Allow them in the browser's site settings, then reload this page.
    </div>
  {:else if loading}
    <span class="muted small">Loading…</span>
  {:else if thisDevice}
    <div class="prefs">
      {#each PUSH_EVENTS as e (e.key)}
        <label class="row pref">
          <input
            type="checkbox"
            checked={thisDevice.preferences[e.key]}
            onchange={(ev) => setPreference(thisDevice, e.key, ev.currentTarget.checked)}
          />
          {e.label}
        </label>
      {/each}
    </div>
    <div class="row">
      <button class="small" onclick={sendTest} disabled={busy}>Send test notification</button>
      <button class="small danger" onclick={disable} disabled={busy}>Turn off on this device</button>
    </div>
  {:else}
    <p class="muted small" style="margin:0">
      Get a notification on this device when a print finishes, fails, pauses or a printer raises a health alert.
    </p>
    <div><button class="primary" onclick={enable} disabled={busy}>Enable on this device</button></div>
  {/if}

  {#if otherDevices.length}
    <table class="stacked">
      <tbody>
        {#each otherDevices as d (d.id)}
          <tr>
            <td>
              {deviceName(d.userAgent)}
              <div class="muted small">since {new Date(d.createdAt).toLocaleDateString()} · last delivered {when(d.lastSuccessAt)}</div>
            </td>
            <td class="muted small">{PUSH_EVENTS.filter((e) => d.preferences[e.key]).length} of {PUSH_EVENTS.length} events</td>
            <td style="text-align:right"><button class="small danger" onclick={() => remove(d)}>Remove</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <p class="muted small" style="margin:0">
    Notifications are end-to-end encrypted and delivered through your browser's push service (Google, Mozilla, Apple or
    Microsoft), so the server needs outbound internet access.
  </p>
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
