/**
 * What the web forms send and the limits both sides enforce: the server
 * validates request bodies against them, the UI gives its inputs the same
 * bounds so the user hears about a problem before submitting.
 */
import type { CameraSetting } from './printer.ts';

export const ACCOUNT = {
  username: { minLength: 3, maxLength: 32 },
  password: { minLength: 10, maxLength: 256 },
};

export const PRINTER = {
  name: { maxLength: 64 },
  serial: { minLength: 6, maxLength: 32 },
  host: { maxLength: 253 },
  /** Shown on the printer's screen (8 characters on current models). */
  accessCode: { minLength: 4, maxLength: 32 },
};

/** Body of POST /api/printers (add) and PUT /api/printers/:id (edit). */
export interface PrinterRequest {
  name: string;
  model: string;
  serial: string;
  ip: string;
  /** On edit, blank keeps the stored one. */
  accessCode?: string;
  camera?: CameraSetting;
  tlsVerify?: boolean;
  /** Add only: save without checking the connection first (printer offline). */
  skipTest?: boolean;
}

export const PLATE = { min: 1, max: 99 };

/** Body of POST /api/printers/:id/print: start a sliced project from the printer's storage. */
export interface PrintRequest {
  path: string;
  plate?: number;
  bedLeveling?: boolean;
  timelapse?: boolean;
  useAms?: boolean;
  flowCali?: boolean;
  vibrationCali?: boolean;
  layerInspect?: boolean;
  /** AMS slot per filament of the project; -1 leaves a filament unmapped. */
  amsMapping?: number[];
}

export const MAX_PATH_LENGTH = 1024;
