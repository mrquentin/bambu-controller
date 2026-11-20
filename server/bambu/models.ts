import type { CameraKind, CameraSetting } from '../../shared/printer.ts';

/**
 * Printer models. `codes` are what printers advertise over SSDP
 * (`DevModel.bambu.com`), recovered from LanBu's
 * BambuUtility.GetSupportedPrinterDictionary.
 *
 * `basic` models (A1 / P1 series) stream the camera as JPEG frames over TLS on
 * port 6000 and print from storage through "ftp:///" URLs. The others expose
 * RTSPS on port 322 (requires "LAN Mode Liveview" on X1) and print through
 * "file:///sdcard/" URLs (internal storage + SD), as LanBu does.
 */
interface Model {
  name: string;
  codes: string[];
  basic: boolean;
  /** Heated / controlled chamber (set_ctt). */
  chamberControl: boolean;
}

const MODEL_TABLE: Model[] = [
  { name: 'A1 Mini', codes: ['N1'], basic: true, chamberControl: false },
  { name: 'A1', codes: ['N2S'], basic: true, chamberControl: false },
  { name: 'P1P', codes: ['C11'], basic: true, chamberControl: false },
  { name: 'P1S', codes: ['C12'], basic: true, chamberControl: false },
  { name: 'P2S', codes: ['N7'], basic: false, chamberControl: false },
  { name: 'X1', codes: ['BL-P002'], basic: false, chamberControl: false },
  { name: 'X1C', codes: ['BL-P001'], basic: false, chamberControl: false },
  { name: 'X1E', codes: ['C13'], basic: false, chamberControl: true },
  { name: 'X2D', codes: ['N6'], basic: false, chamberControl: true },
  { name: 'H2S', codes: ['O1S'], basic: false, chamberControl: true },
  { name: 'H2D', codes: ['O1D'], basic: false, chamberControl: true },
  { name: 'H2D Pro', codes: ['O1E'], basic: false, chamberControl: true },
  { name: 'H2C', codes: ['O1C', 'O1C2'], basic: false, chamberControl: true },
];

/** Unknown (newer) models are assumed to work like the current flagship ones. */
const UNKNOWN: Model = { name: '', codes: [], basic: false, chamberControl: false };

const byName = (name: string) => MODEL_TABLE.find((m) => m.name === name) ?? UNKNOWN;

export const MODELS = MODEL_TABLE.map((m) => m.name);

export function modelFromCode(code: string): string {
  return MODEL_TABLE.find((m) => m.codes.includes(code))?.name ?? code;
}

export function cameraKindFor(model: string, setting: CameraSetting): CameraKind {
  if (setting !== 'auto') return setting;
  return byName(model).basic ? 'jpeg' : 'rtsps';
}

export function supportsChamberControl(model: string) {
  return byName(model).chamberControl;
}

/** URL of a file on the printer's storage, for the project_file print command. */
export function printUrlFor(model: string, path: string) {
  const clean = path.replace(/^\/+/, '');
  return byName(model).basic ? `ftp:///${clean}` : `file:///sdcard/${clean}`;
}
