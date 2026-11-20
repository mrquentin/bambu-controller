<script lang="ts">
  import { api } from '../lib/api';
  import { t } from '../lib/i18n.svelte';

  let { setup, onAuthenticated }: { setup: boolean; onAuthenticated: () => void } = $props();

  let username = $state('');
  let password = $state('');
  let confirm = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = null;
    if (setup && password !== confirm) {
      error = t('login.passwordMismatch');
      return;
    }
    busy = true;
    try {
      await api(setup ? '/api/auth/setup' : '/api/auth/login', { body: { username, password } });
      onAuthenticated();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<div class="wrap">
  <form class="card stack" onsubmit={submit}>
    <div class="row">
      <img src="/favicon.svg" alt="" width="36" height="36" />
      <div>
        <h1>Bambu Controller</h1>
        <div class="muted small">{setup ? t('login.createFirst') : t('login.signInToContinue')}</div>
      </div>
    </div>

    {#if setup}
      <div class="alert info">{t('login.noAccount')}</div>
    {/if}

    <label class="field">
      {t('common.username')}
      <input bind:value={username} autocomplete="username" required minlength="3" />
    </label>
    <label class="field">
      {t('common.password')}
      <input
        type="password"
        bind:value={password}
        autocomplete={setup ? 'new-password' : 'current-password'}
        required
        minlength={setup ? 10 : undefined}
      />
    </label>
    {#if setup}
      <span class="muted small">{t('auth.passwordHint')}</span>
      <label class="field">
        {t('login.confirmPassword')}
        <input type="password" bind:value={confirm} autocomplete="new-password" required />
      </label>
    {/if}

    {#if error}<div class="alert error">{error}</div>{/if}

    <button class="primary" type="submit" disabled={busy}>
      {busy ? t('login.pleaseWait') : setup ? t('login.createAccount') : t('login.signIn')}
    </button>
  </form>
</div>

<style>
  .wrap {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 16px;
  }
  form {
    width: min(380px, 100%);
    padding: 24px;
  }
</style>
