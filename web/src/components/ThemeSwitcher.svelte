<script lang="ts">
  import { setTheme, theme, type ThemeChoice } from '../lib/theme.svelte';
  import { t, type MessageKey } from '../lib/i18n.svelte';

  const options: { value: ThemeChoice; icon: string; label: MessageKey }[] = [
    { value: 'light', icon: '☀', label: 'theme.light' },
    { value: 'system', icon: '◐', label: 'theme.system' },
    { value: 'dark', icon: '☾', label: 'theme.dark' },
  ];
</script>

<div class="switch" role="radiogroup" aria-label={t('theme.label')}>
  {#each options as o}
    <button
      role="radio"
      aria-checked={theme.choice === o.value}
      class:on={theme.choice === o.value}
      title={t('theme.title', { theme: t(o.label) })}
      aria-label={t(o.label)}
      onclick={() => setTheme(o.value)}
    >
      {o.icon}
    </button>
  {/each}
</div>

<style>
  .switch {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px;
    background: var(--bg);
  }
  button {
    border: none;
    background: transparent;
    border-radius: 999px;
    width: 30px;
    height: 26px;
    padding: 0;
    color: var(--muted);
    font-size: 0.95rem;
  }
  button:hover:not(.on) {
    background: transparent;
    color: var(--text);
  }
  button.on {
    background: var(--card-2);
    color: var(--text);
    box-shadow: 0 0 0 1px var(--border);
  }
</style>
