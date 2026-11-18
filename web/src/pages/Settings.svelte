<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { toast, toastError } from '../lib/toast.svelte';

  let { user }: { user: { id: number; username: string } } = $props();

  let users = $state<{ id: number; username: string; created_at: number }[]>([]);
  let pw = $state({ current: '', next: '', confirm: '' });
  let newUser = $state({ username: '', password: '' });

  async function loadUsers() {
    users = await api('/api/users').catch(() => []);
  }
  onMount(loadUsers);

  async function changePassword(event: SubmitEvent) {
    event.preventDefault();
    if (pw.next !== pw.confirm) return toast('New passwords do not match', 'error');
    try {
      await api('/api/auth/password', { body: { current: pw.current, next: pw.next } });
      pw = { current: '', next: '', confirm: '' };
      toast('Password changed. Other sessions were signed out.', 'success');
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
    } catch (err) {
      toastError(err);
    }
  }

  async function removeUser(id: number, username: string) {
    if (!confirm(`Delete user ${username}?`)) return;
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' });
      loadUsers();
    } catch (err) {
      toastError(err);
    }
  }
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
      <label class="field">New password<input type="password" bind:value={pw.next} autocomplete="new-password" minlength="8" required /></label>
      <label class="field">Confirm new password<input type="password" bind:value={pw.confirm} autocomplete="new-password" required /></label>
      <div><button class="primary">Change password</button></div>
    </form>
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
      <input type="password" placeholder="Password (8+ chars)" bind:value={newUser.password} required minlength="8" autocomplete="new-password" />
      <button>Add user</button>
    </form>
    <p class="muted small" style="margin:0">All users have full access to every printer.</p>
  </section>
</div>

<style>
  .narrow {
    max-width: 720px;
  }
</style>
