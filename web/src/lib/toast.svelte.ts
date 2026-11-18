export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  message: string;
}

let nextId = 1;
export const toasts = $state<Toast[]>([]);

export function toast(message: string, kind: Toast['kind'] = 'info') {
  const id = nextId++;
  toasts.push({ id, kind, message });
  setTimeout(() => {
    const idx = toasts.findIndex((t) => t.id === id);
    if (idx >= 0) toasts.splice(idx, 1);
  }, kind === 'error' ? 7000 : 3500);
}

export function toastError(err: unknown) {
  toast(err instanceof Error ? err.message : String(err), 'error');
}
