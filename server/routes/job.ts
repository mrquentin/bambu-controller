import type { FastifyInstance } from 'fastify';
import type { JobObjects } from '../../shared/api.ts';
import { skippedIds } from '../../shared/printer.ts';
import { idParams } from '../validation.ts';
import { withPrinter, type PrinterRoute } from './shared.ts';

/** Skip objects: the running job's objects and plate images (see bambu/job-objects.ts). */
export async function jobRoutes(app: FastifyInstance) {
  app.get(
    '/api/printers/:id/job/objects',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', properties: { refresh: { type: 'string', enum: ['0', '1'] } } },
      },
    },
    withPrinter<PrinterRoute & { Querystring: { refresh?: '0' | '1' } }>(async (p, request): Promise<JobObjects> => {
      const job = await p.jobObjects.get(p.connection.state, request.query.refresh === '1');
      const skipped = new Set(skippedIds(p.connection.state));
      return {
        file: job.path,
        plate: job.plate,
        objects: job.objects.map((o) => ({ ...o, skipped: skipped.has(o.id) })),
        hasPlateImage: job.plateImage !== null,
        hasPickMap: job.pickImage !== null,
      };
    }),
  );

  for (const [route, field] of [
    ['plate.png', 'plateImage'],
    ['pick.png', 'pickImage'],
  ] as const) {
    app.get(
      `/api/printers/:id/job/${route}`,
      { schema: { params: idParams } },
      withPrinter(async (p, _request, reply) => {
        const png = (await p.jobObjects.get(p.connection.state))[field];
        if (!png) return reply.code(404).send({ error: 'This project has no such image' });
        return reply.header('Content-Type', 'image/png').header('Cache-Control', 'no-store').send(png);
      }),
    );
  }
}
