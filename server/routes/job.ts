import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAuth } from '../auth.ts';
import { JobObjectsError, jobObjects, skippedIds, type LoadedJob } from '../bambu/job-objects.ts';
import type { ManagedPrinter } from '../manager.ts';
import { withPrinter } from './printers.ts';

/** Load (or reuse) the current job's object list; maps failures to HTTP errors. */
async function currentJob(p: ManagedPrinter, reply: FastifyReply, refresh = false): Promise<LoadedJob | null> {
  const { row, state } = p.connection;
  try {
    return await jobObjects.get(row.id, p.ftps, state, refresh);
  } catch (err) {
    if (err instanceof JobObjectsError) {
      reply.code(err.statusCode).send({ error: err.message });
    } else {
      reply.code(502).send({ error: `FTPS: ${(err as Error).message}` });
    }
    return null;
  }
}

/** Skip objects: the running job's objects and plate images (see bambu/job-objects.ts). */
export async function jobRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get(
    '/api/printers/:id/job/objects',
    withPrinter(async (p, request, reply) => {
      const job = await currentJob(p, reply, request.query?.refresh === '1');
      if (!job) return reply;
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
      withPrinter(async (p, _request, reply) => {
        const job = await currentJob(p, reply);
        if (!job) return reply;
        const png = job[field];
        if (!png) return reply.code(404).send({ error: 'This project has no such image' });
        return reply.header('Content-Type', 'image/png').header('Cache-Control', 'no-store').send(png);
      }),
    );
  }
}
