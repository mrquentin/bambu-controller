import { fromServer, reportServerReachable, reportServerUnreachable } from './connectivity.svelte';
import type { PrinterCommand } from '../../../shared/commands.ts';
import { t } from './i18n.svelte';
import { toast, toastError } from './toast.svelte';

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The request never reached the server (offline, server down, …). */
export class NetworkError extends Error {}

/** Fired when any request comes back 401 so the app can show the login screen. */
export const authEvents = new EventTarget();

export async function api<T = any>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const init: RequestInit = {
    method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
    headers: { 'X-Requested-With': 'fetch' } as Record<string, string>,
    credentials: 'same-origin',
  };
  if (options.body instanceof FormData) {
    init.body = options.body;
  } else if (options.body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, init).catch(() => null);
  if (!res || !fromServer(res)) {
    reportServerUnreachable();
    throw new NetworkError(t('offline.requestFailed'));
  }
  reportServerReachable();
  if (res.status === 401 && !path.startsWith('/api/auth/')) authEvents.dispatchEvent(new Event('unauthorized'));
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export type SendFn = (command: PrinterCommand, successMessage?: string) => Promise<boolean>;

/** Send commands to a printer: failures are toasted, and `successMessage` on success. */
export function printerCommands(printerId: number): SendFn {
  return async (command, successMessage) => {
    try {
      await api(`/api/printers/${printerId}/command`, { body: command });
      if (successMessage) toast(successMessage, 'success');
      return true;
    } catch (err) {
      toastError(err);
      return false;
    }
  };
}

/**
 * Follow the live updates of `resource` (server-sent events at
 * `<resource>/events`, each a JSON copy of the resource). Network trouble
 * shows the offline banner and keeps retrying; an HTTP error (not found,
 * signed out) is final and reported through `onError`.
 */
export function liveUpdates<T>(resource: string, onMessage: (data: T) => void, onError: (message: string) => void) {
  let source: EventSource;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function connect() {
    source = new EventSource(`${resource}/events`);
    source.onmessage = (event) => {
      reportServerReachable();
      onMessage(JSON.parse(event.data));
    };
    source.onerror = async () => {
      // EventSource doesn't expose the HTTP status: a plain request tells.
      try {
        await api(resource);
      } catch (err) {
        if (err instanceof ApiError) {
          source.close();
          onError(err.message);
          return;
        }
      }
      // The browser retries by itself unless the stream got an HTTP error.
      if (source.readyState === EventSource.CLOSED && !stopped) retry = setTimeout(connect, 5000);
    };
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    source.close();
  };
}
