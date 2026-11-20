import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.ts';
import { safeRemotePath } from '../bambu/ftps.ts';
import { config } from '../config.ts';
import { idParams, remotePathQuery, type RemotePathQuery } from '../validation.ts';
import { withPrinter, type PrinterRoute } from './shared.ts';

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

/** Long-lived binary streams: live camera (MJPEG), snapshots, and timelapse/image playback. */
export async function mediaRoutes(app: FastifyInstance) {
  // Before validation, so anonymous callers get 401 rather than a schema error.
  app.addHook('preValidation', requireAuth);

  app.get(
    '/api/printers/:id/camera/stream',
    { schema: { params: idParams } },
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
    { schema: { params: idParams } },
    withPrinter(async (p, _request, reply) => {
      try {
        const jpeg = await p.camera.snapshot();
        return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store').send(jpeg);
      } catch (err) {
        return reply.code(504).send({ error: (err as Error).message });
      }
    }),
  );

  // Media playback (videos / images) with HTTP Range support so the player can seek.
  app.get(
    '/api/printers/:id/files/stream',
    { schema: { params: idParams, querystring: remotePathQuery } },
    withPrinter<PrinterRoute & { Querystring: RemotePathQuery }>(async (p, request, reply) => {
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
}
