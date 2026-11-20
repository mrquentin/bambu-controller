/**
 * In-app replacement for window.confirm(): `await confirmAction({...})`
 * resolves true when the user confirms. Rendered by <ConfirmDialog /> in App.
 */
export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel: string;
  /** Destructive action: red confirm button. */
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export const confirmState = $state<{ current: Pending | null }>({ current: null });

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  // A new request supersedes one still open (answers it with "no").
  confirmState.current?.resolve(false);
  return new Promise((resolve) => {
    confirmState.current = { ...options, resolve };
  });
}

export function settleConfirm(ok: boolean) {
  const pending = confirmState.current;
  if (!pending) return;
  confirmState.current = null;
  pending.resolve(ok);
}
