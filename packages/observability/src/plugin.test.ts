// observabilityPlugin contract tests (SPEC §12.3): request counting,
// duration histogram, GET /metrics in Prometheus text format, and the
// x-request-id echo (inbound preserved, absent → uuid generated + echoed).
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLoggerOptions,
  genRequestId,
  initObservability,
  observabilityPlugin,
} from './index.js';

async function build(opts: { metrics?: boolean } = {}): Promise<FastifyInstance> {
  const handle = initObservability({ serviceName: 'test-svc' });
  const app = Fastify({
    logger: false,
    genReqId: genRequestId,
    requestIdHeader: 'x-request-id',
  });
  app.get('/ping', async () => ({ ok: true }));
  observabilityPlugin(app, { handle, ...(opts.metrics !== undefined ? { metrics: opts.metrics } : {}) });
  app.addHook('onClose', async () => handle.shutdown());
  return app;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('observabilityPlugin', () => {
  it('preserves an inbound x-request-id and echoes it on the response', async () => {
    app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { 'x-request-id': 'req-inbound-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-inbound-123');
  });

  it('generates a uuid when x-request-id is absent and echoes it', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/ping' });
    const id = res.headers['x-request-id'];
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('GET /metrics returns Prometheus text with request series', async () => {
    app = await build();
    await app.inject({ method: 'GET', url: '/ping' });
    await app.inject({ method: 'GET', url: '/ping' });
    // First /metrics scrape (this scrape itself is counted only AFTER the
    // response completes, so the second scrape observes it).
    const first = await app.inject({ method: 'GET', url: '/metrics' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('text/plain');
    expect(first.body).toContain('potion_http_requests_total');
    expect(first.body).toContain('potion_http_request_duration_ms');
    expect(first.body).toContain('potion_http_requests_total{route="/ping",status="200"} 2');
    const second = await app.inject({ method: 'GET', url: '/metrics' });
    expect(second.body).toContain('potion_http_requests_total{route="/metrics",status="200"} 1');
  });

  it('does not register /metrics when metrics are disabled', async () => {
    app = await build({ metrics: false });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
    const ping = await app.inject({ method: 'GET', url: '/ping' });
    expect(ping.statusCode).toBe(200);
  });

  it('records 404s under the unmatched label, not the raw URL', async () => {
    app = await build();
    await app.inject({ method: 'GET', url: '/nope-1' });
    await app.inject({ method: 'GET', url: '/nope-2' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('potion_http_requests_total{route="unmatched",status="404"} 2');
    expect(res.body).not.toContain('/nope-1');
  });
});

describe('createLoggerOptions + Fastify', () => {
  it('Fastify accepts the pino config and child loggers carry reqId', async () => {
    app = Fastify({
      logger: createLoggerOptions('test-svc', { level: 'silent' }),
      genReqId: genRequestId,
      requestIdHeader: 'x-request-id',
    });
    let seenId: string | undefined;
    app.get('/ping', async (req) => {
      seenId = req.log.bindings().reqId as string;
      return { ok: true };
    });
    const handle = initObservability({ serviceName: 'test-svc' });
    observabilityPlugin(app, { handle });
    app.addHook('onClose', async () => handle.shutdown());
    const res = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { 'x-request-id': 'req-child-9' },
    });
    expect(res.statusCode).toBe(200);
    expect(seenId).toBe('req-child-9');
    expect(res.headers['x-request-id']).toBe('req-child-9');
  });
});
