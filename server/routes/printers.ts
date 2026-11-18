import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth } from '../auth.ts';
import * as cmd from '../bambu/commands.ts';
import { safeRemotePath } from '../bambu/ftps.ts';
import { MODELS, cameraKindFor, printUrlFor, supportsChamberControl } from '../bambu/models.ts';
import { testConnection } from '../bambu/printer.ts';
import { discoverPrinters } from '../bambu/ssdp.ts';
import { config } from '../config.ts';
import type { CameraSetting, PrinterRow } from '../db.ts';
import { manager, type ManagedPrinter } from '../manager.ts';

type PrinterInput = Omit<PrinterRow, 'id' | 'created_at'>;

/** Formats browsers play natively (served as-is with Range support). */
const MEDIA_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

/** Formats converted to MP4 by ffmpeg while streaming. */
const TRANSCODE_EXTENSIONS = new Set(['avi', 'mkv']);

function parsePrinterInput(body: any, existing?: PrinterRow): PrinterInput | string {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = str(body?.name);
  const model = str(body?.model);
  const serial = str(body?.serial).toUpperCase();
  const ip = str(body?.ip);
  // Leave the access code unchanged on edit when the field is left blank.
  const accessCode = str(body?.accessCode) || existing?.access_code || '';
  const camera = (str(body?.camera) || 'auto') as CameraSetting;

  if (!name || name.length > 64) return 'Name is required (max 64 characters)';
  if (!model) return 'Model is required';
  if (!/^[A-Z0-9]{6,32}$/.test(serial)) return 'Serial number looks invalid';
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(ip)) return 'IP address / hostname looks invalid';
  if (!/^[A-Za-z0-9]{4,32}$/.test(accessCode)) return 'Access code looks invalid (8 characters, shown on the printer)';
  if (!['auto', 'jpeg', 'rtsps', 'none'].includes(camera)) return 'Invalid camera setting';
  return { name, model, serial, ip, access_code: accessCode, camera };
}

function withPrinter(
  handler: (printer: ManagedPrinter, request: any, reply: FastifyReply) => Promise<unknown>,
) {
  return async (request: any, reply: FastifyReply) => {
    const printer = manager.get(Number(request.params.id));
    if (!printer) return reply.code(404).send({ error: 'Printer not found' });
    return handler(printer, request, reply);
  };
}

const num = (v: unknown, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new RangeError(`Value must be between ${min} and ${max}`);
  return n;
};

/** Translate a UI action into an MQTT payload. Validates every parameter. */
function buildCommand(printer: ManagedPrinter, body: any): cmd.Command {
  const model = printer.connection.row.model;
  switch (body?.action) {
    case 'refresh':
      return cmd.pushAll();
    case 'pause':
      return cmd.pause();
    case 'resume':
      return cmd.resume();
    case 'stop':
      return cmd.stop();
    case 'speed':
      return cmd.printSpeed(num(body.level, 1, 4) as 1 | 2 | 3 | 4);
    case 'light': {
      const node = ['chamber_light', 'chamber_light2', 'work_light'].includes(body.node) ? body.node : 'chamber_light';
      return cmd.light(node, Boolean(body.on));
    }
    case 'nozzleTemp': {
      const temp = num(body.temp, 0, 350);
      return body.extruder === undefined || body.extruder === null
        ? cmd.nozzleTemp(temp)
        : cmd.nozzleTempIndexed(num(body.extruder, 0, 1), temp);
    }
    case 'bedTemp':
      return cmd.bedTemp(num(body.temp, 0, 120));
    case 'chamberTemp':
      if (!supportsChamberControl(model)) throw new RangeError('This printer has no chamber heater');
      return cmd.chamberTemp(num(body.temp, 0, 65));
    case 'fan':
      return cmd.fanSpeed(num(body.fan, 1, 3) as 1 | 2 | 3, num(body.percent, 0, 100));
    case 'home':
      return cmd.homeAll();
    case 'jog': {
      if (!['X', 'Y', 'Z'].includes(body.axis)) throw new RangeError('Invalid axis');
      return cmd.jog(body.axis, num(body.distance, -100, 100));
    }
    case 'extrude':
      return cmd.extrude(num(body.distance, -50, 50));
    case 'gcode': {
      const lines = typeof body.gcode === 'string' ? body.gcode.trim() : '';
      if (!lines || lines.length > 4000) throw new RangeError('G-code is empty or too long');
      return cmd.gcode(lines);
    }
    case 'unloadFilament':
      return cmd.unloadFilament();
    case 'loadFilament':
      return cmd.loadFilament(num(body.tray, 0, 254));
    default:
      throw new RangeError('Unknown action');
  }
}

export async function printerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/models', async () => MODELS);

  app.get('/api/printers', async () => manager.all().map((p) => p.connection.summary()));

  app.post('/api/printers/discover', async () => {
    const found = await discoverPrinters();
    const known = new Set(manager.all().map((p) => p.connection.row.serial));
    return found.map((p) => ({ ...p, alreadyAdded: known.has(p.serial) }));
  });

  app.post('/api/printers', async (request, reply) => {
    const input = parsePrinterInput(request.body);
    if (typeof input === 'string') return reply.code(400).send({ error: input });
    if (manager.all().some((p) => p.connection.row.serial === input.serial)) {
      return reply.code(409).send({ error: 'A printer with this serial number already exists' });
    }
    // Verify the access code against the printer before saving it.
    if ((request.body as any)?.skipTest !== true) {
      const test = await testConnection(input.ip, input.serial, input.access_code);
      if (!test.ok) return reply.code(422).send({ error: test.error, connectionFailed: true });
    }
    const row = manager.create(input);
    return { id: row.id };
  });

  app.get(
    '/api/printers/:id',
    withPrinter(async (p) => ({
      ...p.connection.snapshot(),
      camera: { kind: cameraKindFor(p.connection.row.model, p.connection.row.camera), error: p.camera.error },
      capabilities: { chamberControl: supportsChamberControl(p.connection.row.model) },
    })),
  );

  app.put(
    '/api/printers/:id',
    withPrinter(async (p, request, reply) => {
      const input = parsePrinterInput(request.body, p.connection.row);
      if (typeof input === 'string') return reply.code(400).send({ error: input });
      const clash = manager.all().find((o) => o !== p && o.connection.row.serial === input.serial);
      if (clash) return reply.code(409).send({ error: 'Another printer already uses this serial number' });
      manager.update(p.connection.row.id, input);
      return { ok: true };
    }),
  );

  app.delete(
    '/api/printers/:id',
    withPrinter(async (p) => ({ ok: manager.remove(p.connection.row.id) })),
  );

  // Live state via Server-Sent Events (throttled to ~4 updates/s).
  app.get(
    '/api/printers/:id/events',
    withPrinter(async (p, request, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let pending: NodeJS.Timeout | null = null;
      const send = () => {
        pending = null;
        const payload = {
          ...p.connection.snapshot(),
          camera: { kind: cameraKindFor(p.connection.row.model, p.connection.row.camera), error: p.camera.error },
          capabilities: { chamberControl: supportsChamberControl(p.connection.row.model) },
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const schedule = () => {
        pending ??= setTimeout(send, 250);
      };
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
      send();
      p.connection.on('update', schedule);
      p.camera.on('status', schedule);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        if (pending) clearTimeout(pending);
        p.connection.off('update', schedule);
        p.camera.off('status', schedule);
      });
    }),
  );

  app.post(
    '/api/printers/:id/command',
    withPrinter(async (p, request, reply) => {
      let payload: cmd.Command;
      try {
        payload = buildCommand(p, request.body);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      try {
        await p.connection.send(payload);
      } catch (err) {
        return reply.code(503).send({ error: (err as Error).message });
      }
      return { ok: true };
    }),
  );

  // --- camera ---

  app.get(
    '/api/printers/:id/camera/stream',
    withPrinter(async (p, request, reply) => {
      reply.hijack();
      const res = reply.raw;
      const boundary = 'bambuframe';
      res.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Connection: 'close',
      });
      const writeFrame = (jpeg: Buffer) => {
        // Drop frames for slow clients instead of buffering unboundedly.
        if (res.writableNeedDrain) return;
        res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write('\r\n');
      };
      if (p.camera.latest) writeFrame(p.camera.latest);
      const unsubscribe = p.camera.subscribe(writeFrame);
      request.raw.on('close', unsubscribe);
    }),
  );

  app.get(
    '/api/printers/:id/camera/snapshot',
    withPrinter(async (p, _request, reply) => {
      try {
        const jpeg = await p.camera.snapshot();
        return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store').send(jpeg);
      } catch (err) {
        return reply.code(504).send({ error: (err as Error).message });
      }
    }),
  );

  // --- files (FTPS) ---

  app.get(
    '/api/printers/:id/files',
    withPrinter(async (p, request, reply) => {
      try {
        return await p.ftps.list(safeRemotePath(request.query.path));
      } catch (err) {
        return reply.code(502).send({ error: `FTPS: ${(err as Error).message}` });
      }
    }),
  );

  app.get(
    '/api/printers/:id/files/download',
    withPrinter(async (p, request, reply) => {
      const path = safeRemotePath(request.query.path);
      const name = path.split('/').pop() || 'download';
      const stream = new PassThrough();
      p.ftps.download(path, stream).catch((err) => stream.destroy(err));
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${name.replace(/["\\\r\n]/g, '_')}"`)
        .send(stream);
    }),
  );

  // Media playback (videos / images) with HTTP Range support so the player can seek.
  app.get(
    '/api/printers/:id/files/stream',
    withPrinter(async (p, request, reply) => {
      let path: string;
      try {
        path = safeRemotePath(request.query.path);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const transcode = TRANSCODE_EXTENSIONS.has(ext);
      const type = transcode ? 'video/mp4' : MEDIA_TYPES[ext];
      if (!type) return reply.code(415).send({ error: 'Not a playable media file' });

      reply.hijack();
      const res = reply.raw;
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const fail = (status: number, message: string) => {
        if (res.headersSent) return res.destroy();
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }));
      };

      try {
        if (transcode) {
          // AVI (MJPEG timelapses on A1/P1) isn't playable in browsers: convert to
          // fragmented MP4 on the fly. No seeking in this mode.
          const ff = spawn(
            config.ffmpegPath,
            ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast',
              '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'],
            { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
          );
          ff.on('error', () => fail(500, 'ffmpeg not available'));
          ff.stdin.on('error', () => {});
          controller.signal.addEventListener('abort', () => ff.kill('SIGKILL'));
          await p.ftps.stream(
            path,
            {},
            () => {
              res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
              ff.stdout.pipe(res);
              return ff.stdin;
            },
            controller.signal,
          );
          return;
        }

        const header = String(request.headers.range ?? '');
        const m = /^bytes=(\d*)-(\d*)$/.exec(header);
        const range = !m
          ? {}
          : m[1] === ''
            ? { suffix: Number(m[2]) }
            : { start: Number(m[1]), end: m[2] === '' ? undefined : Number(m[2]) };

        await p.ftps.stream(
          path,
          range,
          (size, start, end) => {
            if (start >= size || start > end) {
              res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
              return null;
            }
            const headers: Record<string, string | number> = {
              'Content-Type': type,
              'Accept-Ranges': 'bytes',
              'Content-Length': end - start + 1,
              'Cache-Control': 'private, max-age=300',
            };
            if (m) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            res.writeHead(m ? 206 : 200, headers);
            return res;
          },
          controller.signal,
        );
      } catch (err) {
        if (controller.signal.aborted) return;
        const msg = (err as Error).message;
        fail(/550|No such file/i.test(msg) ? 404 : 502, `FTPS: ${msg}`);
      }
    }),
  );

  app.post(
    '/api/printers/:id/files/upload',
    withPrinter(async (p, request, reply) => {
      const dir = safeRemotePath(request.query.path);
      const file = await request.file({ limits: { fileSize: 1024 * 1024 * 1024 } });
      if (!file) return reply.code(400).send({ error: 'No file provided' });
      const name = String(file.filename).replace(/[/\\]/g, '_');
      try {
        await p.ftps.upload(`${dir === '/' ? '' : dir}/${name}`, file.file);
      } catch (err) {
        return reply.code(502).send({ error: `FTPS: ${(err as Error).message}` });
      }
      if (file.file.truncated) return reply.code(413).send({ error: 'File too large' });
      return { ok: true, name };
    }),
  );

  app.delete(
    '/api/printers/:id/files',
    withPrinter(async (p, request, reply) => {
      try {
        await p.ftps.remove(safeRemotePath(request.query.path));
        return { ok: true };
      } catch (err) {
        return reply.code(502).send({ error: `FTPS: ${(err as Error).message}` });
      }
    }),
  );

  app.post(
    '/api/printers/:id/print',
    withPrinter(async (p, request, reply) => {
      const body = request.body ?? {};
      let path: string;
      try {
        path = safeRemotePath(body.path);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      if (!/\.3mf$/i.test(path)) return reply.code(400).send({ error: 'Only .3mf files can be printed' });
      const fileName = path.split('/').pop()!;
      const plate = Number(body.plate ?? 1);
      if (!Number.isInteger(plate) || plate < 1 || plate > 99) return reply.code(400).send({ error: 'Invalid plate' });
      const amsMapping = Array.isArray(body.amsMapping)
        ? body.amsMapping.map((v: unknown) => Number(v)).filter((v: number) => Number.isInteger(v))
        : undefined;
      try {
        await p.connection.send(
          cmd.printProjectFile({
            url: printUrlFor(p.connection.row.model, path),
            fileName,
            plate,
            bedLeveling: body.bedLeveling !== false,
            timelapse: Boolean(body.timelapse),
            useAms: Boolean(body.useAms),
            flowCali: body.flowCali !== false,
            vibrationCali: Boolean(body.vibrationCali),
            layerInspect: body.layerInspect !== false,
            amsMapping,
          }),
        );
      } catch (err) {
        return reply.code(503).send({ error: (err as Error).message });
      }
      return { ok: true };
    }),
  );
}
