/**
 * Generates a small sliced-project .3mf for the fake printer and the tests:
 * a slice_info.config with two plates, plus a plate thumbnail and a pick map
 * for plate 1 (flat colors encoding each object's identify_id).
 */
import zlib from 'node:zlib';

/** Pick-map color of an object: identify_id as little-endian RGB (R = low byte). */
export const pickColor = (id: number): [number, number, number] => [id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff];

/** Minimal ZIP writer (deflate, or stored with `store`). */
export function buildZip(files: { name: string; data: Buffer; store?: boolean }[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const body = f.store ? f.data : zlib.deflateRawSync(f.data);
    const crc = zlib.crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(f.store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(f.store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const commentBuf = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);
  return Buffer.concat([...locals, dir, eocd, commentBuf]);
}

/** Encode an RGBA image as PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const SAMPLE_OBJECTS = [
  { id: 79, name: 'Cube', color: [229, 87, 46] },
  { id: 296, name: 'Benchy <v2> & "friends"', color: [61, 139, 253] },
  { id: 513, name: 'Tête à 3 pieds', color: [25, 178, 107] },
  { id: 70000, name: 'Clip', color: [240, 165, 49] },
] as const;

const SIZE = 256;

/** Draw the four sample objects as squares in a 2×2 grid. */
function drawPlate(fill: (id: number, color: readonly number[]) => readonly number[], background: readonly number[]) {
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const cell = (y >= 128 ? 2 : 0) + (x >= 128 ? 1 : 0);
      const inside = x % 128 >= 24 && x % 128 < 104 && y % 128 >= 24 && y % 128 < 104;
      const o = SAMPLE_OBJECTS[cell];
      const c = inside ? fill(o.id, o.color) : background;
      rgba.set([c[0], c[1], c[2], c[3] ?? 255], (y * SIZE + x) * 4);
    }
  }
  return encodePng(SIZE, SIZE, rgba);
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function sampleSliceInfo() {
  const objects = SAMPLE_OBJECTS.map(
    (o) => `    <object identify_id="${o.id}" name="${xmlEscape(o.name)}" skipped="false" />`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="02.00.00.00"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="5400"/>
${objects}
    <filament id="1" type="PLA" color="#FFFFFF" used_m="3.2" used_g="9.6" />
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <object identify_id="1201" name="Other plate part" skipped="false" />
  </plate>
</config>
`;
}

/** The complete sample project, as Bambu Studio would send it to a printer. */
export function buildSample3mf(): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types/>') },
    { name: 'Metadata/slice_info.config', data: Buffer.from(sampleSliceInfo()) },
    { name: 'Metadata/plate_1.png', data: drawPlate((_id, color) => color, [40, 44, 50, 255]), store: true },
    { name: 'Metadata/pick_1.png', data: drawPlate((id) => pickColor(id), [0, 0, 0, 0]) },
    { name: 'Metadata/plate_1.gcode', data: Buffer.from('; sample\nG28\n'.repeat(200)) },
  ]);
}
