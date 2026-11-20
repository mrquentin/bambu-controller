import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.ts';
import { MODELS } from '../bambu/models.ts';
import { testConnection } from '../bambu/printer.ts';
import { audit } from '../audit.ts';
import { checkPrinterHost } from '../net-policy.ts';
import { discoverPrinters } from '../bambu/ssdp.ts';
import type { CameraSetting, PrinterRow } from '../db.ts';
import { manager } from '../manager.ts';
import { idParams } from '../validation.ts';
import { printerDetail, withPrinter, type PrinterRoute } from './shared.ts';

type PrinterInput = Omit<PrinterRow, 'id' | 'created_at'>;

interface PrinterBody {
  name: string;
  model: string;
  serial: string;
  ip: string;
  accessCode?: string;
  camera?: CameraSetting;
  tlsVerify?: boolean;
  skipTest?: boolean;
}

/**
 * Types and hard length caps. `parsePrinterInput` still trims, upper-cases the
 * serial and applies the format checks, with the same messages as the schema.
 */
const printerFields = {
  name: { type: 'string', maxLength: 64, errorMessage: 'Name is required (max 64 characters)' },
  model: { type: 'string', maxLength: 64, errorMessage: { required: 'Model is required', type: 'Model is required' } },
  serial: { type: 'string', maxLength: 32, errorMessage: 'Serial number looks invalid' },
  ip: { type: 'string', maxLength: 253, errorMessage: 'IP address / hostname looks invalid' },
  accessCode: { type: 'string', maxLength: 32, errorMessage: 'Access code looks invalid (8 characters, shown on the printer)' },
  camera: { type: 'string', enum: ['auto', 'jpeg', 'rtsps', 'none'], errorMessage: 'Invalid camera setting' },
  tlsVerify: { type: 'boolean' },
};

const createBody = {
  type: 'object',
  required: ['name', 'model', 'serial', 'ip', 'accessCode'],
  additionalProperties: false,
  // `skipTest`: save without checking the connection first (printer offline).
  properties: { ...printerFields, skipTest: { type: 'boolean' } },
};

/** On edit, a missing or blank access code keeps the stored one. */
const updateBody = {
  type: 'object',
  required: ['name', 'model', 'serial', 'ip'],
  additionalProperties: false,
  properties: printerFields,
};

function parsePrinterInput(body: PrinterBody, existing?: PrinterRow): PrinterInput | string {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = str(body?.name);
  const model = str(body?.model);
  const serial = str(body?.serial).toUpperCase();
  const ip = str(body?.ip);
  // Leave the access code unchanged on edit when the field is left blank.
  const accessCode = str(body?.accessCode) || existing?.access_code || '';
  const camera = (str(body?.camera) || 'auto') as CameraSetting;
  // Certificate verification is on unless explicitly disabled.
  const tlsVerify = body?.tlsVerify === undefined ? (existing?.tls_verify ?? 1) : body.tlsVerify === false ? 0 : 1;

  if (!name || name.length > 64) return 'Name is required (max 64 characters)';
  if (!model) return 'Model is required';
  if (!/^[A-Z0-9]{6,32}$/.test(serial)) return 'Serial number looks invalid';
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(ip)) return 'IP address / hostname looks invalid';
  if (!/^[A-Za-z0-9]{4,32}$/.test(accessCode)) return 'Access code looks invalid (8 characters, shown on the printer)';
  if (!['auto', 'jpeg', 'rtsps', 'none'].includes(camera)) return 'Invalid camera setting';
  return { name, model, serial, ip, access_code: accessCode, camera, tls_verify: tlsVerify };
}

/** Printer CRUD, LAN discovery and the model list. */
export async function printerRoutes(app: FastifyInstance) {
  // Before validation, so anonymous callers get 401 rather than a schema error.
  app.addHook('preValidation', requireAuth);

  app.get('/api/models', async () => MODELS);

  app.get('/api/printers', async () => manager.all().map((p) => p.connection.summary()));

  // One discovery at a time; concurrent callers share the same scan.
  let discovery: ReturnType<typeof discoverPrinters> | null = null;
  app.post('/api/printers/discover', async () => {
    discovery ??= discoverPrinters().finally(() => (discovery = null));
    const found = await discovery;
    const known = new Set(manager.all().map((p) => p.connection.row.serial));
    return found.map((p) => ({ ...p, alreadyAdded: known.has(p.serial) }));
  });

  app.post<{ Body: PrinterBody }>('/api/printers', { schema: { body: createBody } }, async (request, reply) => {
    const input = parsePrinterInput(request.body);
    if (typeof input === 'string') return reply.code(400).send({ error: input });
    if (manager.all().some((p) => p.connection.row.serial === input.serial)) {
      return reply.code(409).send({ error: 'A printer with this serial number already exists' });
    }
    const hostProblem = await checkPrinterHost(input.ip);
    if (hostProblem) return reply.code(400).send({ error: hostProblem });
    // Verify the access code (and certificate) against the printer before saving it.
    if (request.body.skipTest !== true) {
      const test = await testConnection(input.ip, input.serial, input.access_code, input.tls_verify);
      if (!test.ok) {
        audit(request, {
          action: 'printer.add',
          outcome: 'failure',
          detail: { serial: input.serial, ip: input.ip, reason: test.error },
        });
        return reply.code(422).send({ error: test.error, connectionFailed: true });
      }
    }
    const row = manager.create(input);
    audit(request, {
      action: 'printer.add',
      detail: { id: row.id, name: row.name, serial: row.serial, ip: row.ip, tlsVerify: Boolean(row.tls_verify) },
    });
    return { id: row.id };
  });

  app.get(
    '/api/printers/:id',
    { schema: { params: idParams } },
    withPrinter(async (p) => printerDetail(p)),
  );

  app.put(
    '/api/printers/:id',
    { schema: { params: idParams, body: updateBody } },
    withPrinter<PrinterRoute & { Body: PrinterBody }>(async (p, request, reply) => {
      const input = parsePrinterInput(request.body, p.connection.row);
      if (typeof input === 'string') return reply.code(400).send({ error: input });
      const clash = manager.all().find((o) => o !== p && o.connection.row.serial === input.serial);
      if (clash) return reply.code(409).send({ error: 'Another printer already uses this serial number' });
      const hostProblem = await checkPrinterHost(input.ip);
      if (hostProblem) return reply.code(400).send({ error: hostProblem });
      const before = p.connection.row;
      manager.update(before.id, input);
      audit(request, {
        action: 'printer.update',
        detail: {
          id: before.id,
          name: input.name,
          ip: input.ip,
          accessCodeChanged: input.access_code !== before.access_code,
          tlsVerify: Boolean(input.tls_verify),
        },
      });
      return { ok: true };
    }),
  );

  app.delete(
    '/api/printers/:id',
    { schema: { params: idParams } },
    withPrinter(async (p, request) => {
      const { id, name, serial } = p.connection.row;
      const ok = manager.remove(id);
      audit(request, { action: 'printer.delete', detail: { id, name, serial } });
      return { ok };
    }),
  );
}
