<script lang="ts">
  import type { Connection } from '../lib/api';

  let { connection }: { connection: Connection } = $props();

  const map = {
    online: { label: 'Online', tone: 'ok' },
    connecting: { label: 'Connecting', tone: 'info' },
    offline: { label: 'Offline', tone: 'muted' },
    error: { label: 'Error', tone: 'danger' },
  } as const;

  const info = $derived(map[connection.status]);
</script>

<span class="badge tone-{info.tone}" title={connection.error ?? ''}>{info.label}</span>
