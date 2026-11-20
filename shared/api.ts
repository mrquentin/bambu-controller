/**
 * Shapes of the HTTP API: what the server sends and the web UI reads.
 * Server code annotates its responses with these types, so a change on one
 * side fails the type check on the other.
 */
import type { CameraKind, CameraSetting, ConnectionStatus } from './printer.ts';

export interface AuthState {
  setupRequired: boolean;
  user: SessionUser | null;
}

export interface SessionUser {
  id: number;
  username: string;
}

export interface UserInfo {
  id: number;
  username: string;
  created_at: number;
}

export interface SessionInfo {
  /** Short, non-reversible id (not the stored token hash). */
  id: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface AuditRecord {
  id: number;
  at: number;
  username: string | null;
  ip: string | null;
  action: string;
  outcome: 'success' | 'failure' | 'blocked';
  detail: Record<string, unknown> | null;
}

/** A configured printer, without its access code. */
export interface PrinterInfo {
  id: number;
  name: string;
  model: string;
  serial: string;
  ip: string;
  camera: CameraSetting;
  /** 1 = verify the printer's TLS certificate against the Bambu CA (CN = serial). */
  tls_verify: number;
  created_at: number;
}

export interface ConnectionInfo {
  status: ConnectionStatus;
  error: string | null;
  lastReportAt: number;
  /** Online, but no report for a while: shown values may be outdated. */
  stale: boolean;
  /** Epoch ms of the next reconnect attempt, if one is scheduled. */
  nextRetryAt: number | null;
}

/** One entry of a printer's list (GET /api/printers). */
export interface PrinterSummary {
  printer: PrinterInfo;
  connection: ConnectionInfo;
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

export interface FirmwareModule {
  name: string;
  project_name?: string;
  sw_ver?: string;
  hw_ver?: string;
  sn?: string;
}

export interface CommandLogEntry {
  at: number;
  direction: 'out' | 'in';
  command: string;
  payload: unknown;
}

/** Full printer view: GET /api/printers/:id and every live update. */
export interface PrinterDetail {
  printer: PrinterInfo;
  connection: ConnectionInfo;
  /** The printer's accumulated push_status report. */
  state: Record<string, any>;
  modules: FirmwareModule[];
  log: CommandLogEntry[];
  camera: { kind: CameraKind; error: string | null };
  capabilities: { chamberControl: boolean };
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

export interface RemoteFile {
  name: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string | null;
}

/** Objects of the running print that can be skipped. */
export interface JobObjects {
  file: string;
  plate: number;
  objects: { id: number; name: string; skipped: boolean }[];
  hasPlateImage: boolean;
  hasPickMap: boolean;
}

export type JobStatus = 'running' | 'paused' | 'finished' | 'failed' | 'interrupted';

/** The job hasn't ended yet: the history recorder still writes to it. */
export const jobOpen = (status: JobStatus) => status === 'running' || status === 'paused';

export interface PrintJob {
  id: number;
  printerId: number | null;
  printerName: string;
  task: string | null;
  gcodeFile: string | null;
  status: JobStatus;
  startedAt: number;
  endedAt: number | null;
  /** Already running when the app first saw it: the real start is earlier. */
  observedMidway: boolean;
  totalLayers: number | null;
  lastLayer: number | null;
  lastPercent: number | null;
  printError: number | null;
  pausedMs: number;
  /** Time spent printing (excluding pauses); for open jobs, up to now. */
  durationMs: number;
}

export interface JobPage {
  jobs: PrintJob[];
  total: number;
}

export interface JobStats {
  total: number;
  byStatus: Record<JobStatus, number>;
  /**
   * finished / (finished + failed). Interrupted jobs are left out: their
   * outcome is unknown (the app lost track of them). null without data.
   */
  successRate: number | null;
  /** Printing time of ended jobs, pauses excluded. */
  printTimeMs: number;
}

export interface HistoryStats extends JobStats {
  printers: (JobStats & { printerId: number | null; printerName: string })[];
}

/** Notified job events, in display order. Each has an `on_<event>` column in push_subscriptions (migrations.ts). */
export const PUSH_EVENTS = ['finished', 'failed', 'paused', 'hms', 'started'] as const;
export type PushEventKind = (typeof PUSH_EVENTS)[number];
export type PushPreferences = Record<PushEventKind, boolean>;

/** A device subscribed to push notifications. */
export interface PushDevice {
  id: number;
  /** SHA-256 of the endpoint, so a browser recognizes its own subscription. */
  fingerprint: string;
  service: string;
  userAgent: string | null;
  createdAt: number;
  lastSuccessAt: number | null;
  preferences: PushPreferences;
}
