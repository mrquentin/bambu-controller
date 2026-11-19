import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.ts';
import * as cmd from '../bambu/commands.ts';
import { safeRemotePath } from '../bambu/ftps.ts';
import { printUrlFor } from '../bambu/models.ts';
import { audit } from '../audit.ts';
import { attachmentHeader, safeFileName, withPrinter } from './shared.ts';

/** Files the printer can print — the only types accepted for upload. */
const UPLOAD_EXTENSIONS = /\.(3mf|gcode)$/i;

/** Printer storage over FTPS: browse, transfer, delete, and start a print from a file. */
export async function fileRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get(
    '/api/printers/:id/files',
    withPrinter(async (p, request, reply) => {
      const path = safeRemotePath(request.query.path); // throws 400 on bad input
      try {
        return await p.ftps.list(path);
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
      audit(request, { action: 'file.download', detail: { printer: p.connection.row.id, path } });
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', attachmentHeader(name))
        .send(stream);
    }),
  );

  app.post(
    '/api/printers/:id/files/upload',
    withPrinter(async (p, request, reply) => {
      const dir = safeRemotePath(request.query.path);
      const file = await request.file({ limits: { fileSize: 1024 * 1024 * 1024 } });
      if (!file) return reply.code(400).send({ error: 'No file provided' });
      const name = safeFileName(String(file.filename));
      if (!name || !UPLOAD_EXTENSIONS.test(name)) {
        file.file.resume(); // drain the upload
        return reply.code(400).send({ error: 'Only .3mf and .gcode files can be uploaded' });
      }
      const target = `${dir === '/' ? '' : dir}/${name}`;
      try {
        await p.ftps.upload(target, file.file);
        if (file.file.truncated) throw Object.assign(new Error('File too large'), { statusCode: 413 });
      } catch (err) {
        // Don't leave a partial file on the printer.
        await p.ftps.remove(target).catch(() => {});
        const e = err as Error & { statusCode?: number; code?: string };
        audit(request, {
          action: 'file.upload',
          outcome: 'failure',
          detail: { printer: p.connection.row.id, path: target },
        });
        if (e.statusCode === 413 || e.code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(413).send({ error: 'File too large (max 1 GB)' });
        }
        return reply.code(502).send({ error: `FTPS: ${e.message}` });
      }
      audit(request, { action: 'file.upload', detail: { printer: p.connection.row.id, path: target } });
      return { ok: true, name };
    }),
  );

  app.delete(
    '/api/printers/:id/files',
    withPrinter(async (p, request, reply) => {
      const path = safeRemotePath(request.query.path);
      try {
        await p.ftps.remove(path);
        audit(request, { action: 'file.delete', detail: { printer: p.connection.row.id, path } });
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
      audit(request, { action: 'printer.print_start', detail: { printer: p.connection.row.id, path, plate } });
      return { ok: true };
    }),
  );
}
