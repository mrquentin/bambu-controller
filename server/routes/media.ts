import { spawn } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { safeRemotePath } from '../bambu/ftps.ts';
import { mediaOf } from '../../shared/files.ts';
import { config } from '../config.ts';
import { HttpError } from '../http-error.ts';
import { idParams, remotePathQuery, type RemotePathQuery } from '../validation.ts';
import { withPrinter, type PrinterRoute } from './shared.ts';

/** Long-lived binary streams: live camera (MJPEG), snapshots, and timelapse/image playback. */
export async function mediaRoutes(app: FastifyInstance) {
  app.get(
    '/api/printers/:id/camera/stream',
    { schema: { params: idParams } },
    withPrinter(async (p, request, reply) => {
      if (!p.camera.enabled) throw new HttpError(404, 'Camera disabled for this printer');
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
      if (!p.camera.enabled) throw new HttpError(404, 'Camera disabled for this printer');
      const jpeg = await p.camera.snapshot();
      return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store').send(jpeg);
    }),
  );

  app.get(
    '/api/printers/:id/files/stream',
    { schema: { params: idParams, querystring: remotePathQuery } },
    withPrinter<PrinterRoute & { Querystring: RemotePathQuery }>(async (p, request, reply) => {
      const path = safeRemotePath(request.query.path);
      const media = mediaOf(path);
      if (!media) throw new HttpError(415, 'Not a playable media file');
      const type = media.type;

      reply.hijack();
      const res = reply.raw;
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const fail = (status: number, message: string) => {
        if (res.headersSent) return res.destroy();
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }));
      };

      try {
        if (media.transcoded) {
          // AVI (MJPEG timelapses on A1/P1) isn't playable in browsers: convert to
          // fragmented MP4 on the fly. No seeking in this mode.
          const ff = spawn(
            config.ffmpegPath,
            ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast',
              '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'],
            { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
          );
          ff.on('error', (err) => {
            request.log.error({ err }, 'ffmpeg failed');
            fail(500, 'ffmpeg not available');
          });
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
        if (err instanceof HttpError) {
          request.log.warn({ err }, 'media stream failed');
          fail(err.statusCode, err.message);
        } else {
          request.log.error({ err }, 'media stream failed');
          fail(500, 'Internal server error');
        }
      }
    }),
  );
}
