import type { FastifyInstance } from 'fastify';
import * as cmd from '../bambu/commands.ts';
import { describeSkipped, skippableIds } from '../bambu/job-objects.ts';
import { supportsChamberControl } from '../bambu/models.ts';
import { audit } from '../audit.ts';
import type { ManagedPrinter } from '../manager.ts';
import { idParams } from '../validation.ts';
import { COMMANDS, type PrinterCommand } from '../../shared/commands.ts';
import { HttpError } from '../http-error.ts';
import { printerDetail, withPrinter, type PrinterRoute } from './shared.ts';

/**
 * One `oneOf` branch per action of the command table, selected by the `action`
 * discriminator: which fields each action takes, their types and ranges, and
 * nothing else.
 */
const commandBody = {
  type: 'object',
  required: ['action'],
  discriminator: { propertyName: 'action' },
  errorMessage: { required: 'Unknown action', discriminator: 'Unknown action' },
  oneOf: Object.entries(COMMANDS).map(([action, params]) => {
    const fields = Object.entries(params as Record<string, { schema: object; optional: boolean }>);
    return {
      type: 'object',
      properties: { action: { const: action }, ...Object.fromEntries(fields.map(([name, p]) => [name, p.schema])) },
      required: ['action', ...fields.filter(([, p]) => !p.optional).map(([name]) => name)],
      additionalProperties: false,
    };
  }),
};

interface CommandRoute extends PrinterRoute {
  Body: PrinterCommand;
}

/**
 * Translate a validated UI command into its MQTT payload, with the checks
 * that depend on the printer. `detail` is added to the audit entry.
 */
function buildCommand(printer: ManagedPrinter, command: PrinterCommand): { payload: cmd.Command; detail?: object } {
  const { row, state } = printer.connection;
  switch (command.action) {
    case 'refresh':
      return { payload: cmd.pushAll() };
    case 'pause':
      return { payload: cmd.pause() };
    case 'resume':
      return { payload: cmd.resume() };
    case 'stop':
      return { payload: cmd.stop() };
    case 'speed':
      return { payload: cmd.printSpeed(command.level) };
    case 'light':
      return { payload: cmd.light(command.node, command.on) };
    case 'nozzleTemp':
      return {
        payload:
          command.extruder === undefined
            ? cmd.nozzleTemp(command.temp)
            : cmd.nozzleTempIndexed(command.extruder, command.temp),
      };
    case 'bedTemp':
      return { payload: cmd.bedTemp(command.temp) };
    case 'chamberTemp':
      if (!supportsChamberControl(row.model)) throw new HttpError(400, 'This printer has no chamber heater');
      return { payload: cmd.chamberTemp(command.temp) };
    case 'fan':
      return { payload: cmd.fanSpeed(command.fan, command.percent) };
    case 'home':
      return { payload: cmd.homeAll() };
    case 'jog':
      return { payload: cmd.jog(command.axis, command.distance) };
    case 'extrude':
      return { payload: cmd.extrude(command.distance) };
    case 'gcode':
      return { payload: cmd.gcode(command.gcode.trim()), detail: { gcode: command.gcode.slice(0, 500) } };
    case 'unloadFilament':
      return { payload: cmd.unloadFilament() };
    case 'loadFilament':
      return { payload: cmd.loadFilament(command.tray) };
    case 'skipObjects': {
      const known = printer.jobObjects.peek(state)?.objects ?? null;
      const ids = skippableIds(command.ids, state, known);
      return { payload: cmd.skipObjects(ids), detail: { objects: describeSkipped(ids, known) } };
    }
  }
}

/** Live state (SSE) and printer commands (MQTT). */
export async function controlRoutes(app: FastifyInstance) {
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
      const { payload, detail } = buildCommand(p, request.body);
      await p.connection.send(payload);
      audit(request, {
        action: 'printer.command',
        detail: { printer: p.connection.row.id, command: request.body.action, ...detail },
      });
      return { ok: true };
    }),
  );
}
