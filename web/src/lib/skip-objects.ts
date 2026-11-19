/**
 * Pick map decoding for "skip objects".
 *
 * `Metadata/pick_N.png` in a sliced .3mf paints every object of plate N in a
 * flat color that encodes its `identify_id` as little-endian RGB:
 * id = R + G·256 + B·65536 (the picking color encoding of Bambu Studio /
 * PrusaSlicer). Background pixels are transparent or black (id 0, never a
 * valid object). Edge pixels may be blended, so colors that don't decode to
 * a known id are ignored; the reverse byte order is accepted as a fallback.
 */

export interface JobObject {
  id: number;
  name: string;
  skipped: boolean;
}

export interface JobObjects {
  file: string;
  plate: number;
  objects: JobObject[];
  hasPlateImage: boolean;
  hasPickMap: boolean;
}

export function pickColorToId(r: number, g: number, b: number, a: number, known: Set<number>): number | null {
  if (a < 128) return null;
  const id = r + g * 256 + b * 65536;
  if (known.has(id)) return id;
  const swapped = b + g * 256 + r * 65536;
  if (known.has(swapped)) return swapped;
  return null;
}

/** Object id for every pixel of the pick map (0 = none). */
export function decodePickMap(rgba: ArrayLike<number>, known: Set<number>): Int32Array {
  const ids = new Int32Array(rgba.length / 4);
  const memo = new Map<number, number>();
  for (let i = 0; i < ids.length; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 128) continue;
    const key = rgba[o] | (rgba[o + 1] << 8) | (rgba[o + 2] << 16);
    let id = memo.get(key);
    if (id === undefined) {
      id = pickColorToId(rgba[o], rgba[o + 1], rgba[o + 2], 255, known) ?? 0;
      memo.set(key, id);
    }
    ids[i] = id;
  }
  return ids;
}

/**
 * Object at (x, y), or the nearest one within `radius` pixels — fingers are
 * less precise than a mouse and small parts are only a few pixels wide.
 */
export function objectAt(ids: Int32Array, width: number, x: number, y: number, radius = 0): number | null {
  const height = ids.length / width;
  const at = (px: number, py: number) => (px >= 0 && py >= 0 && px < width && py < height ? ids[py * width + px] : 0);
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (at(cx, cy)) return at(cx, cy);
  let best: number | null = null;
  let bestDist = Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d = dx * dx + dy * dy;
      const id = at(cx + dx, cy + dy);
      if (id && d <= radius * radius && d < bestDist) {
        best = id;
        bestDist = d;
      }
    }
  }
  return best;
}

/** Error reported by the printer for a skip_objects command (from the command log), if any. */
export function skipReplyError(entry: { direction: string; command: string; payload: unknown }): string | null {
  if (entry.direction !== 'in' || entry.command !== 'skip_objects') return null;
  const reply = (entry.payload as { print?: { result?: unknown; reason?: unknown } })?.print;
  const result = String(reply?.result ?? '').toLowerCase();
  if (!result || result === 'success') return null;
  return String(reply?.reason || reply?.result);
}
