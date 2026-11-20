import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { config } from './config.ts';

/** The app's logger, shared by Fastify and every module (startup, printers, push, audit). */
export const log: FastifyBaseLogger = pino({
  level: config.logLevel,
  redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
});
