<script lang="ts">
  import { hmsInfo } from '../lib/bambu';
  import { t } from '../lib/i18n.svelte';

  let { state: s }: { state: Record<string, any> } = $props();

  const items = $derived<{ attr: number; code: number }[]>(Array.isArray(s.hms) ? s.hms : []);
</script>

{#if items.length > 0}
  <section class="card stack">
    <header style="margin:0">
      <h2>{t('hms.title')}</h2>
      <span class="badge plain tone-warn">{items.length}</span>
    </header>
    {#each items as item}
      {@const info = hmsInfo(item)}
      <div class="row">
        <span class="badge plain tone-{info.severity.tone}">{info.severity.label}</span>
        <code>HMS_{info.code}</code>
        <span class="spacer"></span>
        <a class="small" href={info.url} target="_blank" rel="noreferrer">{t('hms.lookUp')} ↗</a>
      </div>
    {/each}
  </section>
{/if}
