import * as cmd from './commands.ts';
import { safeRemotePath } from './ftps.ts';
import { readZipDirectory, readZipEntry, ZipError, type RangeSource } from './zip.ts';

/**
 * Skip objects: the object list of the running job, read from its .3mf.
 *
 * `Metadata/slice_info.config` lists, per sliced plate, every object with the
 * `identify_id` the printer expects in `skip_objects`. `Metadata/plate_N.png`
 * is the plate thumbnail and `Metadata/pick_N.png` a same-size "pick map"
 * where each object is painted in a flat color encoding its identify_id
 * (decoded in the browser, see web/src/lib/skip-objects.ts).
 */

export interface JobObject {
  id: number;
  name: string;
}

export interface SlicedPlate {
  index: number;
  objects: JobObject[];
}

/** Where to look for the job's files on the printer (FTPS in production, fakes in tests). */
export interface JobFileStore {
  firstExisting(paths: string[]): Promise<{ path: string; size: number } | null>;
  readRange(path: string, start: number, length: number): Promise<Buffer>;
}

export interface LoadedJob {
  key: string;
  path: string;
  plate: number;
  objects: JobObject[];
  plateImage: Buffer | null;
  pickImage: Buffer | null;
}

export class JobObjectsError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const MAX_SKIP_IDS = 256;
const MAX_OBJECTS = 2000;
const MAX_SLICE_INFO = 2 * 1024 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;
/** Refuse absurd files outright: the archive is read by range, never downloaded whole. */
const MAX_ARCHIVE = 2 * 1024 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]] = decodeXmlEntities(m[2] ?? m[3] ?? '');
  }
  return out;
}

const positiveId = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n <= 0x7fffffff ? n : null;
};

/** Parse `Metadata/slice_info.config` (Bambu Studio / OrcaSlicer). */
export function parseSliceInfo(xml: string): SlicedPlate[] {
  const plates: SlicedPlate[] = [];
  // Strip comments until none are left (a single pass can leave nested fragments like "<!<!---->--").
  let body = xml;
  for (let prev = ''; prev !== body; ) {
    prev = body;
    body = body.replace(/<!--[\s\S]*?-->/g, '');
  }
  for (const m of body.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)) {
    const inner = m[1];
    let index = NaN;
    for (const meta of inner.matchAll(/<metadata\b([^>]*?)\/?>/g)) {
      const a = attributes(meta[1]);
      if (a.key === 'index') index = Number(a.value);
    }
    const objects: JobObject[] = [];
    const seen = new Set<number>();
    for (const obj of inner.matchAll(/<object\b([^>]*?)\/?>/g)) {
      const a = attributes(obj[1]);
      const id = positiveId(a.identify_id);
      if (id === null || seen.has(id) || objects.length >= MAX_OBJECTS) continue;
      seen.add(id);
      objects.push({ id, name: (a.name ?? '').trim().slice(0, 200) || `Object ${id}` });
    }
    plates.push({ index: Number.isInteger(index) && index > 0 ? index : plates.length + 1, objects });
  }
  return plates;
}

/** Plate number from `gcode_file` / `param`, e.g. "/data/Metadata/plate_2.gcode". */
export function plateFromGcodeFile(gcodeFile: unknown): number | null {
  const m = /plate_(\d{1,3})\.gcode$/i.exec(typeof gcodeFile === 'string' ? gcodeFile : '');
  return m ? Number(m[1]) : null;
}

/**
 * Candidate locations of the running job's .3mf on the printer's storage.
 * `gcode_file` holds the archive path for some prints ("/sdcard/cache/x.3mf",
 * "ftp:///x.3mf"); otherwise the file is named after `subtask_name` — Bambu
 * Studio / Handy put it in /cache as `<name>.gcode.3mf`, this app prints from
 * wherever the user browsed (usually / or /cache).
 */
export function candidatePaths(state: Record<string, any>): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    try {
      const safe = safeRemotePath(p);
      if (/\.3mf$/i.test(safe) && !out.includes(safe)) out.push(safe);
    } catch {
      // ignore unsafe names
    }
  };
  const gcodeFile = typeof state.gcode_file === 'string' ? state.gcode_file.trim() : '';
  if (/\.3mf$/i.test(gcodeFile)) {
    const p = gcodeFile.replace(/^(?:ftp|file):\/\//i, '').replace(/^\/(?:mnt\/)?sdcard(?=\/)/i, '');
    add(p);
    // Some firmwares report a bare file name: it lives in /cache or at the root.
    if (!p.includes('/')) for (const dir of ['/cache', '']) add(`${dir}/${p}`);
  }
  const name = typeof state.subtask_name === 'string' ? state.subtask_name.trim() : '';
  if (name && !/[/\\]/.test(name) && name.length <= 200) {
    const base = name.replace(/(\.gcode)?\.3mf$/i, '');
    for (const dir of ['/cache', '', '/model']) {
      for (const ext of ['.gcode.3mf', '.3mf']) add(`${dir}/${base}${ext}`);
    }
  }
  return out;
}

/** Object ids the printer already skipped (`s_obj` in push_status). */
export function skippedIds(state: Record<string, any>): number[] {
  return Array.isArray(state.s_obj) ? state.s_obj.map(positiveId).filter((n): n is number => n !== null) : [];
}

/** Identity of the current job, used as cache key (no FTPS round trip). */
export function jobKey(state: Record<string, any>) {
  return JSON.stringify([state.subtask_name ?? '', state.gcode_file ?? '', state.task_id ?? '', state.subtask_id ?? '']);
}

const ACTIVE = new Set(['RUNNING', 'PAUSE']);

export function isSkippable(state: Record<string, any>) {
  return ACTIVE.has(state.gcode_state);
}

/** Read the object list and plate images of the job described by `state`. */
export async function loadJob(store: JobFileStore, state: Record<string, any>): Promise<LoadedJob> {
  if (!isSkippable(state)) throw new JobObjectsError(409, 'No print is running');
  const candidates = candidatePaths(state);
  if (!candidates.length) throw new JobObjectsError(404, 'The printer does not report which file it is printing');
  const found = await store.firstExisting(candidates);
  if (!found) {
    throw new JobObjectsError(
      404,
      `Couldn't find the job's .3mf on the printer (tried ${candidates.join(', ')}). ` +
        'Skipping objects needs the sliced project file to still be on its storage.',
    );
  }
  if (found.size > MAX_ARCHIVE) throw new JobObjectsError(413, 'The project file is too large');

  const src: RangeSource = { size: found.size, read: (start, length) => store.readRange(found.path, start, length) };
  try {
    const entries = await readZipDirectory(src);
    const sliceInfo = entries.get('Metadata/slice_info.config');
    if (!sliceInfo) throw new JobObjectsError(422, `${found.path} is not a sliced project (no slice_info.config)`);
    const plates = parseSliceInfo((await readZipEntry(src, sliceInfo, MAX_SLICE_INFO)).toString('utf8'));
    if (!plates.length) throw new JobObjectsError(422, `${found.path} contains no sliced plate`);

    // The printer reports the plate it prints; exported single-plate files keep the original number.
    const wanted = plateFromGcodeFile(state.gcode_file);
    const plate = plates.find((p) => p.index === wanted) ?? (plates.length === 1 || wanted === null ? plates[0] : null);
    if (!plate) throw new JobObjectsError(422, `Plate ${wanted} not found in ${found.path}`);
    if (!plate.objects.length) throw new JobObjectsError(422, 'This plate has no objects that can be skipped');

    const image = async (name: string) => {
      const entry = entries.get(name);
      if (!entry) return null;
      try {
        return await readZipEntry(src, entry, MAX_IMAGE);
      } catch (err) {
        if (err instanceof ZipError) return null; // the list still works without images
        throw err;
      }
    };
    const plateImage = await image(`Metadata/plate_${plate.index}.png`);
    const pickImage = await image(`Metadata/pick_${plate.index}.png`);
    return { key: jobKey(state), path: found.path, plate: plate.index, objects: plate.objects, plateImage, pickImage };
  } catch (err) {
    if (err instanceof ZipError) throw new JobObjectsError(422, `${found.path}: ${err.message}`);
    throw err;
  }
}

/**
 * Per-printer cache of the parsed job (a few KB of XML-derived data plus two
 * small PNGs). Concurrent requests share one load; a different job replaces it.
 */
export class JobObjectsCache {
  private entries = new Map<number, { key: string; job?: LoadedJob; pending?: Promise<LoadedJob> }>();

  /** Cached objects of the current job, or null if not loaded (sync, for command validation). */
  peek(printerId: number, state: Record<string, any>): LoadedJob | null {
    const entry = this.entries.get(printerId);
    return entry?.job && entry.key === jobKey(state) ? entry.job : null;
  }

  get(printerId: number, store: JobFileStore, state: Record<string, any>, refresh = false): Promise<LoadedJob> {
    const key = jobKey(state);
    if (!isSkippable(state)) {
      this.entries.delete(printerId);
      return Promise.reject(new JobObjectsError(409, 'No print is running'));
    }
    const entry = this.entries.get(printerId);
    if (entry && entry.key === key && !refresh) {
      if (entry.job) return Promise.resolve(entry.job);
      if (entry.pending) return entry.pending;
    }
    const pending = loadJob(store, state);
    const slot: { key: string; job?: LoadedJob; pending?: Promise<LoadedJob> } = { key, pending };
    this.entries.set(printerId, slot);
    pending.then(
      (job) => {
        if (this.entries.get(printerId) === slot) this.entries.set(printerId, { key, job });
      },
      () => {
        if (this.entries.get(printerId) === slot) this.entries.delete(printerId);
      },
    );
    return pending;
  }

  delete(printerId: number) {
    this.entries.delete(printerId);
  }
}

export const jobObjects = new JobObjectsCache();

/**
 * Validate a skip request: 1..MAX_SKIP_IDS positive integer ids, a print in
 * progress, and — when the job's object list is known — ids from that list.
 * Already-skipped ids are dropped; returns the `skip_objects` command.
 */
export function buildSkipCommand(rawIds: unknown, state: Record<string, any>, known: JobObject[] | null): cmd.Command {
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > MAX_SKIP_IDS) {
    throw new RangeError(`ids must be a list of 1 to ${MAX_SKIP_IDS} object ids`);
  }
  const ids: number[] = [];
  for (const raw of rawIds) {
    const id = typeof raw === 'number' ? positiveId(raw) : null;
    if (id === null) throw new RangeError('Object ids must be positive integers');
    if (!ids.includes(id)) ids.push(id);
  }
  if (!isSkippable(state)) throw new RangeError('Objects can only be skipped while a print is running or paused');
  if (known) {
    const valid = new Set(known.map((o) => o.id));
    const unknown = ids.find((id) => !valid.has(id));
    if (unknown !== undefined) throw new RangeError(`Object ${unknown} is not part of the current print`);
  }
  const already = new Set(skippedIds(state));
  const fresh = ids.filter((id) => !already.has(id));
  if (!fresh.length) throw new RangeError('These objects are already skipped');
  return cmd.skipObjects(fresh);
}

/** Audit detail: ids with their names when the object list is known. */
export function describeSkipped(ids: number[], known: JobObject[] | null) {
  const names = new Map((known ?? []).map((o) => [o.id, o.name]));
  return ids.map((id) => ({ id, name: names.get(id) ?? null }));
}
