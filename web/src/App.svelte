<script lang="ts">
  import { onMount } from 'svelte';
  import { api, authEvents } from './lib/api';
  import { match, navigate, route } from './lib/router.svelte';
  import { toasts } from './lib/toast.svelte';
  import Login from './pages/Login.svelte';
  import Printers from './pages/Printers.svelte';
  import AddPrinter from './pages/AddPrinter.svelte';
  import PrinterDetail from './pages/PrinterDetail.svelte';
  import EditPrinter from './pages/EditPrinter.svelte';
  import Settings from './pages/Settings.svelte';
  import ThemeSwitcher from './components/ThemeSwitcher.svelte';

  let auth = $state<{ loading: boolean; setupRequired: boolean; user: { id: number; username: string } | null }>({
    loading: true,
    setupRequired: false,
    user: null,
  });

  async function refreshAuth() {
    try {
      const s = await api('/api/auth/state');
      auth = { loading: false, setupRequired: s.setupRequired, user: s.user };
    } catch {
      auth = { ...auth, loading: false };
    }
  }

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

  const detail = $derived(
    match('/printer/:id', route.path) ??
      (() => {
        const m = match('/printer/:id/:tab', route.path);
        return m && ['control', 'files', 'info'].includes(m.tab) ? m : null;
      })(),
  );
  const edit = $derived(match('/printer/:id/edit', route.path));
</script>

{#if auth.loading}
  <div class="empty">Loading…</div>
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
    <a class="btn small" href="#/settings">Settings</a>
    <span class="muted small user">{auth.user.username}</span>
    <button class="small ghost" onclick={logout}>Log out</button>
  </nav>

  {#if route.path === '/'}
    <Printers />
  {:else if route.path === '/add'}
    <AddPrinter />
  {:else if route.path === '/settings'}
    <Settings user={auth.user} />
  {:else if edit}
    {#key edit.id}<EditPrinter id={Number(edit.id)} />{/key}
  {:else if detail}
    {#key detail.id}<PrinterDetail id={Number(detail.id)} tab={(detail.tab ?? 'control') as 'control' | 'files' | 'info'} />{/key}
  {:else}
    <div class="empty">Page not found. <a href="#/">Back to printers</a></div>
  {/if}
{/if}

<div class="toasts">
  {#each toasts as t (t.id)}
    <div class="toast {t.kind}">{t.message}</div>
  {/each}
</div>

<style>
  .corner {
    position: fixed;
    top: 12px;
    right: 12px;
  }
</style>
