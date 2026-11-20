import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import type { PrinterRow } from '../db.ts';
import * as cmd from './commands.ts';
import { detectEvents, jobSnapshot, type JobSnapshot, type PrinterEvent } from './job-events.ts';
import { describeTlsError, printerTlsOptions } from './tls.ts';

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'error';

/** Reconnect and silence-detection timings (ms). */
export interface ConnectionTiming {
  /** Lowest retry delay; the ceiling doubles per failed attempt. */
  retryBaseMs: number;
  /** Highest retry delay (used right away after an authentication failure). */
  retryCapMs: number;
  /** A connection that kept reporting this long resets the backoff. */
  stableAfterMs: number;
  /** Ask for a full status (`pushall`) after this much silence, then at most once per this period. */
  pushallAfterMs: number;
  /** Flag the data as stale after this much silence. */
  staleAfterMs: number;
  /** Drop and re-open the connection after this much silence. */
  reconnectAfterMs: number;
  /** How often the silence watchdog runs while connected. */
  watchdogMs: number;
}

export const DEFAULT_TIMING: ConnectionTiming = {
  retryBaseMs: 2_000,
  retryCapMs: 60_000,
  stableAfterMs: 60_000,
  pushallAfterMs: 30_000,
  staleAfterMs: 60_000,
  reconnectAfterMs: 150_000,
  watchdogMs: 5_000,
};

/**
 * Delay before reconnect attempt `attempt` (0-based): exponential backoff with
 * full jitter, uniform in [base, min(cap, base·2^attempt)]. After an
 * authentication failure it goes straight to [cap/2, cap] so a wrong access
 * code doesn't hammer the printer (which may lock the client out).
 */
export function nextDelay(
  attempt: number,
  rng: () => number,
  { base, cap, authFailed = false }: { base: number; cap: number; authFailed?: boolean },
) {
  if (authFailed) return Math.round(cap / 2 + rng() * (cap / 2));
  const ceiling = Math.min(cap, base * 2 ** Math.min(attempt, 30));
  return Math.round(base + rng() * (ceiling - base));
}

const AUTH_ERROR = /Not authorized|Bad username or password/i;

/**
 * Close an mqtt.js client without leaking its timers. Only the listeners this
 * app added are removed: `removeAllListeners()` would also drop mqtt.js's own
 * 'close' handler, which clears its connect timer (a failed TLS handshake then
 * kept the process busy for `connectTimeout`).
 */
function discardClient(client: MqttClient, own: readonly [string, (...args: any[]) => void][]) {
  for (const [event, listener] of own) client.removeListener(event as 'connect', listener);
  client.on('error', () => {});
  client.end(true);
}

/**
 * One-shot credential check used before saving a printer: connect over MQTT,
 * subscribe to the report topic and wait for the first message.
 */
export function testConnection(
  ip: string,
  serial: string,
  accessCode: string,
  tlsVerify: number,
  timeoutMs = 12_000,
) {
  return new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    const client = mqtt.connect({
      protocol: 'mqtts',
      host: ip,
      port: 8883,
      username: 'bblp',
      password: accessCode,
      clientId: `bambu-web-test-${crypto.randomBytes(4).toString('hex')}`,
      protocolVersion: 4,
      connectTimeout: timeoutMs,
      reconnectPeriod: 0,
      ...printerTlsOptions({ serial, tls_verify: tlsVerify }),
    });
    let connected = false;
    const own: [string, (...args: any[]) => void][] = [];
    const on = (event: string, listener: (...args: any[]) => void) => {
      own.push([event, listener]);
      client.on(event as 'connect', listener);
    };
    const finish = (result: { ok: true } | { ok: false; error: string }) => {
      clearTimeout(timer);
      discardClient(client, own);
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: connected
            ? 'Connected, but the printer sent no data — check the serial number.'
            : `No answer from ${ip}:8883 — is the printer on and in LAN mode?`,
        }),
      timeoutMs,
    );
    on('connect', () => {
      connected = true;
      client.subscribe(`device/${serial}/report`, (err) => {
        if (err) return finish({ ok: false, error: `Subscribe failed: ${err.message}` });
        client.publish(
          `device/${serial}/request`,
          JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall', version: 1, push_target: 1 } }),
        );
      });
    });
    on('message', () => finish({ ok: true }));
    on('error', (err) => {
      const msg = err.message || String(err);
      finish({
        ok: false,
        error: describeTlsError(err) ?? (/Not authorized|Bad username or password|Connection refused: Not/i.test(msg)
          ? 'Wrong access code.'
          : /connack timeout|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ENETUNREACH/i.test(msg)
            ? `No answer from ${ip}:8883 — is the printer on and in LAN mode?`
            : msg),
      });
    });
  });
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

type Json = Record<string, any>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * P1/A1 printers only send fields that changed, so reports must be merged
 * into the accumulated state. Arrays are replaced wholesale, except the AMS
 * unit list which is merged per unit id (partial AMS updates are common).
 */
export function mergeState(target: Json, patch: Json) {
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeState(target[key], value);
    } else if (key === 'ams' && Array.isArray(value) && Array.isArray(target[key])) {
      target[key] = value.map((unit: Json) => {
        const prev = (target[key] as Json[]).find((u) => u?.id === unit?.id);
        if (!prev) return unit;
        const { tray, ...rest } = unit;
        const merged = structuredClone(prev);
        mergeState(merged, rest);
        if (Array.isArray(tray)) {
          merged.tray = tray.map((t: Json) => {
            const prevTray = (prev.tray ?? []).find((p: Json) => p?.id === t?.id);
            return prevTray ? { ...prevTray, ...t } : t;
          });
        }
        return merged;
      });
    } else if (value !== undefined) {
      target[key] = value;
    }
  }
}

/**
 * One persistent MQTT connection per printer. Emits `update` on any change and
 * `event` (a `PrinterEvent`) when a print job starts, pauses, ends or raises an HMS alert.
 */
export class PrinterConnection extends EventEmitter {
  row: PrinterRow;
  status: ConnectionStatus = 'offline';
  error: string | null = null;
  state: Json = {};
  modules: FirmwareModule[] = [];
  lastReportAt = 0;
  /** Connected, but the printer has not reported for `staleAfterMs`. */
  stale = false;
  /** When the next reconnect attempt is scheduled (0 = none pending). */
  nextRetryAt = 0;
  log: CommandLogEntry[] = [];
  private client: MqttClient | null = null;
  /** Listeners this class added to `client` (removed again on teardown). */
  private clientListeners: [string, (...args: any[]) => void][] = [];
  /** Last job snapshot, for lifecycle event detection (null = nothing seen yet). */
  private lastJob: JobSnapshot | null = null;
  private readonly timing: ConnectionTiming;
  private readonly connectFn: (options: IClientOptions) => MqttClient;
  private readonly rng: () => number;
  /** Consecutive failed connections (reset once a connection proved stable). */
  private attempt = 0;
  private authFailed = false;
  private connectedAt = 0;
  private lastPushallAt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(
    row: PrinterRow,
    options: {
      timing?: Partial<ConnectionTiming>;
      /** MQTT client factory (tests). */
      connect?: (options: IClientOptions) => MqttClient;
      random?: () => number;
    } = {},
  ) {
    super();
    this.row = row;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.connectFn = options.connect ?? ((o) => mqtt.connect(o));
    this.rng = options.random ?? Math.random;
    this.setMaxListeners(100);
  }

  get topicReport() {
    return `device/${this.row.serial}/report`;
  }

  get topicRequest() {
    return `device/${this.row.serial}/request`;
  }

  start() {
    this.stop();
    this.attempt = 0;
    this.authFailed = false;
    this.error = null;
    this.connect();
  }

  stop() {
    this.clearRetry();
    this.teardownClient();
    this.stale = false;
    this.setStatus('offline');
  }

  /**
   * Open a fresh MQTT client. mqtt.js auto-reconnect is off (reconnectPeriod 0):
   * every attempt goes through `retryLater()` so it can back off.
   */
  private connect() {
    this.clearRetry();
    this.teardownClient();
    // Keep showing the last error while retrying.
    if (this.status !== 'error') this.setStatus('connecting');
    const client = this.connectFn({
      protocol: 'mqtts',
      host: this.row.ip,
      port: 8883,
      username: 'bblp',
      password: this.row.access_code,
      clientId: `bambu-web-${crypto.randomBytes(4).toString('hex')}`,
      protocolVersion: 4,
      keepalive: 30,
      connectTimeout: 10_000,
      reconnectPeriod: 0,
      // Verify the printer's certificate (Bambu CA, CN = serial); see tls.ts.
      ...printerTlsOptions(this.row),
    });
    this.client = client;
    const own: [string, (...args: any[]) => void][] = (this.clientListeners = []);
    const on = (event: string, listener: (...args: any[]) => void) => {
      own.push([event, listener]);
      client.on(event as 'connect', listener);
    };

    on('connect', () => {
      this.error = null;
      this.authFailed = false;
      this.connectedAt = this.lastPushallAt = Date.now();
      this.setStatus('online');
      this.startWatchdog();
      client.subscribe(this.topicReport, { qos: 0 }, (err) => {
        if (this.client !== client) return;
        if (err) {
          this.error = `Subscribe failed: ${err.message}`;
          this.setStatus('error');
          this.retryLater();
          return;
        }
        void this.send(cmd.getVersion()).catch(() => {});
        void this.send(cmd.pushAll()).catch(() => {});
      });
    });

    on('message', (_topic, payload) => this.handleMessage(payload));

    on('error', (err) => {
      const msg = err.message || String(err);
      this.authFailed = AUTH_ERROR.test(msg);
      this.error = describeTlsError(err) ?? (this.authFailed
        ? 'Authentication failed — check the access code (it changes when LAN mode is toggled).'
        : msg);
      this.setStatus('error');
      // Normally followed by 'close'; don't rely on it.
      if (!client.connected) this.retryLater();
    });

    on('close', () => {
      if (this.status !== 'error') this.setStatus('offline');
      this.retryLater();
    });
  }

  /** Drop the current client (if any) and schedule the next attempt with backoff. */
  private retryLater() {
    this.teardownClient();
    this.stale = false;
    if (this.status === 'online' || this.status === 'connecting') this.setStatus('offline');
    if (this.retryTimer) return;
    const delay = nextDelay(this.attempt, this.rng, {
      base: this.timing.retryBaseMs,
      cap: this.timing.retryCapMs,
      authFailed: this.authFailed,
    });
    this.attempt++;
    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = 0;
      this.connect();
      this.emit('update');
    }, delay);
    this.emit('update');
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = 0;
  }

  private teardownClient() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const client = this.client;
    if (!client) return;
    this.client = null;
    discardClient(client, this.clientListeners);
    this.clientListeners = [];
  }

  private startWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => this.checkSilence(), this.timing.watchdogMs);
  }

  /**
   * The socket can stay open while the printer stopped reporting (Wi-Fi drop,
   * printer asleep). P1/A1 only send deltas, so first ask for a full status
   * (like Bambu Handy), then flag the data as stale, then force a reconnect.
   */
  private checkSilence(now = Date.now()) {
    if (!this.client || this.status !== 'online') return;
    const t = this.timing;
    const silentFor = now - Math.max(this.lastReportAt, this.connectedAt);
    if (silentFor >= t.reconnectAfterMs) {
      this.error = `No data from the printer for ${Math.round(silentFor / 1000)} s, reconnecting.`;
      this.retryLater();
      return;
    }
    if (silentFor >= t.staleAfterMs && !this.stale) {
      this.stale = true;
      this.emit('update');
    }
    if (silentFor >= t.pushallAfterMs && now - this.lastPushallAt >= t.pushallAfterMs) {
      this.lastPushallAt = now;
      void this.send(cmd.pushAll()).catch(() => {});
    }
  }

  /** Reconfigure after an edit (IP / access code / serial may have changed). */
  update(row: PrinterRow) {
    const reconnect =
      row.ip !== this.row.ip ||
      row.access_code !== this.row.access_code ||
      row.serial !== this.row.serial ||
      row.tls_verify !== this.row.tls_verify;
    this.row = row;
    if (reconnect) {
      this.state = {};
      this.modules = [];
      this.lastJob = null;
      this.start();
    } else {
      this.emit('update');
    }
  }

  async send(payload: cmd.Command): Promise<void> {
    const client = this.client;
    if (!client || !client.connected) throw new Error('Printer is not connected');
    const body = JSON.stringify(payload);
    this.pushLog('out', payload);
    await client.publishAsync(this.topicRequest, body, { qos: 0 });
  }

  private handleMessage(payload: Buffer) {
    let json: Json;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    this.lastReportAt = Date.now();
    this.stale = false;
    // A connection that kept reporting for a while resets the backoff.
    if (this.attempt > 0 && this.lastReportAt - this.connectedAt >= this.timing.stableAfterMs) this.attempt = 0;
    if (this.status !== 'online') this.setStatus('online');

    if (isPlainObject(json.print)) {
      const command = json.print.command;
      if (command === 'push_status' || command === undefined) {
        mergeState(this.state, json.print);
        this.detectJobEvents();
      } else {
        this.pushLog('in', json);
      }
    }
    if (isPlainObject(json.info) && json.info.command === 'get_version' && Array.isArray(json.info.module)) {
      this.modules = json.info.module;
    }
    for (const key of ['system', 'info', 'upgrade', 'mc_print', 'xcam', 'camera']) {
      if (isPlainObject(json[key]) && !(key === 'info' && json.info.command === 'get_version')) {
        this.pushLog('in', json);
      }
    }
    this.emit('update');
  }

  private detectJobEvents() {
    const next = jobSnapshot(this.state);
    const events = detectEvents(this.lastJob, next);
    // Wait for a report that carries the print state before taking the baseline.
    if (next.gcodeState !== null) this.lastJob = next;
    for (const event of events) {
      try {
        this.emit('event', event satisfies PrinterEvent);
      } catch (err) {
        console.error('printer event listener failed', err);
      }
    }
  }

  private pushLog(direction: 'in' | 'out', payload: Json) {
    const inner = (Object.values(payload)[0] ?? {}) as Json;
    this.log.push({ at: Date.now(), direction, command: String(inner.command ?? Object.keys(payload)[0]), payload });
    if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    this.emit('update');
  }

  private connectionInfo() {
    return {
      status: this.status,
      error: this.error,
      lastReportAt: this.lastReportAt,
      /** Online, but no report for a while: shown values may be outdated. */
      stale: this.stale,
      /** Epoch ms of the next reconnect attempt, if one is scheduled. */
      nextRetryAt: this.nextRetryAt || null,
    };
  }

  /** Public representation sent to the browser (never includes the access code). */
  snapshot() {
    const { access_code: _code, ...printer } = this.row;
    return {
      printer,
      connection: this.connectionInfo(),
      state: this.state,
      modules: this.modules,
      log: this.log.slice(-50),
    };
  }

  /** Small summary for the printer list. */
  summary() {
    const s = this.state;
    const temp = (v: unknown) => (typeof v === 'number' ? Math.round(v) : null);
    const { access_code: _code, ...printer } = this.row;
    return {
      printer,
      connection: this.connectionInfo(),
      gcodeState: s.gcode_state ?? null,
      percent: s.mc_percent ?? null,
      remainingMinutes: s.mc_remaining_time ?? null,
      layer: s.layer_num ?? null,
      totalLayers: s.total_layer_num ?? null,
      task: s.subtask_name || s.gcode_file || null,
      nozzle: temp(s.nozzle_temper),
      nozzleTarget: temp(s.nozzle_target_temper),
      bed: temp(s.bed_temper),
      bedTarget: temp(s.bed_target_temper),
      hmsCount: Array.isArray(s.hms) ? s.hms.length : 0,
    };
  }
}
