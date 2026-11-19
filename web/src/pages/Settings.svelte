<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { toast, toastError } from '../lib/toast.svelte';

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

  const PASSWORD_HINT =
    'At least 10 characters with 3 of: lowercase, uppercase, digits, symbols — or a passphrase of 16+ characters.';

  let users = $state<{ id: number; username: string; created_at: number }[]>([]);
  let sessions = $state<Session[]>([]);
  let auditLog = $state<AuditRow[]>([]);
  let auditFilter = $state<'all' | 'problems'>('all');
  let pw = $state({ current: '', next: '', confirm: '' });
  let newUser = $state({ username: '', password: '' });

  const loadUsers = async () => (users = await api('/api/users').catch(() => []));
  const loadSessions = async () => (sessions = await api('/api/auth/sessions').catch(() => []));
  const loadAudit = async () => (auditLog = await api('/api/audit').catch(() => []));

  onMount(() => {
    loadUsers();
    loadSessions();
    loadAudit();
  });

  const shownAudit = $derived(auditFilter === 'all' ? auditLog : auditLog.filter((a) => a.outcome !== 'success'));

  async function changePassword(event: SubmitEvent) {
    event.preventDefault();
    if (pw.next !== pw.confirm) return toast('New passwords do not match', 'error');
    try {
      await api('/api/auth/password', { body: { current: pw.current, next: pw.next } });
      pw = { current: '', next: '', confirm: '' };
      toast('Password changed. Other sessions were signed out.', 'success');
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
      toast(`User ${newUser.username} created`, 'success');
      newUser = { username: '', password: '' };
      loadUsers();
      loadAudit();
    } catch (err) {
      toastError(err);
    }
  }

  async function removeUser(id: number, username: string) {
    if (!confirm(`Delete user ${username}? Their sessions are signed out immediately.`)) return;
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' });
      loadUsers();
      loadAudit();
    } catch (err) {
      toastError(err);
    }
  }

  async function revoke(s: Session) {
    try {
      await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' });
      loadSessions();
    } catch (err) {
      toastError(err);
    }
  }

  async function revokeOthers() {
    if (!confirm('Sign out all other sessions?')) return;
    try {
      await api('/api/auth/sessions/revoke-others', { method: 'POST' });
      toast('Other sessions signed out', 'success');
      loadSessions();
    } catch (err) {
      toastError(err);
    }
  }

  const when = (t: number) => (t ? new Date(t).toLocaleString() : '—');

  function browser(ua: string | null) {
    if (!ua) return 'Unknown device';
    const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${b} on ${os}` : b;
  }

  const detailText = (d: AuditRow['detail']) =>
    d ? Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : '';
</script>

<div class="container stack narrow">
  <div class="row">
    <div class="stack" style="gap:0">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Printers</a><span>›</span></nav>
      <h1>Settings</h1>
    </div>
  </div>

  <section class="card">
    <header><h2>Change password</h2></header>
    <form class="stack" onsubmit={changePassword}>
      <label class="field">Current password<input type="password" bind:value={pw.current} autocomplete="current-password" required /></label>
      <label class="field">New password<input type="password" bind:value={pw.next} autocomplete="new-password" minlength="10" required /></label>
      <label class="field">Confirm new password<input type="password" bind:value={pw.confirm} autocomplete="new-password" required /></label>
      <span class="muted small">{PASSWORD_HINT}</span>
      <div><button class="primary">Change password</button></div>
    </form>
  </section>

  <section class="card stack">
    <header style="margin:0">
      <h2>Active sessions</h2>
      <button class="small" onclick={revokeOthers} disabled={sessions.length < 2}>Sign out other sessions</button>
    </header>
    <table>
      <tbody>
        {#each sessions as s (s.id)}
          <tr>
            <td>
              {browser(s.userAgent)}
              {#if s.current}<span class="badge plain tone-ok">This device</span>{/if}
              <div class="muted small">{s.ip ?? 'unknown IP'} · signed in {when(s.createdAt)}</div>
            </td>
            <td class="muted small">active {when(s.lastSeenAt)}</td>
            <td style="text-align:right">
              {#if !s.current}<button class="small danger" onclick={() => revoke(s)}>Sign out</button>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>

  <section class="card stack">
    <header style="margin:0"><h2>Users</h2></header>
    <table>
      <tbody>
        {#each users as u (u.id)}
          <tr>
            <td>{u.username} {#if u.id === user.id}<span class="muted small">(you)</span>{/if}</td>
            <td class="muted small">since {new Date(u.created_at).toLocaleDateString()}</td>
            <td style="text-align:right">
              {#if u.id !== user.id}<button class="small danger" onclick={() => removeUser(u.id, u.username)}>Delete</button>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <form class="row" onsubmit={addUser}>
      <input placeholder="Username" bind:value={newUser.username} required minlength="3" autocomplete="off" />
      <input type="password" placeholder="Password" bind:value={newUser.password} required minlength="10" autocomplete="new-password" />
      <button>Add user</button>
    </form>
    <p class="muted small" style="margin:0">{PASSWORD_HINT} All users have full access to every printer.</p>
  </section>

  <section class="card stack">
    <header style="margin:0">
      <h2>Security log</h2>
      <div class="row">
        <button class="small" class:active={auditFilter === 'all'} onclick={() => (auditFilter = 'all')}>All</button>
        <button class="small" class:active={auditFilter === 'problems'} onclick={() => (auditFilter = 'problems')}>
          Failures
        </button>
        <button class="small" onclick={loadAudit}>Reload</button>
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
                {#if a.outcome !== 'success'}<span class="badge plain tone-{a.outcome === 'blocked' ? 'danger' : 'warn'}">{a.outcome}</span>{/if}
                <div class="muted small">{a.username ?? '—'} · {a.ip ?? '—'}{a.detail ? ` · ${detailText(a.detail)}` : ''}</div>
              </td>
            </tr>
          {:else}
            <tr><td class="muted small">Nothing logged yet.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="muted small" style="margin:0">Last 300 events; kept for 90 days (AUDIT_RETENTION_DAYS).</p>
  </section>
</div>

<style>
  .narrow {
    max-width: 820px;
  }
  .log {
    max-height: 420px;
    overflow: auto;
  }
  .nowrap {
    white-space: nowrap;
    vertical-align: top;
  }
  .log :global(div) {
    word-break: break-word;
  }
</style>
