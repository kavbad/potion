// pino redaction + request-id contract tests (SPEC §12.3). The redaction
// config is exercised DIRECTLY through pino (no Fastify needed): the same
// options object is what Fastify receives via its `logger` option.
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  REDACT_PATHS,
  REQUEST_ID_HEADER,
  createLoggerOptions,
  genRequestId,
} from './index.js';

const SECRET_KEY = 'sk-live-SECRET-key-material-12345';
const SECRET_COOKIE = 'session=topsecretcookievalue';

function capture(): { stream: Writable; lines: () => string[] } {
  const buf: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => buf };
}

describe('createLoggerOptions redaction', () => {
  it('redacts authorization/cookie request headers and set-cookie response headers', () => {
    const { stream, lines } = capture();
    const log = pino(createLoggerOptions('test-svc'), stream);
    log.info({
      req: {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${SECRET_KEY}`,
          cookie: SECRET_COOKIE,
          'content-type': 'application/json',
        },
      },
      res: {
        statusCode: 200,
        headers: { 'set-cookie': ['session=newsecret; HttpOnly'] },
      },
    });
    const out = lines().join('');
    // No key material or cookie values anywhere in the output.
    expect(out).not.toContain(SECRET_KEY);
    expect(out).not.toContain('topsecretcookievalue');
    expect(out).not.toContain('newsecret');
    // The redaction marker is present for each path.
    expect(out).toContain('[Redacted]');
    const parsed = JSON.parse(lines()[0]!);
    expect(parsed.req.headers.authorization).toBe('[Redacted]');
    expect(parsed.req.headers.cookie).toBe('[Redacted]');
    expect(parsed.res.headers['set-cookie']).toBe('[Redacted]');
    // Non-sensitive fields survive.
    expect(parsed.req.headers['content-type']).toBe('application/json');
    expect(parsed.service).toBe('test-svc');
  });

  it('declares exactly the SPEC §12.3 redact paths', () => {
    expect([...REDACT_PATHS]).toEqual([
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
    ]);
  });
});

describe('request id', () => {
  it('genRequestId produces uuids; header name is x-request-id', () => {
    const a = genRequestId();
    const b = genRequestId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });
});
