import type { FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import type { PrinterDetail } from '../../shared/api.ts';
import { cameraKindFor, supportsChamberControl } from '../bambu/models.ts';
import { manager, type ManagedPrinter } from '../manager.ts';
import type { IdParams } from '../validation.ts';

/** Helpers shared by the per-printer route modules (printers, control, files, media, job). */

/** Route generic for `/api/printers/:id/...`; extend it with `Querystring` / `Body` as needed. */
export interface PrinterRoute extends RouteGenericInterface {
  Params: IdParams;
}

/**
 * Resolve `:id` to a managed printer, or answer 404 before the handler runs.
 * Routes using it declare `params: idParams` so the id is a validated integer string.
 */
export function withPrinter<T extends PrinterRoute = PrinterRoute>(
  handler: (printer: ManagedPrinter, request: FastifyRequest<T>, reply: FastifyReply) => Promise<unknown>,
) {
  return async (request: FastifyRequest<T>, reply: FastifyReply) => {
    const printer = manager.get(Number((request.params as IdParams).id));
    if (!printer) return reply.code(404).send({ error: 'Printer not found' });
    return handler(printer, request, reply);
  };
}

/** GET /api/printers/:id and every SSE update send the same view. */
export function printerDetail(p: ManagedPrinter): PrinterDetail {
  const { model, camera } = p.connection.row;
  return {
    ...p.connection.snapshot(),
    camera: { kind: cameraKindFor(model, camera), error: p.camera.error },
    capabilities: { chamberControl: supportsChamberControl(model) },
  };
}
