<script lang="ts">
  import { onMount } from 'svelte';
  import type { AuthState } from '../../shared/api.ts';
  import { NetworkError, api, authEvents } from './lib/api';
  import { t } from './lib/i18n.svelte';
  import { match, navigate, printerRoute, route } from './lib/router.svelte';
  import { toasts } from './lib/toast.svelte';
  import Login from './pages/Login.svelte';
  import Printers from './pages/Printers.svelte';
  import AddPrinter from './pages/AddPrinter.svelte';
  import PrinterDetail from './pages/PrinterDetail.svelte';
  import EditPrinter from './pages/EditPrinter.svelte';
  import Settings from './pages/Settings.svelte';
  import History from './pages/History.svelte';
  import ThemeSwitcher from './components/ThemeSwitcher.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import OfflineBanner from './components/OfflineBanner.svelte';
  import { connectivity } from './lib/connectivity.svelte';

  let auth = $state<AuthState & { loading: boolean }>({
    loading: true,
    setupRequired: false,
    user: null,
  });

  // Server unreachable on startup: keep "Loading…" (the offline banner explains) and retry on reconnect.
  let retryAuth = false;
  async function refreshAuth() {
    try {
      const s = await api('/api/auth/state');
      auth = { loading: false, setupRequired: s.setupRequired, user: s.user };
    } catch (err) {
      if (err instanceof NetworkError && auth.loading) retryAuth = true;
      else auth = { ...auth, loading: false };
    }
  }

  $effect(() => {
    if (connectivity.serverReachable && retryAuth) {
      retryAuth = false;
      refreshAuth();
    }
  });

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    auth.user = null;
    navigate('/');
  }

  onMount(() => {
    refreshAuth();
    const onUnauthorized = () => (auth.user = null);
    authEvents.addEventListener('unauthorized', onUnauthorized);
    return () => authEvents.removeEventListener('unauthorized', onUnauthorized);
  });

  const detail = $derived(printerRoute(route.path));
  const edit = $derived(match('/printer/:id/edit', route.path));
</script>

<OfflineBanner />

{#if auth.loading}
  <div class="empty">{t('common.loading')}</div>
{:else if !auth.user}
  <div class="corner"><ThemeSwitcher /></div>
  <Login setup={auth.setupRequired} onAuthenticated={refreshAuth} />
{:else}
  <nav class="topbar">
    <a class="brand" href="#/" aria-label="Bambu Controller">
      <img src="/favicon.svg" alt="" width="28" height="28" />
      <span class="brand-name">Bambu Controller</span>
    </a>
    <span class="spacer"></span>
    <ThemeSwitcher />
    <a class="btn small nav-history" href="#/history">{t('nav.history')}</a>
    <a class="btn small" href="#/settings">{t('nav.settings')}</a>
    <span class="muted small user">{auth.user.username}</span>
    <button class="small ghost" onclick={logout}>{t('nav.logout')}</button>
  </nav>

  {#if route.path === '/'}
    <Printers />
  {:else if route.path === '/add'}
    <AddPrinter />
  {:else if route.path === '/settings'}
    <Settings user={auth.user} />
  {:else if route.path === '/history'}
    <History />
  {:else if edit}
    {#key edit.id}<EditPrinter id={Number(edit.id)} />{/key}
  {:else if detail}
    {#key detail.id}<PrinterDetail id={detail.id} tab={detail.tab} />{/key}
  {:else}
    <div class="empty">{t('app.notFound')} <a href="#/">{t('app.backToPrinters')}</a></div>
  {/if}
{/if}

<div class="toasts">
  {#each toasts as t (t.id)}
    <div class="toast {t.kind}">{t.message}</div>
  {/each}
</div>

<ConfirmDialog />

<style>
  .corner {
    position: fixed;
    top: 12px;
    right: 12px;
  }
  /* No room in the top bar on phones: the printer list links to it instead. */
  @media (max-width: 480px) {
    .nav-history {
      display: none;
    }
  }
</style>
