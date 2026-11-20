import { PROJECT_FILE, projectName } from '../../shared/files.ts';
import { jobPrinting, objectId, skippedIds } from '../../shared/printer.ts';
import { HttpError } from '../http-error.ts';
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
      const id = objectId(a.identify_id);
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
    let safe: string;
    try {
      safe = safeRemotePath(p);
    } catch {
      return; // a name that would escape the storage root is no candidate
    }
    if (PROJECT_FILE.test(safe) && !out.includes(safe)) out.push(safe);
  };
  const gcodeFile = typeof state.gcode_file === 'string' ? state.gcode_file.trim() : '';
  if (PROJECT_FILE.test(gcodeFile)) {
    const p = gcodeFile.replace(/^(?:ftp|file):\/\//i, '').replace(/^\/(?:mnt\/)?sdcard(?=\/)/i, '');
    add(p);
    // Some firmwares report a bare file name: it lives in /cache or at the root.
    if (!p.includes('/')) for (const dir of ['/cache', '']) add(`${dir}/${p}`);
  }
  const name = typeof state.subtask_name === 'string' ? state.subtask_name.trim() : '';
  if (name && !/[/\\]/.test(name) && name.length <= 200) {
    const base = projectName(name);
    for (const dir of ['/cache', '', '/model']) {
      for (const ext of ['.gcode.3mf', '.3mf']) add(`${dir}/${base}${ext}`);
    }
  }
  return out;
}


/** Identity of the current job, used as cache key (no FTPS round trip). */
function jobKey(state: Record<string, any>) {
  return JSON.stringify([state.subtask_name ?? '', state.gcode_file ?? '', state.task_id ?? '', state.subtask_id ?? '']);
}

/** Read the object list and plate images of the job described by `state`. */
export async function loadJob(store: JobFileStore, state: Record<string, any>): Promise<LoadedJob> {
  const candidates = candidatePaths(state);
  if (!candidates.length) throw new HttpError(404, 'The printer does not report which file it is printing');
  const found = await store.firstExisting(candidates);
  if (!found) {
    throw new HttpError(
      404,
      `Couldn't find the job's .3mf on the printer (tried ${candidates.join(', ')}). ` +
        'Skipping objects needs the sliced project file to still be on its storage.',
    );
  }
  if (found.size > MAX_ARCHIVE) throw new HttpError(413, 'The project file is too large');

  const src: RangeSource = { size: found.size, read: (start, length) => store.readRange(found.path, start, length) };
  try {
    const entries = await readZipDirectory(src);
    const sliceInfo = entries.get('Metadata/slice_info.config');
    if (!sliceInfo) throw new HttpError(422, `${found.path} is not a sliced project (no slice_info.config)`);
    const plates = parseSliceInfo((await readZipEntry(src, sliceInfo, MAX_SLICE_INFO)).toString('utf8'));
    if (!plates.length) throw new HttpError(422, `${found.path} contains no sliced plate`);

    // The printer reports the plate it prints; exported single-plate files keep the original number.
    const wanted = plateFromGcodeFile(state.gcode_file);
    const plate = plates.find((p) => p.index === wanted) ?? (plates.length === 1 || wanted === null ? plates[0] : null);
    if (!plate) throw new HttpError(422, `Plate ${wanted} not found in ${found.path}`);
    if (!plate.objects.length) throw new HttpError(422, 'This plate has no objects that can be skipped');

    const image = async (name: string) => {
      const entry = entries.get(name);
      if (!entry) return null;
      try {
        return await readZipEntry(src, entry, MAX_IMAGE);
      } catch (err) {
        if (err instanceof ZipError) return null;
        throw err;
      }
    };
    const plateImage = await image(`Metadata/plate_${plate.index}.png`);
    const pickImage = await image(`Metadata/pick_${plate.index}.png`);
    return { key: jobKey(state), path: found.path, plate: plate.index, objects: plate.objects, plateImage, pickImage };
  } catch (err) {
    if (err instanceof ZipError) throw new HttpError(422, `${found.path}: ${err.message}`);
    throw err;
  }
}

/**
 * Cache of a printer's parsed job (a few KB of XML-derived data plus two small
 * PNGs). Concurrent requests share one load; a different job replaces it.
 */
export class JobObjectsCache {
  private entry: { key: string; job?: LoadedJob; pending?: Promise<LoadedJob> } | null = null;
  private store: JobFileStore;

  constructor(store: JobFileStore) {
    this.store = store;
  }

  /** Cached objects of the current job, or null if not loaded (sync, for command validation). */
  peek(state: Record<string, any>): LoadedJob | null {
    return this.entry?.job && this.entry.key === jobKey(state) ? this.entry.job : null;
  }

  get(state: Record<string, any>, refresh = false): Promise<LoadedJob> {
    const key = jobKey(state);
    if (!jobPrinting(state.gcode_state)) {
      this.entry = null;
      return Promise.reject(new HttpError(409, 'No print is running'));
    }
    if (this.entry && this.entry.key === key && !refresh) {
      if (this.entry.job) return Promise.resolve(this.entry.job);
      if (this.entry.pending) return this.entry.pending;
    }
    const pending = loadJob(this.store, state);
    const slot = { key, pending };
    this.entry = slot;
    pending.then(
      (job) => {
        if (this.entry === slot) this.entry = { key, job };
      },
      () => {
        if (this.entry === slot) this.entry = null;
      },
    );
    return pending;
  }
}

/**
 * Ids to send in `skip_objects`: a print must be in progress and, when the
 * job's object list is known, the ids must come from it. Duplicates and
 * already-skipped ids are dropped.
 */
export function skippableIds(requested: number[], state: Record<string, any>, known: JobObject[] | null): number[] {
  if (!jobPrinting(state.gcode_state)) {
    throw new HttpError(400, 'Objects can only be skipped while a print is running or paused');
  }
  const ids = [...new Set(requested)];
  if (known) {
    const valid = new Set(known.map((o) => o.id));
    const unknown = ids.find((id) => !valid.has(id));
    if (unknown !== undefined) throw new HttpError(400, `Object ${unknown} is not part of the current print`);
  }
  const already = new Set(skippedIds(state));
  const fresh = ids.filter((id) => !already.has(id));
  if (!fresh.length) throw new HttpError(400, 'These objects are already skipped');
  return fresh;
}

/** Audit detail: ids with their names when the object list is known. */
export function describeSkipped(ids: number[], known: JobObject[] | null) {
  const names = new Map((known ?? []).map((o) => [o.id, o.name]));
  return ids.map((id) => ({ id, name: names.get(id) ?? null }));
}
