<script lang="ts">
  import { setTheme, theme, type ThemeChoice } from '../lib/theme.svelte';

  const options: { value: ThemeChoice; icon: string; label: string }[] = [
    { value: 'light', icon: '☀', label: 'Light' },
    { value: 'system', icon: '◐', label: 'System' },
    { value: 'dark', icon: '☾', label: 'Dark' },
  ];
</script>

<div class="switch" role="radiogroup" aria-label="Theme">
  {#each options as o}
    <button
      role="radio"
      aria-checked={theme.choice === o.value}
      class:on={theme.choice === o.value}
      title="{o.label} theme"
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
