import type { FastifyInstance } from 'fastify';
import type { DiscoveredPrinter } from '../../shared/api.ts';
import { PRINTER, type PrinterRequest } from '../../shared/forms.ts';
import { CAMERA_SETTINGS } from '../../shared/printer.ts';
import { MODELS } from '../bambu/models.ts';
import { testConnection } from '../bambu/printer.ts';
import { audit } from '../audit.ts';
import { checkPrinterHost } from '../net-policy.ts';
import { discoverPrinters } from '../bambu/ssdp.ts';
import type { PrinterRow } from '../db.ts';
import { manager, type PrinterInput } from '../manager.ts';
import { HttpError } from '../http-error.ts';
import { idParams } from '../validation.ts';
import { printerDetail, withPrinter, type PrinterRoute } from './shared.ts';

const MESSAGES = {
  name: `Name is required (max ${PRINTER.name.maxLength} characters)`,
  model: 'Model is required',
  serial: 'Serial number looks invalid',
  ip: 'IP address / hostname looks invalid',
  accessCode: 'Access code looks invalid (8 characters, shown on the printer)',
};

/** Types and length caps; `parsePrinterInput` trims and checks the formats. */
const printerFields = {
  name: { type: 'string', maxLength: PRINTER.name.maxLength, errorMessage: MESSAGES.name },
  model: { type: 'string', maxLength: 64, errorMessage: { required: MESSAGES.model, type: MESSAGES.model } },
  serial: { type: 'string', maxLength: PRINTER.serial.maxLength, errorMessage: MESSAGES.serial },
  ip: { type: 'string', maxLength: PRINTER.host.maxLength, errorMessage: MESSAGES.ip },
  accessCode: { type: 'string', maxLength: PRINTER.accessCode.maxLength, errorMessage: MESSAGES.accessCode },
  camera: { type: 'string', enum: CAMERA_SETTINGS, errorMessage: 'Invalid camera setting' },
  tlsVerify: { type: 'boolean' },
};

const createBody = {
  type: 'object',
  required: ['name', 'model', 'serial', 'ip', 'accessCode'],
  additionalProperties: false,
  properties: { ...printerFields, skipTest: { type: 'boolean' } },
};

/** On edit, a missing or blank access code keeps the stored one. */
const updateBody = {
  type: 'object',
  required: ['name', 'model', 'serial', 'ip'],
  additionalProperties: false,
  properties: printerFields,
};

function parsePrinterInput(body: PrinterRequest, existing?: PrinterRow): PrinterInput {
  const name = body.name.trim();
  const model = body.model.trim();
  const serial = body.serial.trim().toUpperCase();
  const ip = body.ip.trim();
  const accessCode = body.accessCode?.trim() || existing?.access_code || '';
  const tlsVerify = body.tlsVerify === undefined ? (existing?.tls_verify ?? 1) : Number(body.tlsVerify);

  const invalid = (message: string) => new HttpError(400, message);
  if (!name) throw invalid(MESSAGES.name);
  if (!model) throw invalid(MESSAGES.model);
  if (!/^[A-Z0-9]+$/.test(serial) || serial.length < PRINTER.serial.minLength) throw invalid(MESSAGES.serial);
  if (!/^[a-zA-Z0-9.-]+$/.test(ip)) throw invalid(MESSAGES.ip);
  if (!/^[A-Za-z0-9]+$/.test(accessCode) || accessCode.length < PRINTER.accessCode.minLength) throw invalid(MESSAGES.accessCode);
  return { name, model, serial, ip, access_code: accessCode, camera: body.camera ?? 'auto', tls_verify: tlsVerify };
}

/** Printer CRUD, LAN discovery and the model list. */
export async function printerRoutes(app: FastifyInstance) {
  app.get('/api/models', async () => MODELS);

  app.get('/api/printers', async () => manager.all().map((p) => p.connection.summary()));

  let discovery: ReturnType<typeof discoverPrinters> | null = null;
  app.post('/api/printers/discover', async (): Promise<DiscoveredPrinter[]> => {
    discovery ??= discoverPrinters().finally(() => (discovery = null));
    const found = await discovery;
    const known = new Set(manager.all().map((p) => p.connection.row.serial));
    return found.map((p) => ({ ...p, alreadyAdded: known.has(p.serial) }));
  });

  app.post<{ Body: PrinterRequest }>('/api/printers', { schema: { body: createBody } }, async (request, reply) => {
    const input = parsePrinterInput(request.body);
    if (manager.all().some((p) => p.connection.row.serial === input.serial)) {
      return reply.code(409).send({ error: 'A printer with this serial number already exists' });
    }
    const hostProblem = await checkPrinterHost(input.ip);
    if (hostProblem) return reply.code(400).send({ error: hostProblem });
    if (request.body.skipTest !== true) {
      const test = await testConnection(input);
      if (!test.ok) {
        audit(request, {
          action: 'printer.add',
          outcome: 'failure',
          detail: { serial: input.serial, ip: input.ip, reason: test.error },
        });
        return reply.code(422).send({ error: test.error });
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
    withPrinter<PrinterRoute & { Body: PrinterRequest }>(async (p, request, reply) => {
      const input = parsePrinterInput(request.body, p.connection.row);
      const clash = manager.all().find((o) => o !== p && o.connection.row.serial === input.serial);
      if (clash) return reply.code(409).send({ error: 'Another printer already uses this serial number' });
      const hostProblem = await checkPrinterHost(input.ip);
      if (hostProblem) return reply.code(400).send({ error: hostProblem });
      const before = p.connection.row;
      manager.update(p, input);
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
      manager.remove(p);
      audit(request, { action: 'printer.delete', detail: { id, name, serial } });
      return { ok: true };
    }),
  );
}
