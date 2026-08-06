// pino structured logging config (SPEC §12.3) — handed to Fastify via its
// `logger` option. Two hard guarantees:
//   1. credentials are redacted: req authorization/cookie headers and the
//      res set-cookie header never reach the log stream (pino redact);
//   2. every request is correlated: Fastify's request-id is the inbound
//      `x-request-id` when present, else a generated uuid, and is echoed
//      back on the response (see plugin.ts / genRequestId below).
import { randomUUID } from 'node:crypto';
import type { FastifyServerOptions } from 'fastify';

/** Header Fastify reads for the request id (Fastify `requestIdHeader`). */
export const REQUEST_ID_HEADER = 'x-request-id';

/** pino redaction paths — NEVER log key material or cookies (SPEC §12.3). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
] as const;

/** Generate a request id when the inbound x-request-id header is absent. */
export function genRequestId(): string {
  return randomUUID();
}

export interface LoggerOptions {
  /** pino level (default: POTION_LOG_LEVEL env, else 'info'). */
  level?: string;
}

/**
 * pino options for Fastify's `logger` option. Redaction is built in; the
 * `base` binds the service name; `messageKey` keeps Fastify's default 'msg'.
 */
export function createLoggerOptions(
  serviceName: string,
  opts: LoggerOptions = {},
): NonNullable<Exclude<FastifyServerOptions['logger'], boolean>> {
  return {
    level: opts.level ?? process.env.POTION_LOG_LEVEL ?? 'info',
    base: { service: serviceName },
    redact: { paths: [...REDACT_PATHS], censor: '[Redacted]' },
  };
}
