import type { FastifyServerOptions, FastifySchemaValidationError } from 'fastify';

type SchemaErrorDataVar = 'body' | 'headers' | 'params' | 'querystring';

/**
 * Request validation with Fastify's built-in Ajv (route `schema` options).
 *
 * Ajv runs after the CSRF hook and the route's `preValidation` auth hook, so an
 * unauthenticated caller gets 401 — never a 400 that describes the schema.
 */

/**
 * Overrides of Fastify's Ajv defaults:
 * - no type coercion: JSON bodies must carry the right types (params and query
 *   strings stay strings and are checked with patterns);
 * - `additionalProperties: false` rejects unknown fields instead of silently
 *   dropping them;
 * - `discriminator` picks the `oneOf` branch from a tag (the command `action`),
 *   so errors come from that branch instead of every alternative;
 * - `errorMessage` is an annotation keyword holding the user-facing message for
 *   a property (read by `formatValidationError`, ignored by Ajv); `verbose`
 *   exposes it on each error as `parentSchema`.
 */
export const ajvOptions: FastifyServerOptions['ajv'] = {
  customOptions: {
    coerceTypes: false,
    removeAdditional: false,
    discriminator: true,
    allowUnionTypes: true,
    verbose: true,
    keywords: ['errorMessage'],
  },
};

/** `errorMessage` is either one message or one per failing keyword. */
type ErrorMessage = string | Record<string, string>;
type Schema = { errorMessage?: ErrorMessage; properties?: Record<string, Schema> };

const SOURCES: Record<string, string> = { body: 'field', querystring: 'query parameter', params: 'URL parameter' };

function pick(message: ErrorMessage | undefined, keyword: string) {
  return typeof message === 'string' ? message : message?.[keyword];
}

function describeType(type: unknown) {
  const names = (Array.isArray(type) ? type : [type]).map((t) =>
    t === 'integer' ? 'an integer' : t === 'object' ? 'an object' : t === 'array' ? 'a list' : t === 'null' ? 'null' : `a ${t}`,
  );
  return names.join(' or ');
}

/** One Ajv error → one sentence the UI can toast as-is (never a raw Ajv dump). */
function describe(error: FastifySchemaValidationError & { parentSchema?: Schema }, dataVar: string): string {
  const { keyword, params } = error;
  const parent = error.parentSchema;
  const path = error.instancePath.split('/').filter(Boolean).join('.');

  if (keyword === 'required') {
    const missing = String(params.missingProperty);
    const custom = pick(parent?.properties?.[missing]?.errorMessage, 'required') ?? pick(parent?.errorMessage, 'required');
    return custom ?? `Missing ${SOURCES[dataVar] ?? 'field'} "${path ? `${path}.` : ''}${missing}"`;
  }
  const custom = pick(parent?.errorMessage, keyword);
  if (custom) return custom;

  if (!path) {
    if (keyword === 'type' && dataVar === 'body') return 'Request body must be a JSON object';
    if (keyword === 'additionalProperties') return `Unknown ${SOURCES[dataVar] ?? 'field'} "${params.additionalProperty}"`;
    return `Invalid request ${dataVar === 'querystring' ? 'query' : dataVar}`;
  }
  const field = `"${path}"`;
  switch (keyword) {
    case 'additionalProperties':
      return `Unknown field "${path}.${params.additionalProperty}"`;
    case 'type':
      return `${field} must be ${describeType(params.type)}`;
    case 'maxLength':
      return `${field} must be at most ${params.limit} characters`;
    case 'minLength':
      return `${field} must be at least ${params.limit} characters`;
    case 'maximum':
      return `${field} must be at most ${params.limit}`;
    case 'minimum':
      return `${field} must be at least ${params.limit}`;
    case 'maxItems':
      return `${field} must have at most ${params.limit} items`;
    case 'minItems':
      return `${field} must have at least ${params.limit} items`;
    case 'enum':
      return `${field} must be one of: ${(params.allowedValues as unknown[]).join(', ')}`;
    default:
      return `${field} is invalid`;
  }
}

/** Fastify `schemaErrorFormatter`: the 400 body becomes `{ error: <sentence> }` via the app error handler. */
export function formatValidationError(errors: FastifySchemaValidationError[], dataVar: SchemaErrorDataVar) {
  return new Error(errors.length ? describe(errors[0], dataVar) : 'Invalid request');
}

// --- shared schema fragments ---

/** Database row ids in URLs: positive integers, written plainly (no sign, no leading zero). */
export const idString = { type: 'string', pattern: '^[1-9][0-9]{0,14}$', errorMessage: 'Invalid id' } as const;

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: idString },
} as const;

/** `?path=` on printer storage; `safeRemotePath` still rejects traversal and control characters. */
export const remotePathQuery = {
  type: 'object',
  properties: { path: { type: 'string', maxLength: 1024, errorMessage: 'Invalid path' } },
} as const;

export interface IdParams {
  id: string;
}

export interface RemotePathQuery {
  path?: string;
}
