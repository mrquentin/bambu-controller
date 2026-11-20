/**
 * Helpers to interpret the printer's `push_status` report.
 * Bit layouts recovered from LanBu's BambuUtility.
 * Labels come from the message catalogs (web/src/locales).
 */
import { formatDate, formatNumber, t, type MessageKey } from './i18n.ts';

type State = Record<string, any>;

/** Tone per gcode_state; the label is the `state.<STATE>` message. */
export const GCODE_STATES: Record<string, string> = {
  IDLE: 'muted',
  PREPARE: 'info',
  SLICING: 'info',
  RUNNING: 'accent',
  PAUSE: 'warn',
  FINISH: 'ok',
  FAILED: 'danger',
};

export function gcodeStateInfo(state: string | null | undefined) {
  if (!state) return { label: t('common.unknown'), tone: 'muted' };
  const tone = GCODE_STATES[state];
  return tone ? { label: t(`state.${state}` as MessageKey), tone } : { label: state, tone: 'muted' };
}

/** stg_cur values 0..STAGE_COUNT-1 each have a `stage.<n>` message. */
export const STAGE_COUNT = 36;

export function stageLabel(s: State): string | null {
  const stage = s.stg_cur;
  if (typeof stage !== 'number' || stage < 0 || stage === 255) return null;
  return stage < STAGE_COUNT ? t(`stage.${stage}` as MessageKey) : t('stage.unknown', { stage: String(stage) });
}

export const SPEED_LEVELS = [
  { level: 1, key: 'speed.silent', pct: 50 },
  { level: 2, key: 'speed.standard', pct: 100 },
  { level: 3, key: 'speed.sport', pct: 124 },
  { level: 4, key: 'speed.ludicrous', pct: 166 },
] as const;

/** Packed temperature: low 16 bits = current, high 16 bits = target. */
export const packedCurrent = (v: number) => v & 0xffff;
export const packedTarget = (v: number) => (v >>> 16) & 0xffff;

export interface Nozzle {
  index: number | null;
  label: string;
  current: number | null;
  target: number | null;
}

/** Single nozzle on most models; H2D reports both via device.extruder.info. */
export function nozzles(s: State): Nozzle[] {
  const info = s.device?.extruder?.info;
  if (Array.isArray(info) && info.length > 1) {
    return info.map((e: State) => ({
      index: e.id,
      label: t(e.id === 0 ? 'temp.rightNozzle' : 'temp.leftNozzle'),
      current: typeof e.temp === 'number' ? packedCurrent(e.temp) : null,
      target: typeof e.temp === 'number' ? packedTarget(e.temp) : null,
    }));
  }
  return [
    {
      index: null,
      label: t('temp.nozzle'),
      current: num(s.nozzle_temper),
      target: num(s.nozzle_target_temper),
    },
  ];
}

export function chamber(s: State): { current: number | null; target: number | null } {
  const packed = s.device?.ctc?.info?.temp;
  if (typeof packed === 'number') return { current: packedCurrent(packed), target: packedTarget(packed) };
  return { current: num(s.chamber_temper), target: typeof s.ctt === 'number' ? s.ctt : null };
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

/** Fan speeds are reported as strings "0".."15"; round to the nearest 10%. */
export function fanPercent(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return Math.round(((n / 15) * 100) / 10) * 10;
}

export const HOME_FLAGS = {
  doorOpen: 1 << 23,
  sdCardPresent: 1 << 8,
  sdCardAbnormal: 1 << 9,
  amsAutoSwitch: 1 << 10,
  cameraRecording: 1 << 5,
  wiredNetwork: 1 << 18,
  xHomed: 1 << 0,
  yHomed: 1 << 1,
  zHomed: 1 << 2,
};

export function hasFlag(s: State, flag: number) {
  return typeof s.home_flag === 'number' && (s.home_flag & flag) !== 0;
}

export function formatDuration(minutes: number | null | undefined) {
  if (minutes === null || minutes === undefined || minutes < 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0
    ? t('duration.hoursMinutes', { h: String(h), m: m.toString().padStart(2, '0') })
    : t('duration.minutes', { m: String(m) });
}

export function formatEta(minutes: number | null | undefined) {
  if (!minutes || minutes <= 0) return null;
  const eta = new Date(Date.now() + minutes * 60_000);
  const sameDay = eta.toDateString() === new Date().toDateString();
  // weekday can't be combined with timeStyle: spell the time fields out.
  return formatDate(eta, sameDay ? { timeStyle: 'short' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function formatBytes(n: number) {
  if (n < 1024) return t('unit.bytes', { value: n });
  const units = ['unit.kb', 'unit.mb', 'unit.gb'] as const;
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v < 10 ? 1 : 0;
  return t(units[i], { value: formatNumber(v, { minimumFractionDigits: digits, maximumFractionDigits: digits }) });
}

const hex4 = (v: number) => (v >>> 0).toString(16).toUpperCase().padStart(4, '0');

/** Tone per HMS severity; the label is the `hms.severity.<n>` message. */
export const HMS_SEVERITY: Record<number, string> = {
  1: 'danger',
  2: 'danger',
  3: 'warn',
  4: 'info',
};

export function hmsInfo(item: { attr: number; code: number }) {
  const attr = item.attr >>> 0;
  const code = item.code >>> 0;
  const parts = [hex4(attr >>> 16), hex4(attr & 0xffff), hex4(code >>> 16), hex4(code & 0xffff)];
  const tone = HMS_SEVERITY[code >>> 16];
  const severity = tone
    ? { label: t(`hms.severity.${code >>> 16}` as MessageKey), tone }
    : { label: t('common.unknown'), tone: 'muted' };
  return {
    code: parts.join('_'),
    severity,
    url: `https://e.bambulab.com/index.php?e=${parts.join('')}&s=device_hms&lang=en`,
  };
}

/** AMS humidity level ("1" = wet … "5" = very dry) as text, or null when unknown. */
export function amsHumidityLabel(level: unknown): string | null {
  const n = String(level);
  return /^[1-5]$/.test(n) ? t(`ams.humidity.${n}` as MessageKey) : null;
}

/** tray_color is RRGGBBAA. */
export function trayColor(hex: string | undefined) {
  if (!hex || hex.length < 6) return 'transparent';
  return `#${hex.slice(0, 6)}`;
}

export function wifiLabel(signal: string | undefined) {
  if (!signal) return '—';
  return signal;
}
