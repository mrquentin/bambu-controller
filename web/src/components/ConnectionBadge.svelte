<script lang="ts">
  import type { Connection } from '../lib/api';

  let { connection }: { connection: Connection } = $props();

  const map = {
    online: { label: 'Online', tone: 'ok' },
    connecting: { label: 'Connecting', tone: 'info' },
    offline: { label: 'Offline', tone: 'muted' },
    error: { label: 'Error', tone: 'danger' },
  } as const;

  const stale = $derived(connection.status === 'online' && connection.stale);
  const retrying = $derived(connection.status !== 'online' && !!connection.nextRetryAt);

  // Tick once a second only while a countdown / age is displayed.
  let now = $state(Date.now());
  $effect(() => {
    if (!stale && !retrying) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000));

  const info = $derived.by(() => {
    const base = map[connection.status];
    if (stale) {
      const age = connection.lastReportAt ? `Last update ${seconds(now - connection.lastReportAt)}s ago` : 'No update yet';
      return { label: 'Stale', tone: 'warn', title: age };
    }
    if (retrying) {
      return { label: `Reconnecting in ${seconds(connection.nextRetryAt! - now)}s`, tone: base.tone, title: connection.error ?? '' };
    }
    return { ...base, title: connection.error ?? '' };
  });
</script>

<span class="badge tone-{info.tone}" title={info.title}>{info.label}</span>
