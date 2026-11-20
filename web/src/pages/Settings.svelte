<script lang="ts">
  import { onMount } from 'svelte';
  import Notifications from '../components/Notifications.svelte';
  import { api } from '../lib/api';
  import { toast, toastError } from '../lib/toast.svelte';
  import { confirmAction } from '../lib/confirm.svelte';
  import { LOCALES, LOCALE_NAMES, formatDate, formatTimeAgo, i18n, setLocale, t, type LocaleChoice } from '../lib/i18n.svelte';

  let { user }: { user: { id: number; username: string } } = $props();

  interface Session {
    id: string;
    createdAt: number;
    lastSeenAt: number;
    ip: string | null;
    userAgent: string | null;
    current: boolean;
  }
  interface AuditRow {
    id: number;
    at: number;
    username: string | null;
    ip: string | null;
    action: string;
    outcome: 'success' | 'failure' | 'blocked';
    detail: Record<string, unknown> | null;
  }

  let users = $state<{ id: number; username: string; created_at: number }[]>([]);
  let sessions = $state<Session[]>([]);
  let auditLog = $state<AuditRow[]>([]);
  let auditFilter = $state<'all' | 'problems'>('all');
  let pw = $state({ current: '', next: '', confirm: '' });
  let version = $state<string | null>(null);
  let newUser = $state({ username: '', password: '' });

  const loadUsers = async () => (users = await api('/api/users').catch(() => []));
  const loadSessions = async () => (sessions = await api('/api/auth/sessions').catch(() => []));
  const loadAudit = async () => (auditLog = await api('/api/audit').catch(() => []));

  onMount(() => {
    api<{ version: string }>('/api/health').then((h) => (version = h.version)).catch(() => {});
    loadUsers();
    loadSessions();
    loadAudit();
  });

  const shownAudit = $derived(auditFilter === 'all' ? auditLog : auditLog.filter((a) => a.outcome !== 'success'));

  async function changePassword(event: SubmitEvent) {
    event.preventDefault();
    if (pw.next !== pw.confirm) return toast(t('settings.newPasswordMismatch'), 'error');
    try {
      await api('/api/auth/password', { body: { current: pw.current, next: pw.next } });
      pw = { current: '', next: '', confirm: '' };
      toast(t('settings.passwordChanged'), 'success');
      loadSessions();
      loadAudit();
    } catch (err) {
      toastError(err);
    }
  }

  async function addUser(event: SubmitEvent) {
    event.preventDefault();
    try {
      await api('/api/users', { body: newUser });
      toast(t('settings.userCreated', { name: newUser.username }), 'success');
      newUser = { username: '', password: '' };
      loadUsers();
      loadAudit();
    } catch (err) {
      toastError(err);
    }
  }

  async function removeUser(id: number, username: string) {
    const ok = await confirmAction({
      title: t('settings.confirmDeleteUserTitle', { name: username }),
      message: t('settings.confirmDeleteUser'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' });
      loadUsers();
      loadAudit();
    } catch (err) {
      toastError(err);
    }
  }

  async function revoke(s: Session) {
    const ok = await confirmAction({
      title: t('settings.confirmSignOut'),
      message: t('settings.confirmSignOutText', { device: browser(s.userAgent) }),
      confirmLabel: t('settings.signOut'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' });
      loadSessions();
    } catch (err) {
      toastError(err);
    }
  }

  async function revokeOthers() {
    const ok = await confirmAction({
      title: t('settings.confirmSignOutOthers'),
      message: t('settings.confirmSignOutOthersText'),
      confirmLabel: t('settings.signOut'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/auth/sessions/revoke-others', { method: 'POST' });
      toast(t('settings.othersSignedOut'), 'success');
      loadSessions();
    } catch (err) {
      toastError(err);
    }
  }

  const when = (at: number) => (at ? formatDate(at) : '—');

  function browser(ua: string | null) {
    if (!ua) return t('settings.unknownDevice');
    const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : t('settings.browser');
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? t('settings.browserOn', { browser: b, os }) : b;
  }

  const detailText = (d: AuditRow['detail']) =>
    d ? Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : '';
</script>

<div class="container stack narrow">
  <div class="row">
    <div class="stack" style="gap:0">
      <nav class="crumbs" aria-label={t('common.breadcrumb')}><a href="#/">{t('nav.printers')}</a><span>›</span></nav>
      <h1>{t('nav.settings')}</h1>
    </div>
  </div>

  <section class="card row">
    <label class="field language">
      {t('settings.language')}
      <select value={i18n.choice} onchange={(e) => setLocale(e.currentTarget.value as LocaleChoice)}>
        <option value="auto">{t('settings.languageAuto')}</option>
        {#each LOCALES as l}<option value={l} lang={l}>{LOCALE_NAMES[l]}</option>{/each}
      </select>
    </label>
  </section>

  <Notifications deviceName={browser} />

  <section class="card">
    <header><h2>{t('settings.changePassword')}</h2></header>
    <form class="stack" onsubmit={changePassword}>
      <label class="field">{t('settings.currentPassword')}<input type="password" bind:value={pw.current} autocomplete="current-password" required /></label>
      <label class="field">{t('settings.newPassword')}<input type="password" bind:value={pw.next} autocomplete="new-password" minlength="10" required /></label>
      <label class="field">{t('settings.confirmNewPassword')}<input type="password" bind:value={pw.confirm} autocomplete="new-password" required /></label>
      <span class="muted small">{t('auth.passwordHint')}</span>
      <div><button class="primary">{t('settings.changePassword')}</button></div>
    </form>
  </section>

  <section class="card stack">
    <header style="margin:0">
      <h2>{t('settings.sessions')}</h2>
      <button class="small" onclick={revokeOthers} disabled={sessions.length < 2}>{t('settings.signOutOthers')}</button>
    </header>
    <table class="stacked">
      <tbody>
        {#each sessions as s (s.id)}
          <tr>
            <td>
              {browser(s.userAgent)}
              {#if s.current}<span class="badge plain tone-ok">{t('settings.thisDevice')}</span>{/if}
              <div class="muted small">{s.ip ?? t('settings.unknownIp')} · {t('settings.signedIn', { when: when(s.createdAt) })}</div>
            </td>
            <td class="muted small" title={when(s.lastSeenAt)}>{t('settings.active', { when: formatTimeAgo(s.lastSeenAt) })}</td>
            <td style="text-align:right">
              {#if !s.current}<button class="small danger" onclick={() => revoke(s)}>{t('settings.signOut')}</button>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <section class="card stack">
    <header style="margin:0"><h2>{t('settings.users')}</h2></header>
    <table class="stacked">
      <tbody>
        {#each users as u (u.id)}
          <tr>
            <td>{u.username} {#if u.id === user.id}<span class="muted small">{t('settings.you')}</span>{/if}</td>
            <td class="muted small">{t('settings.since', { date: formatDate(u.created_at, { dateStyle: 'medium' }) })}</td>
            <td style="text-align:right">
              {#if u.id !== user.id}<button class="small danger" onclick={() => removeUser(u.id, u.username)}>{t('common.delete')}</button>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <form class="row" onsubmit={addUser}>
      <input placeholder={t('common.username')} aria-label={t('common.username')} bind:value={newUser.username} required minlength="3" autocomplete="off" />
      <input type="password" placeholder={t('common.password')} aria-label={t('common.password')} bind:value={newUser.password} required minlength="10" autocomplete="new-password" />
      <button>{t('settings.addUser')}</button>
    </form>
    <p class="muted small" style="margin:0">{t('auth.passwordHint')} {t('settings.fullAccess')}</p>
  </section>

  <section class="card stack">
    <header style="margin:0">
      <h2>{t('settings.securityLog')}</h2>
      <div class="row">
        <button class="small" class:active={auditFilter === 'all'} onclick={() => (auditFilter = 'all')}>{t('settings.all')}</button>
        <button class="small" class:active={auditFilter === 'problems'} onclick={() => (auditFilter = 'problems')}>
          {t('settings.failures')}
        </button>
        <button class="small" onclick={loadAudit}>{t('common.reload')}</button>
      </div>
    </header>
    <div class="log">
      <table>
        <tbody>
          {#each shownAudit as a (a.id)}
            <tr>
              <td class="nowrap muted small">{when(a.at)}</td>
              <td>
                <code class="small">{a.action}</code>
                {#if a.outcome !== 'success'}<span class="badge plain tone-{a.outcome === 'blocked' ? 'danger' : 'warn'}">{t(`settings.outcome.${a.outcome}`)}</span>{/if}
                <div class="muted small">{a.username ?? '—'} · {a.ip ?? '—'}{a.detail ? ` · ${detailText(a.detail)}` : ''}</div>
              </td>
            </tr>
          {:else}
            <tr><td class="muted small">{t('settings.nothingLogged')}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="muted small" style="margin:0">{t('settings.auditRetention', { env: 'AUDIT_RETENTION_DAYS' })}</p>
  </section>

  <footer class="muted small about">
    Bambu Controller {version ? `v${version}` : ''} ·
    <a href="https://github.com/mrquentin/bambu-controller" target="_blank" rel="noreferrer">{t('settings.source')}</a>
  </footer>
</div>

<style>
  .narrow {
    max-width: 820px;
  }
  .log {
    max-height: 420px;
    overflow: auto;
  }
  .about {
    text-align: center;
    padding: 8px 0 24px;
  }
  .nowrap {
    white-space: nowrap;
    vertical-align: top;
  }
  .log :global(div) {
    word-break: break-word;
  }
  form.row > input {
    flex: 1 1 160px;
  }
  @media (max-width: 700px) {
    .stacked tr {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      border-bottom: 1px solid var(--border);
      padding: 6px 0;
    }
    .stacked td {
      border-bottom: none;
      padding: 2px 4px;
    }
    .stacked td:first-child {
      grid-column: 1 / -1;
    }
    .log .nowrap {
      white-space: normal;
    }
  }
</style>
