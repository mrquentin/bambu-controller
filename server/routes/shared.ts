import type { FastifyReply } from 'fastify';
import { cameraKindFor, supportsChamberControl } from '../bambu/models.ts';
import { manager, type ManagedPrinter } from '../manager.ts';

/** Helpers shared by the per-printer route modules (printers, control, files, media, job). */

/** Resolve `:id` to a managed printer, or answer 404 before the handler runs. */
export function withPrinter(
  handler: (printer: ManagedPrinter, request: any, reply: FastifyReply) => Promise<unknown>,
) {
  return async (request: any, reply: FastifyReply) => {
    const printer = manager.get(Number(request.params.id));
    if (!printer) return reply.code(404).send({ error: 'Printer not found' });
    return handler(printer, request, reply);
  };
}

/** Full printer view: GET /api/printers/:id and every SSE update send the same shape. */
export function printerDetail(p: ManagedPrinter) {
  return {
    ...p.connection.snapshot(),
    camera: { kind: cameraKindFor(p.connection.row.model, p.connection.row.camera), error: p.camera.error },
    capabilities: { chamberControl: supportsChamberControl(p.connection.row.model) },
  };
}

/** Number in [min, max]; the RangeError message is shown to the user as-is. */
export const num = (v: unknown, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new RangeError(`Value must be between ${min} and ${max}`);
  return n;
};

/** Strip path separators and control characters; keep names reasonable. */
export function safeFileName(raw: string): string | null {
  const name = raw
    .normalize('NFC')
    .replace(/[/\\]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!name || name.startsWith('.') || name.length > 200) return null;
  return name;
}

/** Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 name. */
export function attachmentHeader(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
