import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.ts';
import * as cmd from '../bambu/commands.ts';
import { MAX_SKIP_IDS, buildSkipCommand, describeSkipped, jobObjects } from '../bambu/job-objects.ts';
import { supportsChamberControl } from '../bambu/models.ts';
import { audit } from '../audit.ts';
import type { ManagedPrinter } from '../manager.ts';
import { idParams } from '../validation.ts';
import { num, printerDetail, withPrinter, type PrinterRoute } from './shared.ts';

/**
 * Command envelope, one `oneOf` branch per action (selected by the `action`
 * discriminator): which fields each action takes, their types, and nothing else.
 * Numeric ranges stay in `buildCommand` next to the MQTT payloads they protect,
 * with checks that depend on the printer (chamber heater, running job) — one
 * source of truth for each limit, and the same messages as before.
 */
const integer = { type: 'integer' } as const;
const number = { type: 'number' } as const;

function action(name: string, properties: Record<string, object> = {}, required: string[] = []) {
  return {
    type: 'object',
    properties: { action: { const: name }, ...properties },
    required: ['action', ...required],
    additionalProperties: false,
  };
}

const commandBody = {
  type: 'object',
  required: ['action'],
  discriminator: { propertyName: 'action' },
  errorMessage: { required: 'Unknown action', discriminator: 'Unknown action' },
  oneOf: [
    action('refresh'),
    action('pause'),
    action('resume'),
    action('stop'),
    action('speed', { level: integer }, ['level']),
    action('light', {
      node: { type: 'string', enum: ['chamber_light', 'chamber_light2', 'work_light'] },
      on: { type: 'boolean' },
    }),
    action('nozzleTemp', { temp: number, extruder: { type: ['integer', 'null'] } }, ['temp']),
    action('bedTemp', { temp: number }, ['temp']),
    action('chamberTemp', { temp: number }, ['temp']),
    action('fan', { fan: integer, percent: number }, ['fan', 'percent']),
    action('home'),
    action('jog', { axis: { type: 'string', enum: ['X', 'Y', 'Z'], errorMessage: 'Invalid axis' }, distance: number }, [
      'axis',
      'distance',
    ]),
    action('extrude', { distance: number }, ['distance']),
    action('gcode', { gcode: { type: 'string', maxLength: 4000, errorMessage: 'G-code is empty or too long' } }, ['gcode']),
    action('unloadFilament'),
    action('loadFilament', { tray: integer }, ['tray']),
    action(
      'skipObjects',
      {
        ids: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_SKIP_IDS,
          items: { type: 'integer', minimum: 1, errorMessage: 'Object ids must be positive integers' },
          errorMessage: `ids must be a list of 1 to ${MAX_SKIP_IDS} object ids`,
        },
      },
      ['ids'],
    ),
  ],
};

interface CommandRoute extends PrinterRoute {
  Body: { action: string; [param: string]: unknown };
}

/** Translate a UI action into an MQTT payload. Validates every parameter. */
function buildCommand(printer: ManagedPrinter, body: any): cmd.Command {
  const model = printer.connection.row.model;
  switch (body?.action) {
    case 'refresh':
      return cmd.pushAll();
    case 'pause':
      return cmd.pause();
    case 'resume':
      return cmd.resume();
    case 'stop':
      return cmd.stop();
    case 'speed':
      return cmd.printSpeed(num(body.level, 1, 4) as 1 | 2 | 3 | 4);
    case 'light': {
      const node = ['chamber_light', 'chamber_light2', 'work_light'].includes(body.node) ? body.node : 'chamber_light';
      return cmd.light(node, Boolean(body.on));
    }
    case 'nozzleTemp': {
      const temp = num(body.temp, 0, 350);
      return body.extruder === undefined || body.extruder === null
        ? cmd.nozzleTemp(temp)
        : cmd.nozzleTempIndexed(num(body.extruder, 0, 1), temp);
    }
    case 'bedTemp':
      return cmd.bedTemp(num(body.temp, 0, 120));
    case 'chamberTemp':
      if (!supportsChamberControl(model)) throw new RangeError('This printer has no chamber heater');
      return cmd.chamberTemp(num(body.temp, 0, 65));
    case 'fan':
      return cmd.fanSpeed(num(body.fan, 1, 3) as 1 | 2 | 3, num(body.percent, 0, 100));
    case 'home':
      return cmd.homeAll();
    case 'jog': {
      if (!['X', 'Y', 'Z'].includes(body.axis)) throw new RangeError('Invalid axis');
      return cmd.jog(body.axis, num(body.distance, -100, 100));
    }
    case 'extrude':
      return cmd.extrude(num(body.distance, -50, 50));
    case 'gcode': {
      const lines = typeof body.gcode === 'string' ? body.gcode.trim() : '';
      if (!lines || lines.length > 4000) throw new RangeError('G-code is empty or too long');
      return cmd.gcode(lines);
    }
    case 'unloadFilament':
      return cmd.unloadFilament();
    case 'loadFilament':
      return cmd.loadFilament(num(body.tray, 0, 254));
    case 'skipObjects': {
      const { state, row } = printer.connection;
      return buildSkipCommand(body.ids, state, jobObjects.peek(row.id, state)?.objects ?? null);
    }
    default:
      throw new RangeError('Unknown action');
  }
}

function skippedObjectsDetail(p: ManagedPrinter, payload: cmd.Command) {
  const ids = (payload.print as { obj_list: number[] }).obj_list;
  const { state, row } = p.connection;
  return describeSkipped(ids, jobObjects.peek(row.id, state)?.objects ?? null);
}

/** Live state (SSE) and printer commands (MQTT). */
export async function controlRoutes(app: FastifyInstance) {
  // Before validation, so anonymous callers get 401 rather than a schema error.
  app.addHook('preValidation', requireAuth);

  // Live state via Server-Sent Events (throttled to ~4 updates/s).
  app.get(
    '/api/printers/:id/events',
    { schema: { params: idParams } },
    withPrinter(async (p, request, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let pending: NodeJS.Timeout | null = null;
      const send = () => {
        pending = null;
        res.write(`data: ${JSON.stringify(printerDetail(p))}\n\n`);
      };
      const schedule = () => {
        pending ??= setTimeout(send, 250);
      };
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);
      send();
      p.connection.on('update', schedule);
      p.camera.on('status', schedule);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        if (pending) clearTimeout(pending);
        p.connection.off('update', schedule);
        p.camera.off('status', schedule);
      });
    }),
  );

  app.post(
    '/api/printers/:id/command',
    { schema: { params: idParams, body: commandBody } },
    withPrinter<CommandRoute>(async (p, request, reply) => {
      let payload: cmd.Command;
      try {
        payload = buildCommand(p, request.body);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      try {
        await p.connection.send(payload);
      } catch (err) {
        return reply.code(503).send({ error: (err as Error).message });
      }
      const body = request.body;
      audit(request, {
        action: 'printer.command',
        detail: {
          printer: p.connection.row.id,
          command: body.action,
          ...(body.action === 'gcode' ? { gcode: String(body.gcode).slice(0, 500) } : {}),
          ...(body.action === 'skipObjects' ? { objects: skippedObjectsDetail(p, payload) } : {}),
        },
      });
      return { ok: true };
    }),
  );
}
