/**
 * Printer vocabulary shared by the server and the web UI: how the printer's
 * reports are interpreted wherever both sides need the same answer.
 * Platform-neutral (no Node or DOM APIs).
 */

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'error';

export const CAMERA_SETTINGS = ['auto', 'jpeg', 'rtsps', 'none'] as const;
/** Camera transport chosen per printer; `auto` follows the model. */
export type CameraSetting = (typeof CAMERA_SETTINGS)[number];
export type CameraKind = Exclude<CameraSetting, 'auto'>;

/** `gcode_state` values reported in push_status. */
type GcodeState = 'IDLE' | 'PREPARE' | 'RUNNING' | 'PAUSE' | 'FINISH' | 'FAILED' | 'SLICING' | 'INIT' | 'OFFLINE';

const is = (...states: GcodeState[]) => (state: unknown) => states.includes(state as GcodeState);

/** A print job exists: from preparation (or cloud slicing) until it ends. */
export const jobActive = is('PREPARE', 'RUNNING', 'PAUSE', 'SLICING');
/** The job reached the printing phase (objects can be skipped). */
export const jobPrinting = is('RUNNING', 'PAUSE');
/** The printer moves the toolhead itself: manual moves must wait. */
export const motionLocked = is('PREPARE', 'RUNNING');
/** No job is open any more. */
export const jobEnded = is('IDLE', 'FINISH', 'FAILED');

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** `print_error` as Bambu writes it, e.g. 0300_4000. */
export const printErrorCode = (n: number) => `${hex4((n >>> 16) & 0xffff)}_${hex4(n & 0xffff)}`;

export interface HmsAlert {
  attr: number;
  code: number;
}

/** HMS severity: 1 = fatal, 2 = serious, 3 = common, 4 = info (anything else is unknown). */
export const hmsSeverity = (alert: HmsAlert) => (alert.code >>> 16) & 0xffff;

/** HMS code as Bambu documents it, e.g. 0300_0100_0001_0007, and its wiki page. */
export function hmsCode(alert: HmsAlert) {
  const code = `${printErrorCode(alert.attr >>> 0)}_${printErrorCode(alert.code >>> 0)}`;
  return { code, url: `https://e.bambulab.com/index.php?e=${code.replaceAll('_', '')}&s=device_hms&lang=en` };
}

/**
 * AMS tray numbers (`tray_now`, the load command's target): unit·4 + slot,
 * an AMS HT unit's own id (>= 128, a single slot), or one of these.
 */
export const EXTERNAL_TRAY = 254;
export const NO_TRAY = 255;
export const trayId = (unit: number, slot: number) => (unit >= 128 ? unit : unit * 4 + slot);

/** A print object's `identify_id`: a positive 31-bit integer, possibly reported as a string. */
export function objectId(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n <= 0x7fffffff ? n : null;
}

/** Objects of the running print the printer already skipped (`s_obj`). */
export function skippedIds(state: Record<string, any>): number[] {
  return Array.isArray(state.s_obj) ? state.s_obj.map(objectId).filter((n): n is number => n !== null) : [];
}
