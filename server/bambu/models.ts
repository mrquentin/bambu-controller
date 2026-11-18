/**
 * Printer model metadata.
 *
 * Model codes are what printers advertise over SSDP (`DevModel.bambu.com`).
 * Mapping recovered from LanBu's BambuUtility.GetSupportedPrinterDictionary.
 */
export const MODEL_CODES: Record<string, string> = {
  'BL-P001': 'X1C',
  'BL-P002': 'X1',
  C13: 'X1E',
  C11: 'P1P',
  C12: 'P1S',
  N1: 'A1 Mini',
  N2S: 'A1',
  N6: 'X2D',
  N7: 'P2S',
  O1C: 'H2C',
  O1C2: 'H2C',
  O1D: 'H2D',
  O1E: 'H2D Pro',
  O1S: 'H2S',
};

export const MODELS = ['A1 Mini', 'A1', 'P1P', 'P1S', 'P2S', 'X1', 'X1C', 'X1E', 'X2D', 'H2S', 'H2D', 'H2D Pro', 'H2C'];

/**
 * "Basic" models stream the camera as JPEG frames over TLS on port 6000.
 * Everything else exposes RTSPS on port 322 (requires "LAN Mode Liveview" on X1).
 */
const JPEG_CAMERA_MODELS = new Set(['A1 Mini', 'A1', 'P1P', 'P1S']);

export type CameraKind = 'jpeg' | 'rtsps' | 'none';

export function cameraKindFor(model: string, setting: string): CameraKind {
  if (setting === 'jpeg' || setting === 'rtsps' || setting === 'none') return setting;
  return JPEG_CAMERA_MODELS.has(model) ? 'jpeg' : 'rtsps';
}

export function modelFromCode(code: string): string {
  return MODEL_CODES[code] ?? code;
}

/** Models with a heated/controlled chamber (set_ctt). */
export function supportsChamberControl(model: string) {
  return model === 'X1E' || model.startsWith('H2') || model === 'X2D';
}

/**
 * Print URL scheme for project_file. LanBu uses "file:///sdcard/" for the
 * X1/H2 family (internal storage + SD) and "ftp://" for the basic models.
 */
export function printUrlFor(model: string, path: string) {
  const clean = path.replace(/^\/+/, '');
  return JPEG_CAMERA_MODELS.has(model) ? `ftp:///${clean}` : `file:///sdcard/${clean}`;
}
