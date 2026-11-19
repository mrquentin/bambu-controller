import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.ts';
import { requireAuth } from '../auth.ts';
import { db } from '../db.ts';
import { deleteJob, getJob, jobStats, listJobs } from '../history.ts';

/** Page size: `?limit=` (1–100, default 25) and `?offset=`. */
function page(query: any) {
  const int = (v: unknown, fallback: number, min: number, max: number) => {
    const n = Math.trunc(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return { limit: int(query?.limit ?? 25, 25, 1, 100), offset: int(query?.offset ?? 0, 0, 0, Number.MAX_SAFE_INTEGER) };
}

/** Jobs are kept for removed printers, so the per-printer routes check the table, not the live manager. */
const printerExists = (id: number) => Boolean(db.prepare('SELECT 1 FROM printers WHERE id = ?').get(id));

export async function historyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/history', async (request) => listJobs(page(request.query)));

  app.get('/api/history/stats', async () => jobStats());

  app.get<{ Params: { id: string } }>('/api/printers/:id/history', async (request, reply) => {
    const printerId = Number(request.params.id);
    if (!printerExists(printerId)) return reply.code(404).send({ error: 'Printer not found' });
    return listJobs({ printerId, ...page(request.query) });
  });

  app.get<{ Params: { id: string } }>('/api/printers/:id/history/stats', async (request, reply) => {
    const printerId = Number(request.params.id);
    if (!printerExists(printerId)) return reply.code(404).send({ error: 'Printer not found' });
    return jobStats(printerId);
  });

  app.delete<{ Params: { jobId: string } }>('/api/history/:jobId', async (request, reply) => {
    const job = getJob(Number(request.params.jobId));
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    // The recorder still writes to an open job; it can be deleted once it has ended.
    if (job.status === 'running' || job.status === 'paused') {
      return reply.code(409).send({ error: 'This print is still in progress' });
    }
    deleteJob(job.id);
    audit(request, {
      action: 'history.delete',
      detail: { id: job.id, printerId: job.printer_id, printer: job.printer_name, task: job.task, status: job.status },
    });
    return { ok: true };
  });
}
