import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import mqtt, { type MqttClient } from 'mqtt';
import type { PrinterRow } from '../db.ts';
import * as cmd from './commands.ts';
import { describeTlsError, printerTlsOptions } from './tls.ts';

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'error';

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
    const finish = (result: { ok: true } | { ok: false; error: string }) => {
      clearTimeout(timer);
      client.removeAllListeners();
      client.on('error', () => {});
      client.end(true);
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
    client.on('connect', () => {
      connected = true;
      client.subscribe(`device/${serial}/report`, (err) => {
        if (err) return finish({ ok: false, error: `Subscribe failed: ${err.message}` });
        client.publish(
          `device/${serial}/request`,
          JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall', version: 1, push_target: 1 } }),
        );
      });
    });
    client.on('message', () => finish({ ok: true }));
    client.on('error', (err) => {
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
function mergeState(target: Json, patch: Json) {
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

/** One persistent MQTT connection per printer. Emits `update` on any change. */
export class PrinterConnection extends EventEmitter {
  row: PrinterRow;
  status: ConnectionStatus = 'offline';
  error: string | null = null;
  state: Json = {};
  modules: FirmwareModule[] = [];
  lastReportAt = 0;
  log: CommandLogEntry[] = [];
  private client: MqttClient | null = null;

  constructor(row: PrinterRow) {
    super();
    this.row = row;
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
    this.setStatus('connecting');
    const client = mqtt.connect({
      protocol: 'mqtts',
      host: this.row.ip,
      port: 8883,
      username: 'bblp',
      password: this.row.access_code,
      clientId: `bambu-web-${crypto.randomBytes(4).toString('hex')}`,
      protocolVersion: 4,
      keepalive: 30,
      connectTimeout: 10_000,
      reconnectPeriod: 5_000,
      // Verify the printer's certificate (Bambu CA, CN = serial); see tls.ts.
      ...printerTlsOptions(this.row),
    });
    this.client = client;

    client.on('connect', () => {
      this.error = null;
      this.setStatus('online');
      client.subscribe(this.topicReport, { qos: 0 }, (err) => {
        if (err) {
          this.error = `Subscribe failed: ${err.message}`;
          this.setStatus('error');
          return;
        }
        void this.send(cmd.getVersion()).catch(() => {});
        void this.send(cmd.pushAll()).catch(() => {});
      });
    });

    client.on('message', (_topic, payload) => this.handleMessage(payload));

    client.on('error', (err) => {
      const msg = err.message || String(err);
      this.error = describeTlsError(err) ?? (/Not authorized|Bad username or password/i.test(msg)
        ? 'Authentication failed — check the access code (it changes when LAN mode is toggled).'
        : msg);
      this.setStatus('error');
    });

    client.on('close', () => {
      if (this.status !== 'error') this.setStatus('offline');
    });
    client.on('reconnect', () => {
      if (this.status !== 'error') this.setStatus('connecting');
    });
  }

  stop() {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.on('error', () => {});
      this.client.end(true);
      this.client = null;
    }
    this.setStatus('offline');
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
    if (this.status !== 'online') this.setStatus('online');

    if (isPlainObject(json.print)) {
      const command = json.print.command;
      if (command === 'push_status' || command === undefined) {
        mergeState(this.state, json.print);
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

  /** Public representation sent to the browser (never includes the access code). */
  snapshot() {
    const { access_code: _code, ...printer } = this.row;
    return {
      printer,
      connection: { status: this.status, error: this.error, lastReportAt: this.lastReportAt },
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
      connection: { status: this.status, error: this.error, lastReportAt: this.lastReportAt },
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
