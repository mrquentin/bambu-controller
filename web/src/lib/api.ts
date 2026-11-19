export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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
  const res = await fetch(path, init);
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

export interface PrinterInfo {
  id: number;
  name: string;
  model: string;
  serial: string;
  ip: string;
  camera: 'auto' | 'jpeg' | 'rtsps' | 'none';
  tls_verify: number;
  created_at: number;
}

export interface Connection {
  status: 'connecting' | 'online' | 'offline' | 'error';
  error: string | null;
  lastReportAt: number;
}

export interface PrinterSummary {
  printer: PrinterInfo;
  connection: Connection;
  gcodeState: string | null;
  percent: number | null;
  remainingMinutes: number | null;
  layer: number | null;
  totalLayers: number | null;
  task: string | null;
  nozzle: number | null;
  nozzleTarget: number | null;
  bed: number | null;
  bedTarget: number | null;
  hmsCount: number;
}

export interface PrinterDetail {
  printer: PrinterInfo;
  connection: Connection;
  state: Record<string, any>;
  modules: { name: string; sw_ver?: string; hw_ver?: string; sn?: string; project_name?: string }[];
  log: { at: number; direction: 'in' | 'out'; command: string; payload: unknown }[];
  camera: { kind: 'jpeg' | 'rtsps' | 'none'; error: string | null };
  capabilities: { chamberControl: boolean };
}

export interface RemoteFile {
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string | null;
}

export interface DiscoveredPrinter {
  serial: string;
  ip: string;
  name: string;
  modelCode: string;
  model: string;
  connectMode: string | null;
  signal: string | null;
  alreadyAdded: boolean;
}

export type SendFn = (action: string, params?: Record<string, unknown>, successMessage?: string) => Promise<boolean>;
