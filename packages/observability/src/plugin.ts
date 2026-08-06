// observabilityPlugin (SPEC §12.3): attaches the metrics hooks + GET
// /metrics + x-request-id echo to a Fastify instance.
//
// This is a DIRECT-ATTACH plugin: call `observabilityPlugin(app, opts)` (not
// app.register) so the hooks apply to ALL routes on the instance regardless
// of registration order (register() would encapsulate the hooks).
import { performance } from 'node:perf_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ObservabilityHandle } from './otel.js';
import { REQUEST_ID_HEADER } from './logger.js';

export interface ObservabilityPluginOptions {
  handle: ObservabilityHandle;
  /** When false, GET /metrics is NOT registered (default true — the server
   * gates this on POTION_METRICS). Request hooks still run; with a
   * NoopMetrics meter they are free. */
  metrics?: boolean;
}

const startTimes = new WeakMap<FastifyRequest, number>();

/** Route label for metrics: the matched route pattern, else 'unmatched'
 * (404s) — never the raw URL (unbounded cardinality). */
function routeLabel(req: FastifyRequest): string {
  return req.routeOptions?.url ?? 'unmatched';
}

export function observabilityPlugin(app: FastifyInstance, opts: ObservabilityPluginOptions): void {
  const { handle } = opts;
  const metricsEnabled = opts.metrics !== false;
  const meter = handle.meter;

  app.addHook('onRequest', async (req) => {
    startTimes.set(req, performance.now());
  });

  // Echo the request id back (Fastify already honored the inbound header /
  // generated a uuid via genReqId — see server.ts wiring).
  app.addHook('onSend', async (req, reply) => {
    if (!reply.hasHeader(REQUEST_ID_HEADER)) {
      void reply.header(REQUEST_ID_HEADER, req.id);
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    const t0 = startTimes.get(req);
    const durationMs = t0 === undefined ? 0 : performance.now() - t0;
    meter.incRequest(routeLabel(req), reply.statusCode, durationMs);
  });

  if (metricsEnabled) {
    app.get('/metrics', async (_req, reply) => {
      const body = await handle.metricsText();
      return reply.type(handle.metricsContentType).send(body);
    });
  }
}
