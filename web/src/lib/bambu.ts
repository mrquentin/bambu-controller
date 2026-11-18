/**
 * Helpers to interpret the printer's `push_status` report.
 * Bit layouts recovered from LanBu's BambuUtility.
 */

type State = Record<string, any>;

export const GCODE_STATES: Record<string, { label: string; tone: string }> = {
  IDLE: { label: 'Idle', tone: 'muted' },
  PREPARE: { label: 'Preparing', tone: 'info' },
  SLICING: { label: 'Slicing', tone: 'info' },
  RUNNING: { label: 'Printing', tone: 'accent' },
  PAUSE: { label: 'Paused', tone: 'warn' },
  FINISH: { label: 'Finished', tone: 'ok' },
  FAILED: { label: 'Failed', tone: 'danger' },
};

export function gcodeStateInfo(state: string | null | undefined) {
  if (!state) return { label: 'Unknown', tone: 'muted' };
  return GCODE_STATES[state] ?? { label: state, tone: 'muted' };
}

export const STAGES: Record<number, string> = {
  0: 'Printing',
  1: 'Auto bed leveling',
  2: 'Heatbed preheating',
  3: 'Vibration compensation',
  4: 'Changing filament',
  5: 'M400 pause',
  6: 'Paused: filament runout',
  7: 'Heating hotend',
  8: 'Calibrating extrusion',
  9: 'Scanning bed surface',
  10: 'Inspecting first layer',
  11: 'Identifying build plate',
  12: 'Calibrating micro lidar',
  13: 'Homing toolhead',
  14: 'Cleaning nozzle tip',
  15: 'Checking extruder temperature',
  16: 'Paused by user',
  17: 'Paused: front cover falling',
  18: 'Calibrating micro lidar',
  19: 'Calibrating extrusion flow',
  20: 'Paused: nozzle temperature malfunction',
  21: 'Paused: heatbed temperature malfunction',
  22: 'Unloading filament',
  23: 'Paused: skipped step',
  24: 'Loading filament',
  25: 'Calibrating motor noise',
  26: 'Paused: AMS lost',
  27: 'Paused: heatbreak fan too slow',
  28: 'Paused: chamber temperature control error',
  29: 'Cooling chamber',
  30: 'Paused by G-code',
  31: 'Motor noise showoff',
  32: 'Paused: nozzle filament covered',
  33: 'Paused: cutter error',
  34: 'Paused: first layer error',
  35: 'Paused: nozzle clog',
};

export function stageLabel(s: State): string | null {
  const stage = s.stg_cur;
  if (typeof stage !== 'number' || stage < 0 || stage === 255) return null;
  return STAGES[stage] ?? `Stage ${stage}`;
}

export const SPEED_LEVELS = [
  { level: 1, label: 'Silent', pct: 50 },
  { level: 2, label: 'Standard', pct: 100 },
  { level: 3, label: 'Sport', pct: 124 },
  { level: 4, label: 'Ludicrous', pct: 166 },
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
      label: e.id === 0 ? 'Right nozzle' : 'Left nozzle',
      current: typeof e.temp === 'number' ? packedCurrent(e.temp) : null,
      target: typeof e.temp === 'number' ? packedTarget(e.temp) : null,
    }));
  }
  return [
    {
      index: null,
      label: 'Nozzle',
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
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
}

export function formatEta(minutes: number | null | undefined) {
  if (!minutes || minutes <= 0) return null;
  const eta = new Date(Date.now() + minutes * 60_000);
  const sameDay = eta.toDateString() === new Date().toDateString();
  return eta.toLocaleString(undefined, sameDay ? { timeStyle: 'short' } : { weekday: 'short', timeStyle: 'short' });
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

const hex4 = (v: number) => (v >>> 0).toString(16).toUpperCase().padStart(4, '0');

export const HMS_SEVERITY: Record<number, { label: string; tone: string }> = {
  1: { label: 'Fatal', tone: 'danger' },
  2: { label: 'Serious', tone: 'danger' },
  3: { label: 'Common', tone: 'warn' },
  4: { label: 'Info', tone: 'info' },
};

export function hmsInfo(item: { attr: number; code: number }) {
  const attr = item.attr >>> 0;
  const code = item.code >>> 0;
  const parts = [hex4(attr >>> 16), hex4(attr & 0xffff), hex4(code >>> 16), hex4(code & 0xffff)];
  const severity = HMS_SEVERITY[code >>> 16] ?? { label: 'Unknown', tone: 'muted' };
  return {
    code: parts.join('_'),
    severity,
    url: `https://e.bambulab.com/index.php?e=${parts.join('')}&s=device_hms&lang=en`,
  };
}

export const AMS_HUMIDITY: Record<string, string> = {
  '1': 'Wet',
  '2': 'Damp',
  '3': 'Normal',
  '4': 'Dry',
  '5': 'Very dry',
};

/** tray_color is RRGGBBAA. */
export function trayColor(hex: string | undefined) {
  if (!hex || hex.length < 6) return 'transparent';
  return `#${hex.slice(0, 6)}`;
}

export function wifiLabel(signal: string | undefined) {
  if (!signal) return '—';
  return signal;
}
