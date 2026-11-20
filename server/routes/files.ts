import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { RemoteFile } from '../../shared/api.ts';
import { PROJECT_FILE, UPLOADABLE, joinPath } from '../../shared/files.ts';
import { MAX_PATH_LENGTH, PLATE, type PrintRequest } from '../../shared/forms.ts';
import * as cmd from '../bambu/commands.ts';
import { safeRemotePath } from '../bambu/ftps.ts';
import { printUrlFor } from '../bambu/models.ts';
import { audit } from '../audit.ts';
import { HttpError } from '../http-error.ts';
import { idParams, remotePathQuery, type RemotePathQuery } from '../validation.ts';
import { withPrinter, type PrinterRoute } from './shared.ts';

interface PathRoute extends PrinterRoute {
  Querystring: RemotePathQuery;
}

const pathSchema = { schema: { params: idParams, querystring: remotePathQuery } };

const printBody = {
  type: 'object',
  required: ['path'],
  additionalProperties: false,
  properties: {
    path: { type: 'string', maxLength: MAX_PATH_LENGTH, errorMessage: 'Invalid path' },
    plate: { type: 'integer', minimum: PLATE.min, maximum: PLATE.max, errorMessage: 'Invalid plate' },
    bedLeveling: { type: 'boolean' },
    timelapse: { type: 'boolean' },
    useAms: { type: 'boolean' },
    flowCali: { type: 'boolean' },
    vibrationCali: { type: 'boolean' },
    layerInspect: { type: 'boolean' },
    amsMapping: { type: 'array', maxItems: 64, items: { type: 'integer' } },
  },
};

interface PrintRoute extends PrinterRoute {
  Body: PrintRequest;
}

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const tooLarge = () => new HttpError(413, `File too large (max ${MAX_UPLOAD_BYTES / 1024 ** 3} GB)`);

/** Strip path separators and control characters; keep names reasonable. */
function safeFileName(raw: string): string | null {
  const name = raw
    .normalize('NFC')
    .replace(/[/\\]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!name || name.startsWith('.') || name.length > 200) return null;
  return name;
}

/** Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 name. */
function attachmentHeader(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Printer storage over FTPS: browse, transfer, delete, and start a print from a file. */
export async function fileRoutes(app: FastifyInstance) {
  app.get(
    '/api/printers/:id/files',
    pathSchema,
    withPrinter<PathRoute>(async (p, request): Promise<RemoteFile[]> => p.ftps.list(safeRemotePath(request.query.path))),
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
    withPrinter<PathRoute>(async (p, request) => {
      const dir = safeRemotePath(request.query.path);
      const file = await request.file();
      if (!file) throw new HttpError(400, 'No file provided');
      const name = safeFileName(String(file.filename));
      if (!name || !UPLOADABLE.test(name)) {
        file.file.resume();
        throw new HttpError(400, 'Only .3mf and .gcode files can be uploaded');
      }
      const target = joinPath(dir, name);
      const detail = { printer: p.connection.row.id, path: target };
      try {
        await p.ftps.upload(target, file.file);
        if (file.file.truncated) throw tooLarge();
      } catch (err) {
        await p.ftps.remove(target).catch(() => {});
        audit(request, { action: 'file.upload', outcome: 'failure', detail });
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
        throw err;
      }
      audit(request, { action: 'file.upload', detail });
      return { ok: true, name };
    }),
  );

  app.delete(
    '/api/printers/:id/files',
    pathSchema,
    withPrinter<PathRoute>(async (p, request) => {
      const path = safeRemotePath(request.query.path);
      await p.ftps.remove(path);
      audit(request, { action: 'file.delete', detail: { printer: p.connection.row.id, path } });
      return { ok: true };
    }),
  );

  app.post(
    '/api/printers/:id/print',
    { schema: { params: idParams, body: printBody } },
    withPrinter<PrintRoute>(async (p, request) => {
      const body = request.body;
      const path = safeRemotePath(body.path);
      if (!PROJECT_FILE.test(path)) throw new HttpError(400, 'Only .3mf files can be printed');
      const plate = body.plate ?? 1;
      await p.connection.send(
        cmd.printProjectFile({
          url: printUrlFor(p.connection.row.model, path),
          fileName: path.split('/').pop()!,
          plate,
          bedLeveling: body.bedLeveling !== false,
          timelapse: Boolean(body.timelapse),
          useAms: Boolean(body.useAms),
          flowCali: body.flowCali !== false,
          vibrationCali: Boolean(body.vibrationCali),
          layerInspect: body.layerInspect !== false,
          amsMapping: body.amsMapping,
        }),
      );
      audit(request, { action: 'printer.print_start', detail: { printer: p.connection.row.id, path, plate } });
      return { ok: true };
    }),
  );
}
