import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  JobObjectsCache,
  candidatePaths,
  decodeXmlEntities,
  describeSkipped,
  skippableIds,
  loadJob,
  parseSliceInfo,
  plateFromGcodeFile,
  type JobFileStore,
} from '../server/bambu/job-objects.ts';
import { bufferSource, readZipDirectory, readZipEntry, type RangeSource } from '../server/bambu/zip.ts';
import { SAMPLE_OBJECTS, buildSample3mf, buildZip, pickColor, sampleSliceInfo } from '../scripts/sample-3mf.ts';
import { decodePickMap, objectAt, pickColorToId, skipReplyError } from '../web/src/lib/skip-objects.ts';

const running = { gcode_state: 'RUNNING', subtask_name: 'Benchy', gcode_file: '/data/Metadata/plate_1.gcode' };

/** In-memory printer storage that counts the bytes it serves. */
function memoryStore(files: Record<string, Buffer>): JobFileStore & { bytesRead: number; lookups: string[][] } {
  const store = {
    bytesRead: 0,
    lookups: [] as string[][],
    async firstExisting(paths: string[]) {
      store.lookups.push(paths);
      const path = paths.find((p) => files[p]);
      return path ? { path, size: files[path].length } : null;
    },
    async readRange(path: string, start: number, length: number) {
      const buf = files[path].subarray(start, start + length);
      store.bytesRead += buf.length;
      return buf;
    },
  };
  return store;
}

describe('ZIP reader', () => {
  it('lists entries and reads stored and deflated data', async () => {
    const big = Buffer.from('hello 3mf '.repeat(1000));
    const zip = buildZip(
      [
        { name: 'a.txt', data: big },
        { name: 'dir/b.bin', data: Buffer.from([1, 2, 3]), store: true },
        { name: 'ünï.txt', data: Buffer.alloc(0) },
      ],
      'archive comment',
    );
    const src = bufferSource(zip);
    const entries = await readZipDirectory(src);
    assert.deepEqual([...entries.keys()], ['a.txt', 'dir/b.bin', 'ünï.txt']);
    assert.ok(entries.get('a.txt')!.compressedSize < big.length);
    assert.deepEqual(await readZipEntry(src, entries.get('a.txt')!, 1e6), big);
    assert.deepEqual(await readZipEntry(src, entries.get('dir/b.bin')!, 10), Buffer.from([1, 2, 3]));
    assert.equal((await readZipEntry(src, entries.get('ünï.txt')!, 10)).length, 0);
  });

  it('reads only the directory and the requested entry', async () => {
    const huge = Buffer.alloc(3 * 1024 * 1024, 7);
    const zip = buildZip([
      { name: 'big.gcode', data: huge, store: true },
      { name: 'small.txt', data: Buffer.from('x') },
    ]);
    let read = 0;
    const src: RangeSource = {
      size: zip.length,
      read: async (start, length) => {
        read += length;
        return zip.subarray(start, start + length);
      },
    };
    const entries = await readZipDirectory(src);
    assert.equal((await readZipEntry(src, entries.get('small.txt')!, 100)).toString(), 'x');
    assert.ok(read < 200_000, `read ${read} bytes`);
  });

  it('refuses entries above the size cap', async () => {
    const src = bufferSource(buildZip([{ name: 'a', data: Buffer.alloc(5000) }]));
    const entries = await readZipDirectory(src);
    await assert.rejects(readZipEntry(src, entries.get('a')!, 1000), /too large/);
  });

  it('detects corruption and non-ZIP input', async () => {
    await assert.rejects(readZipDirectory(bufferSource(Buffer.from('not a zip at all, definitely not'))), /Not a ZIP/);
    await assert.rejects(readZipDirectory(bufferSource(Buffer.alloc(5))), /Not a ZIP/);
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('payload!'), store: true }]);
    zip[30 + 'a.txt'.length] ^= 0xff; // flip a data byte
    const src = bufferSource(zip);
    await assert.rejects(readZipEntry(src, (await readZipDirectory(src)).get('a.txt')!, 100), /checksum/);
  });

  it('follows ZIP64 records', async () => {
    const zip = buildZip([{ name: 'z.txt', data: Buffer.from('zip64'), store: true }]);
    // Rewrite the end record as ZIP64: saturated EOCD + locator + ZIP64 EOCD.
    const eocdAt = zip.length - 22;
    const dirSize = zip.readUInt32LE(eocdAt + 12);
    const dirOffset = zip.readUInt32LE(eocdAt + 16);
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(dirSize), 40);
    z64.writeBigUInt64LE(BigInt(dirOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(eocdAt), 8);
    const eocd = Buffer.from(zip.subarray(eocdAt));
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    const src = bufferSource(Buffer.concat([zip.subarray(0, eocdAt), z64, locator, eocd]));
    const entries = await readZipDirectory(src);
    assert.equal((await readZipEntry(src, entries.get('z.txt')!, 100)).toString(), 'zip64');
  });
});

describe('slice_info.config parsing', () => {
  it('reads every plate with its objects, decoding XML entities', () => {
    const plates = parseSliceInfo(sampleSliceInfo());
    assert.deepEqual(
      plates.map((p) => p.index),
      [1, 2],
    );
    assert.deepEqual(
      plates[0].objects,
      SAMPLE_OBJECTS.map((o) => ({ id: o.id, name: o.name })),
    );
    assert.equal(plates[0].objects[1].name, 'Benchy <v2> & "friends"');
    assert.deepEqual(plates[1].objects, [{ id: 1201, name: 'Other plate part' }]);
  });

  it('handles numeric references, single quotes, bad and duplicate ids', () => {
    const xml = `<config><plate><metadata value="3" key="index"/>
      <object identify_id='12' name='A&#x26;B &#233;t&#233;' skipped="false"/>
      <object identify_id="12" name="dupe"/>
      <object identify_id="-4" name="negative"/>
      <object identify_id="abc" name="nan"/>
      <!-- <object identify_id="99" name="commented out"/> -->
      <object identify_id="13"/>
    </plate></config>`;
    const [plate] = parseSliceInfo(xml);
    assert.equal(plate.index, 3);
    assert.deepEqual(plate.objects, [
      { id: 12, name: 'A&B été' },
      { id: 13, name: 'Object 13' },
    ]);
  });

  it('decodes entities without double-unescaping', () => {
    assert.equal(decodeXmlEntities('&amp;lt; &lt;&gt;&quot;&apos; &#65;&#x42; &bogus;'), `&lt; <>"' AB &bogus;`);
  });
});

describe('locating the job file', () => {
  it('finds the plate number in gcode_file', () => {
    assert.equal(plateFromGcodeFile('/data/Metadata/plate_2.gcode'), 2);
    assert.equal(plateFromGcodeFile('Metadata/plate_11.gcode'), 11);
    assert.equal(plateFromGcodeFile('foo.gcode.3mf'), null);
    assert.equal(plateFromGcodeFile(undefined), null);
  });

  it('tries the archive path, then names derived from subtask_name', () => {
    assert.deepEqual(candidatePaths({ gcode_file: 'file:///sdcard/cache/Part.gcode.3mf', subtask_name: 'Part' }), [
      '/cache/Part.gcode.3mf',
      '/cache/Part.3mf',
      '/Part.gcode.3mf',
      '/Part.3mf',
      '/model/Part.gcode.3mf',
      '/model/Part.3mf',
    ]);
    assert.deepEqual(candidatePaths({ gcode_file: 'Bare.3mf' }), ['/Bare.3mf', '/cache/Bare.3mf']);
    assert.deepEqual(candidatePaths({ gcode_file: 'ftp:///x.3mf' }), ['/x.3mf']);
  });

  it('never produces unsafe paths', () => {
    assert.deepEqual(candidatePaths({ gcode_file: '/sdcard/../../etc/x.3mf', subtask_name: '../evil' }), []);
    assert.deepEqual(candidatePaths({ subtask_name: 'a/b' }), []);
  });
});

describe('loading the job objects', () => {
  const sample = buildSample3mf();

  it('returns the printed plate, its objects and images', async () => {
    const store = memoryStore({ '/cache/Benchy.gcode.3mf': sample });
    const job = await loadJob(store, running);
    assert.equal(job.path, '/cache/Benchy.gcode.3mf');
    assert.equal(job.plate, 1);
    assert.equal(job.objects.length, 4);
    assert.ok(job.plateImage?.subarray(1, 4).equals(Buffer.from('PNG')));
    assert.ok(job.pickImage?.subarray(1, 4).equals(Buffer.from('PNG')));
  });

  it('uses the plate from gcode_file', async () => {
    const store = memoryStore({ '/Benchy.3mf': sample });
    const job = await loadJob(store, { ...running, gcode_file: 'Metadata/plate_2.gcode' });
    assert.equal(job.plate, 2);
    assert.deepEqual(job.objects, [{ id: 1201, name: 'Other plate part' }]);
    assert.equal(job.plateImage, null);
    assert.equal(job.pickImage, null);
  });

  it('explains what went wrong', async () => {
    const store = memoryStore({ '/cache/Benchy.gcode.3mf': sample });
    await assert.rejects(loadJob(store, { gcode_state: 'RUNNING' }), { statusCode: 404 });
    await assert.rejects(loadJob(store, { ...running, subtask_name: 'Other' }), (err: any) => {
      assert.equal(err.statusCode, 404);
      assert.match(err.message, /tried \/cache\/Other\.gcode\.3mf, /);
      return true;
    });
    await assert.rejects(loadJob(store, { ...running, gcode_file: 'Metadata/plate_7.gcode' }), {
      statusCode: 422,
      message: /Plate 7 not found/,
    });
    const notSliced = memoryStore({ '/cache/Benchy.gcode.3mf': buildZip([{ name: '3D/3dmodel.model', data: Buffer.from('x') }]) });
    await assert.rejects(loadJob(notSliced, running), { statusCode: 422, message: /not a sliced project/ });
    const garbage = memoryStore({ '/cache/Benchy.gcode.3mf': Buffer.from('garbage'.repeat(10)) });
    await assert.rejects(loadJob(garbage, running), { statusCode: 422 });
  });

  it('caches per job, sharing concurrent loads', async () => {
    const store = memoryStore({ '/cache/Benchy.gcode.3mf': sample });
    const cache = new JobObjectsCache(store);
    const [a, b] = await Promise.all([cache.get(running), cache.get(running)]);
    assert.equal(a, b);
    assert.equal(store.lookups.length, 1);
    assert.equal(await cache.get(running), a);
    assert.equal(cache.peek(running), a);
    assert.equal(cache.peek({ ...running, subtask_name: 'Other' }), null);
    await cache.get(running, true);
    assert.equal(store.lookups.length, 2);
    await assert.rejects(cache.get({ ...running, gcode_state: 'FINISH' }), { statusCode: 409 });
    assert.equal(cache.peek(running), null);
  });
});

describe('skip_objects command validation', () => {
  const known = SAMPLE_OBJECTS.map((o) => ({ id: o.id, name: o.name }));

  it('keeps each requested id once', () => {
    assert.deepEqual(skippableIds([296, 79, 296], running, known), [296, 79]);
  });

  it('accepts any positive ids when the object list is unknown', () => {
    assert.deepEqual(skippableIds([5], { ...running, gcode_state: 'PAUSE' }, null), [5]);
  });

  it('drops already skipped ids', () => {
    assert.deepEqual(skippableIds([79, 296], { ...running, s_obj: [79] }, known), [296]);
    assert.throws(() => skippableIds([79], { ...running, s_obj: [79] }, known), /already skipped/);
  });

  it('rejects ids outside the print, or no print running', () => {
    assert.throws(() => skippableIds([12345], running, known), /not part of the current print/);
    assert.throws(() => skippableIds([79], { ...running, gcode_state: 'IDLE' }, known), /running or paused/);
  });

  it('names skipped objects for the audit log', () => {
    assert.deepEqual(describeSkipped([79, 5], known), [
      { id: 79, name: 'Cube' },
      { id: 5, name: null },
    ]);
  });
});

describe('pick map decoding', () => {
  const known = new Set(SAMPLE_OBJECTS.map((o) => o.id));

  it('decodes identify_id from little-endian RGB', () => {
    for (const o of SAMPLE_OBJECTS) {
      const [r, g, b] = pickColor(o.id);
      assert.equal(pickColorToId(r, g, b, 255, known), o.id);
    }
    assert.equal(pickColor(70000).join(), '112,17,1');
  });

  it('accepts the reversed byte order and ignores background or blended pixels', () => {
    const [r, g, b] = pickColor(70000);
    assert.equal(pickColorToId(b, g, r, 255, known), 70000);
    assert.equal(pickColorToId(0, 0, 0, 255, known), null);
    assert.equal(pickColorToId(r, g, b, 0, known), null);
    assert.equal(pickColorToId(r + 1, g, b, 255, known), null);
  });

  it('maps pixels to objects and snaps taps to the nearest object', () => {
    // 4×2 image: [79, 79, bg, bg] / [bg, bg, bg, 296]
    const px = (id: number | null) => (id === null ? [0, 0, 0, 0] : [...pickColor(id), 255]);
    const rgba = [79, 79, null, null, null, null, null, 296].flatMap(px);
    const ids = decodePickMap(rgba, known);
    assert.deepEqual([...ids], [79, 79, 0, 0, 0, 0, 0, 296]);
    assert.equal(objectAt(ids, 4, 0.5, 0.5), 79);
    assert.equal(objectAt(ids, 4, 2, 0), null);
    assert.equal(objectAt(ids, 4, 2, 0, 1), 79);
    assert.equal(objectAt(ids, 4, 3, 0, 1), 296);
    assert.equal(objectAt(ids, 4, 9, 9, 1), null);
  });

  it('reports printer rejections of skip_objects', () => {
    const entry = (print: object, direction: 'in' | 'out' = 'in') => ({ at: 1, direction, command: 'skip_objects', payload: { print } });
    assert.equal(skipReplyError(entry({ result: 'success' })), null);
    assert.equal(skipReplyError(entry({ result: 'fail', reason: 'not supported' })), 'not supported');
    assert.equal(skipReplyError(entry({ result: 'failed' })), 'failed');
    assert.equal(skipReplyError(entry({ result: 'fail' }, 'out')), null);
  });
});
