<script lang="ts">
  import { tick } from 'svelte';
  import { confirmState, settleConfirm } from '../lib/confirm.svelte';
  import { t } from '../lib/i18n.svelte';

  /**
   * Accessible confirmation dialog (see lib/confirm.svelte.ts). Focus moves to
   * the confirm button and stays trapped inside; Esc cancels, Enter confirms,
   * and focus returns to where it was on close.
   */
  const pending = $derived(confirmState.current);
  let dialog = $state<HTMLDivElement>();
  let confirmButton = $state<HTMLButtonElement>();
  let returnFocus: HTMLElement | null = null;

  $effect(() => {
    if (!pending) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    tick().then(() => confirmButton?.focus());
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus();
      returnFocus = null;
    };
  });

  function onKeydown(event: KeyboardEvent) {
    // Keep keys away from handlers of the page or dialog underneath (e.g. their Esc).
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      settleConfirm(false);
    } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      settleConfirm(true);
    } else if (event.key === 'Tab' && dialog) {
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }
  }
</script>

{#if pending}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="modal-backdrop confirm-backdrop" onclick={(e) => e.target === e.currentTarget && settleConfirm(false)}>
    <div
      bind:this={dialog}
      class="modal stack confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby={pending.message ? 'confirm-message' : undefined}
      tabindex="-1"
      onkeydown={onKeydown}
    >
      <h2 id="confirm-title">{pending.title}</h2>
      {#if pending.message}<p id="confirm-message">{pending.message}</p>{/if}
      <div class="row actions">
        <span class="spacer"></span>
        <button type="button" onclick={() => settleConfirm(false)}>{t('common.cancel')}</button>
        <button type="button" bind:this={confirmButton} class={pending.danger ? 'danger' : 'primary'} onclick={() => settleConfirm(true)}>
          {pending.confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Above other modals (e.g. skip objects) since it can open from them. */
  .confirm-backdrop {
    z-index: 200;
  }
  .confirm {
    width: min(420px, 100%);
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  /* Phones: comfortable, full-width buttons with the confirm action on top. */
  @media (max-width: 480px) {
    .confirm-backdrop {
      place-items: end center;
    }
    .actions {
      flex-direction: column-reverse;
      align-items: stretch;
    }
    .actions .spacer {
      display: none;
    }
    .actions button {
      min-height: 44px;
    }
  }
</style>
