import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import type { CommandLogEntry, ConnectionInfo, FirmwareModule, PrinterDetail, PrinterInfo, PrinterSummary } from '../../shared/api.ts';
import type { ConnectionStatus } from '../../shared/printer.ts';
import { HttpError } from '../http-error.ts';
import { log } from '../log.ts';
import * as cmd from './commands.ts';
import { nextDelay } from './backoff.ts';
import { JobTracker, jobSnapshot, type PrinterEvent } from './job-events.ts';
import { describeTlsError, printerTlsOptions, type PrinterEndpoint } from './tls.ts';

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

const AUTH_ERROR = /Not authorized|Bad username or password|Connection refused: Not/i;

const reportTopic = (serial: string) => `device/${serial}/report`;
const requestTopic = (serial: string) => `device/${serial}/request`;

/** MQTT over TLS on 8883, user "bblp", password = access code. Reconnects are left to the caller. */
function mqttOptions(target: PrinterEndpoint, clientId: string, connectTimeout: number): IClientOptions {
  return {
    protocol: 'mqtts',
    host: target.ip,
    port: 8883,
    username: 'bblp',
    password: target.access_code,
    clientId: `${clientId}-${crypto.randomBytes(4).toString('hex')}`,
    protocolVersion: 4,
    keepalive: 30,
    connectTimeout,
    reconnectPeriod: 0,
    ...printerTlsOptions(target),
  };
}

type Listener = (...args: any[]) => void;

/**
 * Tracks the listeners this app adds to an mqtt.js client, so closing it
 * removes only those: `removeAllListeners()` would also drop mqtt.js's own
 * 'close' handler, which clears its connect timer (a failed TLS handshake then
 * kept the process busy for `connectTimeout`).
 */
function listenTo(client: MqttClient) {
  const own: [string, Listener][] = [];
  return {
    on(event: string, listener: Listener) {
      own.push([event, listener]);
      client.on(event as 'connect', listener);
    },
    discard() {
      for (const [event, listener] of own) client.removeListener(event as 'connect', listener);
      client.on('error', () => {});
      client.end(true);
    },
  };
}

const unreachable = (ip: string) => `No answer from ${ip}:8883 — is the printer on and in LAN mode?`;

/** What went wrong with an MQTT connection, in the user's terms. */
function describeMqttError(err: Error, ip: string): { message: string; authFailed: boolean } {
  const msg = err.message || String(err);
  const authFailed = AUTH_ERROR.test(msg);
  const message =
    describeTlsError(err) ??
    (authFailed
      ? 'Wrong access code (it changes when LAN mode is toggled).'
      : /connack timeout|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ENETUNREACH/i.test(msg)
        ? unreachable(ip)
        : msg);
  return { message, authFailed };
}

/**
 * One-shot credential check used before saving a printer: connect over MQTT,
 * subscribe to the report topic and wait for the first message.
 */
export function testConnection(target: PrinterEndpoint, timeoutMs = 12_000) {
  return new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    const client = mqtt.connect(mqttOptions(target, 'bambu-web-test', timeoutMs));
    const listeners = listenTo(client);
    let connected = false;
    const finish = (result: { ok: true } | { ok: false; error: string }) => {
      clearTimeout(timer);
      listeners.discard();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: connected ? 'Connected, but the printer sent no data — check the serial number.' : unreachable(target.ip),
        }),
      timeoutMs,
    );
    listeners.on('connect', () => {
      connected = true;
      client.subscribe(reportTopic(target.serial), (err) => {
        if (err) return finish({ ok: false, error: `Subscribe failed: ${err.message}` });
        client.publish(requestTopic(target.serial), JSON.stringify(cmd.pushAll()));
      });
    });
    listeners.on('message', () => finish({ ok: true }));
    listeners.on('error', (err) => finish({ ok: false, error: describeMqttError(err, target.ip).message }));
  });
}

/** A configured printer, with its access code. */
type PrinterSettings = PrinterInfo & PrinterEndpoint;

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
  row: PrinterSettings;
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
  private mqttListeners: ReturnType<typeof listenTo> | null = null;
  private readonly jobs = new JobTracker();
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
    row: PrinterSettings,
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

  /** Open a fresh MQTT client; every attempt goes through `retryLater()` so it can back off. */
  private connect() {
    this.clearRetry();
    this.teardownClient();
    if (this.status !== 'error') this.setStatus('connecting');
    const client = this.connectFn(mqttOptions(this.row, 'bambu-web', 10_000));
    const listeners = listenTo(client);
    this.client = client;
    this.mqttListeners = listeners;

    listeners.on('connect', () => {
      this.error = null;
      this.authFailed = false;
      this.connectedAt = this.lastPushallAt = Date.now();
      this.setStatus('online');
      this.startWatchdog();
      client.subscribe(reportTopic(this.row.serial), { qos: 0 }, (err) => {
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

    listeners.on('message', (_topic, payload) => this.handleMessage(payload));

    listeners.on('error', (err) => {
      ({ message: this.error, authFailed: this.authFailed } = describeMqttError(err, this.row.ip));
      this.setStatus('error');
      // Normally followed by 'close'; don't rely on it.
      if (!client.connected) this.retryLater();
    });

    listeners.on('close', () => {
      if (this.status !== 'error') this.setStatus('offline');
      this.retryLater();
    });
  }

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
    this.mqttListeners?.discard();
    this.mqttListeners = null;
    this.client = null;
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
  update(row: PrinterSettings) {
    const reconnect =
      row.ip !== this.row.ip ||
      row.access_code !== this.row.access_code ||
      row.serial !== this.row.serial ||
      row.tls_verify !== this.row.tls_verify;
    this.row = row;
    if (reconnect) {
      this.state = {};
      this.modules = [];
      this.jobs.reset();
      this.start();
    } else {
      this.emit('update');
    }
  }

  async send(payload: cmd.Command): Promise<void> {
    const client = this.client;
    if (!client || !client.connected) throw new HttpError(503, 'Printer is not connected');
    this.pushLog('out', payload);
    try {
      await client.publishAsync(requestTopic(this.row.serial), JSON.stringify(payload), { qos: 0 });
    } catch (err) {
      throw new HttpError(503, (err as Error).message);
    }
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
    for (const event of this.jobs.observe(this.state).events) {
      try {
        this.emit('event', event satisfies PrinterEvent);
      } catch (err) {
        log.error({ err }, 'printer event listener failed');
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

  private connectionInfo(): ConnectionInfo {
    return {
      status: this.status,
      error: this.error,
      lastReportAt: this.lastReportAt,
      stale: this.stale,
      nextRetryAt: this.nextRetryAt || null,
    };
  }

  /** Never includes the access code. */
  private publicRow() {
    const { access_code: _code, ...printer } = this.row;
    return printer;
  }

  /** Live part of the printer view sent to the browser. */
  snapshot(): Pick<PrinterDetail, 'printer' | 'connection' | 'state' | 'modules' | 'log'> {
    return {
      printer: this.publicRow(),
      connection: this.connectionInfo(),
      state: this.state,
      modules: this.modules,
      log: this.log.slice(-50),
    };
  }

  /** Small summary for the printer list. */
  summary(): PrinterSummary {
    const s = this.state;
    const job = jobSnapshot(s);
    const temp = (v: unknown) => (typeof v === 'number' ? Math.round(v) : null);
    return {
      printer: this.publicRow(),
      connection: this.connectionInfo(),
      gcodeState: job.gcodeState,
      percent: job.percent,
      remainingMinutes: job.remainingMinutes,
      layer: job.layer,
      totalLayers: job.totalLayers,
      task: job.task,
      nozzle: temp(s.nozzle_temper),
      nozzleTarget: temp(s.nozzle_target_temper),
      bed: temp(s.bed_temper),
      bedTarget: temp(s.bed_target_temper),
      hmsCount: Array.isArray(s.hms) ? s.hms.length : 0,
    };
  }
}
