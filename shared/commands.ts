/**
 * Printer commands the web UI can send (POST /api/printers/:id/command): each
 * action with its parameters and their limits. The server validates request
 * bodies with the JSON schema of these parameters; the UI is typed by
 * `PrinterCommand` and takes input limits from `LIMITS`.
 */

interface Param<T, Optional extends boolean = false> {
  /** JSON schema of the value. `errorMessage` is the message shown when it is invalid. */
  schema: Record<string, unknown>;
  optional: Optional;
  /** Type marker only (never set). */
  type?: T;
}

export interface Range {
  min: number;
  max: number;
}

export const LIMITS = {
  nozzleTemp: { min: 0, max: 350 },
  bedTemp: { min: 0, max: 120 },
  chamberTemp: { min: 0, max: 65 },
  fanPercent: { min: 0, max: 100 },
  jogDistance: { min: -100, max: 100 },
  extrudeDistance: { min: -50, max: 50 },
  gcodeLength: { min: 1, max: 4000 },
  /** Objects skipped in one command. */
  skipIds: { min: 1, max: 256 },
} satisfies Record<string, Range>;

/** Print speed levels: 1 = silent, 2 = standard, 3 = sport, 4 = ludicrous. */
export type SpeedLevel = 1 | 2 | 3 | 4;
/** Fans driven by M106 P<n>: 1 = part cooling, 2 = auxiliary, 3 = chamber. */
export type FanId = 1 | 2 | 3;
export const LIGHT_NODES = ['chamber_light', 'chamber_light2', 'work_light'] as const;
export type LightNode = (typeof LIGHT_NODES)[number];
const JOG_AXES = ['X', 'Y', 'Z'] as const;
export type JogAxis = (typeof JOG_AXES)[number];

function between({ min, max }: Range) {
  const message = `Value must be between ${min} and ${max}`;
  return { minimum: message, maximum: message };
}

function number(range: Range): Param<number> {
  return { schema: { type: 'number', minimum: range.min, maximum: range.max, errorMessage: between(range) }, optional: false };
}

function integer<T extends number = number>(range: Range): Param<T> {
  return { schema: { type: 'integer', minimum: range.min, maximum: range.max, errorMessage: between(range) }, optional: false };
}

function oneOf<const T extends readonly string[]>(values: T, errorMessage?: string): Param<T[number]> {
  return { schema: { type: 'string', enum: values, ...(errorMessage && { errorMessage }) }, optional: false };
}

function optional<T>(param: Param<T>): Param<T | undefined, true> {
  return { ...param, optional: true };
}

const boolean: Param<boolean> = { schema: { type: 'boolean' }, optional: false };

const idsMessage = `ids must be a list of ${LIMITS.skipIds.min} to ${LIMITS.skipIds.max} object ids`;

export const COMMANDS = {
  /** Ask for a full status report. */
  refresh: {},
  pause: {},
  resume: {},
  stop: {},
  speed: { level: integer<SpeedLevel>({ min: 1, max: 4 }) },
  light: { node: oneOf(LIGHT_NODES), on: boolean },
  /** `extruder` targets one nozzle of multi-extruder printers (H2D): 0 = right, 1 = left. */
  nozzleTemp: { temp: number(LIMITS.nozzleTemp), extruder: optional(integer({ min: 0, max: 1 })) },
  bedTemp: { temp: number(LIMITS.bedTemp) },
  chamberTemp: { temp: number(LIMITS.chamberTemp) },
  fan: { fan: integer<FanId>({ min: 1, max: 3 }), percent: number(LIMITS.fanPercent) },
  home: {},
  jog: { axis: oneOf(JOG_AXES, 'Invalid axis'), distance: number(LIMITS.jogDistance) },
  /** Extrude (positive) or retract (negative), in mm. */
  extrude: { distance: number(LIMITS.extrudeDistance) },
  gcode: {
    gcode: {
      schema: { type: 'string', maxLength: LIMITS.gcodeLength.max, pattern: '\\S', errorMessage: 'G-code is empty or too long' },
      optional: false,
    } as Param<string>,
  },
  unloadFilament: {},
  /** AMS tray number (see `trayId` in printer.ts). */
  loadFilament: { tray: integer({ min: 0, max: 254 }) },
  /** `identify_id`s of objects of the running print. */
  skipObjects: {
    ids: {
      schema: {
        type: 'array',
        minItems: LIMITS.skipIds.min,
        maxItems: LIMITS.skipIds.max,
        items: { type: 'integer', minimum: 1, maximum: 0x7fffffff, errorMessage: 'Object ids must be positive integers' },
        errorMessage: idsMessage,
      },
      optional: false,
    } as Param<number[]>,
  },
} satisfies Record<string, Record<string, Param<unknown, boolean>>>;

type CommandAction = keyof typeof COMMANDS;

type ValueOf<P> = P extends Param<infer T, boolean> ? T : never;
type RequiredKeys<S> = { [K in keyof S]: S[K] extends Param<unknown, true> ? never : K }[keyof S];
type Params<S> = { [K in RequiredKeys<S>]: ValueOf<S[K]> } & { [K in Exclude<keyof S, RequiredKeys<S>>]?: ValueOf<S[K]> };

/** Body of POST /api/printers/:id/command. */
export type PrinterCommand = { [A in CommandAction]: { action: A } & Params<(typeof COMMANDS)[A]> }[CommandAction];
