import zlib from 'node:zlib';

/**
 * Minimal read-only ZIP reader for .3mf archives.
 *
 * Works on a random-access source so only the central directory and the few
 * entries we need are fetched (over FTPS that means ranged downloads instead
 * of pulling a whole, possibly huge, project file). Supports stored and
 * deflated entries and ZIP64 records; no encryption, no multi-disk archives.
 */

export interface RangeSource {
  size: number;
  read(start: number, length: number): Promise<Buffer>;
}

export interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;

export function bufferSource(buf: Buffer): RangeSource {
  return {
    size: buf.length,
    read: async (start, length) => buf.subarray(start, Math.min(buf.length, start + length)),
  };
}

async function readExact(src: RangeSource, start: number, length: number): Promise<Buffer> {
  if (start < 0 || length < 0 || start + length > src.size) throw new ZipError('Truncated ZIP archive');
  const buf = await src.read(start, length);
  if (buf.length < length) throw new ZipError('Truncated ZIP archive');
  return buf.length === length ? buf : buf.subarray(0, length);
}

/** Read the central directory. `maxDirectorySize` bounds memory for hostile archives. */
export async function readZipDirectory(
  src: RangeSource,
  maxDirectorySize = 4 * 1024 * 1024,
): Promise<Map<string, ZipEntry>> {
  if (src.size < 22) throw new ZipError('Not a ZIP archive');
  const tailLength = Math.min(src.size, 22 + MAX_COMMENT + 20);
  const tailStart = src.size - tailLength;
  const tail = await readExact(src, tailStart, tailLength);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a ZIP archive (no end of central directory)');

  let count = tail.readUInt16LE(eocd + 10);
  let dirSize = tail.readUInt32LE(eocd + 12);
  let dirOffset = tail.readUInt32LE(eocd + 16);

  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== ZIP64_LOCATOR_SIG) throw new ZipError('Missing ZIP64 locator');
    const z64Offset = Number(tail.readBigUInt64LE(loc + 8));
    const z64 = await readExact(src, z64Offset, 56);
    if (z64.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new ZipError('Bad ZIP64 end of central directory');
    count = Number(z64.readBigUInt64LE(32));
    dirSize = Number(z64.readBigUInt64LE(40));
    dirOffset = Number(z64.readBigUInt64LE(48));
  }

  if (dirSize > maxDirectorySize) throw new ZipError('ZIP central directory is too large');
  const dir =
    dirOffset >= tailStart && dirOffset + dirSize <= src.size
      ? tail.subarray(dirOffset - tailStart, dirOffset - tailStart + dirSize)
      : await readExact(src, dirOffset, dirSize);

  const entries = new Map<string, ZipEntry>();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== CENTRAL_SIG) throw new ZipError('Corrupt ZIP central directory');
    const flags = dir.readUInt16LE(p + 8);
    const method = dir.readUInt16LE(p + 10);
    const crc32 = dir.readUInt32LE(p + 16);
    let compressedSize = dir.readUInt32LE(p + 20);
    let size = dir.readUInt32LE(p + 24);
    const nameLen = dir.readUInt16LE(p + 28);
    const extraLen = dir.readUInt16LE(p + 30);
    const commentLen = dir.readUInt16LE(p + 32);
    let localHeaderOffset = dir.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > dir.length) throw new ZipError('Corrupt ZIP central directory');
    const name = dir.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);

    // ZIP64 extended information: only the fields saturated in the record are present, in this order.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = dir.readUInt16LE(e);
      const len = dir.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        const next = () => {
          if (q + 8 > e + 4 + len) throw new ZipError('Corrupt ZIP64 extra field');
          const v = Number(dir.readBigUInt64LE(q));
          q += 8;
          return v;
        };
        if (size === 0xffffffff) size = next();
        if (compressedSize === 0xffffffff) compressedSize = next();
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = next();
      }
      e += 4 + len;
    }

    if (!(flags & 0x1)) entries.set(name, { name, method, crc32, compressedSize, size, localHeaderOffset });
    p = end;
  }
  return entries;
}

/** Read and decompress one entry, refusing anything larger than `maxSize` bytes. */
export async function readZipEntry(src: RangeSource, entry: ZipEntry, maxSize: number): Promise<Buffer> {
  if (entry.size > maxSize || entry.compressedSize > maxSize) {
    throw new ZipError(`${entry.name} is too large (${entry.size} bytes)`);
  }
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError(`${entry.name}: unsupported compression`);

  const guess = Math.min(src.size - entry.localHeaderOffset, 30 + Buffer.byteLength(entry.name) + 256 + entry.compressedSize);
  let chunk = await readExact(src, entry.localHeaderOffset, guess);
  if (chunk.length < 30 || chunk.readUInt32LE(0) !== LOCAL_SIG) throw new ZipError(`${entry.name}: bad local header`);
  const dataStart = 30 + chunk.readUInt16LE(26) + chunk.readUInt16LE(28);
  const needed = dataStart + entry.compressedSize;
  if (needed > chunk.length) {
    const rest = await readExact(src, entry.localHeaderOffset + chunk.length, needed - chunk.length);
    chunk = Buffer.concat([chunk, rest]);
  }
  const raw = chunk.subarray(dataStart, needed);

  let data: Buffer;
  if (entry.method === 0) {
    data = Buffer.from(raw);
  } else {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, maxSize) });
    } catch (err) {
      throw new ZipError(`${entry.name}: ${(err as Error).message}`);
    }
  }
  if (data.length !== entry.size || zlib.crc32(data) !== entry.crc32) {
    throw new ZipError(`${entry.name}: checksum mismatch`);
  }
  return data;
}
