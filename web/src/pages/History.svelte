<script lang="ts">
  import History from '../components/History.svelte';
  import { t } from '../lib/i18n.svelte';
</script>

<div class="container stack">
  <div class="row">
    <h1>{t('history.title')}</h1>
  </div>
  <History />
</div>
