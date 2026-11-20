<script lang="ts">
  import type { ConnectionInfo as Connection } from '../../../shared/api.ts';
  import { t } from '../lib/i18n.svelte';

  let { connection }: { connection: Connection } = $props();

  const map = {
    online: { label: 'connection.online', tone: 'ok' },
    connecting: { label: 'connection.connecting', tone: 'info' },
    offline: { label: 'connection.offline', tone: 'muted' },
    error: { label: 'connection.error', tone: 'danger' },
  } as const;

  const stale = $derived(connection.status === 'online' && connection.stale);
  const retrying = $derived(connection.status !== 'online' && !!connection.nextRetryAt);

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
      const age = connection.lastReportAt
        ? t('connection.lastUpdate', { seconds: seconds(now - connection.lastReportAt) })
        : t('connection.noUpdate');
      return { label: t('connection.stale'), tone: 'warn', title: age };
    }
    if (retrying) {
      return {
        label: t('connection.reconnectingIn', { seconds: seconds(connection.nextRetryAt! - now) }),
        tone: base.tone,
        title: connection.error ?? '',
      };
    }
    return { label: t(base.label), tone: base.tone, title: connection.error ?? '' };
  });
</script>

<span class="badge tone-{info.tone}" title={info.title}>{info.label}</span>
