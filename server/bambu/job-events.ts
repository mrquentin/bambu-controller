/**
 * Print-job lifecycle detection.
 *
 * Reports are merged into an accumulated state (see `mergeState`), so events
 * are derived by comparing a small snapshot of the relevant fields before and
 * after each report. `PrinterConnection` emits every detected event as
 * `'event'`; print history and notifications subscribe to it.
 */

type Json = Record<string, any>;

export type GcodeState = 'IDLE' | 'PREPARE' | 'RUNNING' | 'PAUSE' | 'FINISH' | 'FAILED' | 'SLICING' | 'INIT' | 'OFFLINE';

/** Fields of the printer state that drive lifecycle events. */
export interface JobSnapshot {
  gcodeState: string | null;
  task: string | null;
  gcodeFile: string | null;
  percent: number | null;
  layer: number | null;
  totalLayers: number | null;
  remainingMinutes: number | null;
  printError: number;
  /** HMS alerts as `attr:code` keys. */
  hms: string[];
}

interface EventBase {
  /** Snapshot after the report that triggered the event. */
  job: JobSnapshot;
  at: number;
}

export type PrinterEvent = EventBase &
  (
    | {
        type: 'job_started';
        /**
         * true when the job was already in progress the first time this app saw
         * the printer (app restart, printer just added): history should adopt
         * it, notifications should stay quiet.
         */
        observedMidway: boolean;
      }
    | { type: 'job_paused'; printError: number }
    | { type: 'job_resumed' }
    | { type: 'job_finished' }
    | { type: 'job_failed'; printError: number }
    | { type: 'hms_raised'; alerts: { attr: number; code: number }[] }
  );

export type PrinterEventType = PrinterEvent['type'];

const ACTIVE = new Set(['PREPARE', 'RUNNING', 'PAUSE', 'SLICING']);
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function jobSnapshot(state: Json): JobSnapshot {
  const hms = Array.isArray(state.hms)
    ? state.hms
        .filter((h: Json) => typeof h?.attr === 'number' && typeof h?.code === 'number')
        .map((h: Json) => `${h.attr}:${h.code}`)
    : [];
  return {
    gcodeState: strOrNull(state.gcode_state),
    task: strOrNull(state.subtask_name) ?? strOrNull(state.gcode_file),
    gcodeFile: strOrNull(state.gcode_file),
    percent: numOrNull(state.mc_percent),
    layer: numOrNull(state.layer_num),
    totalLayers: numOrNull(state.total_layer_num),
    remainingMinutes: numOrNull(state.mc_remaining_time),
    printError: numOrNull(state.print_error) ?? 0,
    hms,
  };
}

/**
 * Compare two snapshots. `prev` is null for the first report after the app
 * started watching the printer (or after its state was reset).
 */
export function detectEvents(prev: JobSnapshot | null, next: JobSnapshot, at = Date.now()): PrinterEvent[] {
  const events: PrinterEvent[] = [];
  const base = { job: next, at };
  const from = prev?.gcodeState ?? null;
  const to = next.gcodeState;

  if (to && to !== from) {
    const wasActive = from !== null && ACTIVE.has(from);
    if (!prev || from === null) {
      // First sighting: adopt a job that is already underway.
      if (ACTIVE.has(to)) events.push({ ...base, type: 'job_started', observedMidway: true });
    } else if ((to === 'PREPARE' || to === 'RUNNING') && !wasActive) {
      events.push({ ...base, type: 'job_started', observedMidway: false });
    } else if (to === 'PAUSE' && wasActive) {
      events.push({ ...base, type: 'job_paused', printError: next.printError });
    } else if (to === 'RUNNING' && from === 'PAUSE') {
      events.push({ ...base, type: 'job_resumed' });
    } else if (to === 'FINISH' && wasActive) {
      events.push({ ...base, type: 'job_finished' });
    } else if (to === 'FAILED' && wasActive) {
      events.push({ ...base, type: 'job_failed', printError: next.printError });
    }
  } else if (prev && to && ACTIVE.has(to) && next.task && prev.task && next.task !== prev.task) {
    // A new job started without passing through an idle state in between.
    events.push({ ...base, type: 'job_started', observedMidway: false });
  }

  if (prev) {
    const known = new Set(prev.hms);
    const added = next.hms.filter((key) => !known.has(key));
    if (added.length) {
      events.push({
        ...base,
        type: 'hms_raised',
        alerts: added.map((key) => {
          const [attr, code] = key.split(':').map(Number);
          return { attr, code };
        }),
      });
    }
  }
  return events;
}
