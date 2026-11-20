<script lang="ts">
  import { connectivity } from '../lib/connectivity.svelte';
  import { t } from '../lib/i18n.svelte';

  // The browser knowing it has no network is the more useful explanation.
  const message = $derived(
    !connectivity.browserOnline ? t('offline.noNetwork') : !connectivity.serverReachable ? t('offline.serverLost') : null,
  );

  // The sticky top bar sits right under the banner (see .topbar in app.css).
  let height = $state(0);
  $effect(() => {
    document.documentElement.style.setProperty('--offline-banner-height', `${message ? height : 0}px`);
  });
</script>

<!-- Always in the DOM (empty and zero-height when fine) so screen readers announce the change. -->
<div class="offline-banner" class:shown={message !== null} role="status" aria-live="polite" bind:clientHeight={height}>
  {#if message}<span class="spinner" aria-hidden="true"></span>{message}{/if}
</div>

<style>
  .offline-banner.shown {
    position: sticky;
    top: 0;
    z-index: 150;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--warn);
    color: #111;
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
  }
  .spinner {
    flex: none;
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
