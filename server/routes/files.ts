import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.ts';
import * as cmd from '../bambu/commands.ts';
import { safeRemotePath } from '../bambu/ftps.ts';
import { printUrlFor } from '../bambu/models.ts';
import { audit } from '../audit.ts';
import { idParams, remotePathQuery, type RemotePathQuery } from '../validation.ts';
import { attachmentHeader, safeFileName, withPrinter, type PrinterRoute } from './shared.ts';

/** Files the printer can print — the only types accepted for upload. */
const UPLOAD_EXTENSIONS = /\.(3mf|gcode)$/i;

interface PathRoute extends PrinterRoute {
  Querystring: RemotePathQuery;
}

const pathSchema = { schema: { params: idParams, querystring: remotePathQuery } };

const printBody = {
  type: 'object',
  required: ['path'],
  additionalProperties: false,
  properties: {
    path: { type: 'string', maxLength: 1024, errorMessage: 'Invalid path' },
    plate: { type: ['integer', 'null'], minimum: 1, maximum: 99, errorMessage: 'Invalid plate' },
    bedLeveling: { type: 'boolean' },
    timelapse: { type: 'boolean' },
    useAms: { type: 'boolean' },
    flowCali: { type: 'boolean' },
    vibrationCali: { type: 'boolean' },
    layerInspect: { type: 'boolean' },
    // AMS slot per filament of the project; -1 leaves a filament unmapped.
    amsMapping: { type: 'array', maxItems: 64, items: { type: 'integer' } },
  },
};

interface PrintRoute extends PrinterRoute {
  Body: {
    path: string;
    plate?: number | null;
    bedLeveling?: boolean;
    timelapse?: boolean;
    useAms?: boolean;
    flowCali?: boolean;
    vibrationCali?: boolean;
    layerInspect?: boolean;
    amsMapping?: number[];
  };
}

/** Printer storage over FTPS: browse, transfer, delete, and start a print from a file. */
export async function fileRoutes(app: FastifyInstance) {
  // Before validation, so anonymous callers get 401 rather than a schema error.
  app.addHook('preValidation', requireAuth);

  app.get(
    '/api/printers/:id/files',
    pathSchema,
    withPrinter<PathRoute>(async (p, request, reply) => {
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
    pathSchema,
    withPrinter<PathRoute>(async (p, request, reply) => {
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
    pathSchema,
    withPrinter<PathRoute>(async (p, request, reply) => {
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
    pathSchema,
    withPrinter<PathRoute>(async (p, request, reply) => {
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
    { schema: { params: idParams, body: printBody } },
    withPrinter<PrintRoute>(async (p, request, reply) => {
      const body = request.body;
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
      const amsMapping = body.amsMapping;
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
