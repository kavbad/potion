// 13a §10 pins this: the Sentry init MUST be a no-op when SENTRY_DSN is
// unset — every test/dev/walkthrough environment depends on that — and must
// initialize exactly once when set.
import { afterEach, describe, expect, it, vi } from 'vitest';

const init = vi.fn();
vi.mock('@sentry/node', () => ({ init }));

import { initSentry, resetSentryForTests } from '../src/sentry.js';

afterEach(() => {
  init.mockClear();
  resetSentryForTests();
});

describe('initSentry', () => {
  it('is a NO-OP when the DSN is unset or blank', async () => {
    expect(await initSentry(undefined)).toBe(false);
    expect(await initSentry('')).toBe(false);
    expect(await initSentry('   ')).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('initializes once with the DSN, tracing off', async () => {
    expect(await initSentry('https://key@example.ingest.sentry.io/1')).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0]![0]).toMatchObject({
      dsn: 'https://key@example.ingest.sentry.io/1',
      tracesSampleRate: 0,
    });
  });

  it('a second call is idempotent — one SDK init per process', async () => {
    await initSentry('https://key@example.ingest.sentry.io/1');
    await initSentry('https://key@example.ingest.sentry.io/1');
    expect(init).toHaveBeenCalledTimes(1);
  });
});
