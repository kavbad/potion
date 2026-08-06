// OTel contract tests (SPEC §12.3): the no-endpoint path is a total no-op,
// and a failing otel import (packages absent) warns ONCE and never crashes.
// This test file itself proves the static-import-safety contract: importing
// the package index must not require @opentelemetry/* to be present.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initObservability,
  resetOtelWarningForTests,
  startOtelSdk,
} from './index.js';

afterEach(() => {
  resetOtelWarningForTests();
  vi.restoreAllMocks();
});

describe('initObservability without otlpEndpoint', () => {
  it('is a no-op: no SDK import attempted, shutdown resolves, meter works', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = initObservability({ serviceName: 'test-svc' });
    expect(handle.otelActive).toBe(false);
    handle.meter.incRequest('/x', 200, 5);
    const text = await handle.metricsText();
    expect(text).toContain('potion_http_requests_total');
    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('metrics:false → NoopMetrics (empty exposition)', async () => {
    const handle = initObservability({ serviceName: 'test-svc', metrics: false });
    handle.meter.incRequest('/x', 200, 5);
    expect(await handle.metricsText()).toBe('');
    await handle.shutdown();
  });
});

describe('startOtelSdk with a failing import (otel packages absent)', () => {
  const failingImporter = (name: string): Promise<Record<string, any>> =>
    Promise.reject(new Error(`Cannot find package '${name}'`));

  it('returns null, warns, and never throws', async () => {
    const warns: string[] = [];
    const sdk = await startOtelSdk('svc', 'http://localhost:4318', (m) => warns.push(m), failingImporter);
    expect(sdk).toBeNull();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('continuing WITHOUT tracing');
    expect(warns[0]).toContain('Cannot find package');
  });

  it('warns exactly ONCE across repeated attempts (warn-once latch)', async () => {
    const warns: string[] = [];
    await startOtelSdk('svc', 'http://localhost:4318', (m) => warns.push(m), failingImporter);
    await startOtelSdk('svc', 'http://localhost:4318', (m) => warns.push(m), failingImporter);
    await startOtelSdk('svc', 'http://localhost:4318', (m) => warns.push(m), failingImporter);
    expect(warns).toHaveLength(1);
  });

  it('a server built on a failed-import handle still serves metrics', async () => {
    const warns: string[] = [];
    // Simulate what initObservability does when the import fails: a null SDK
    // with a working meter.
    const sdk = await startOtelSdk('svc', 'http://localhost:4318', (m) => warns.push(m), failingImporter);
    expect(sdk).toBeNull();
    const handle = initObservability({ serviceName: 'svc' });
    handle.meter.incRequest('/v1/chat/completions', 200, 10);
    expect(await handle.metricsText()).toContain('potion_http_requests_total');
    await handle.shutdown();
  });
});

describe('startOtelSdk with a stub SDK (import succeeds)', () => {
  it('starts the SDK and shutdown() drains it', async () => {
    const started: string[] = [];
    let shutdowns = 0;
    const stubImporter = (name: string): Promise<Record<string, any>> => {
      if (name === '@opentelemetry/sdk-node') {
        return Promise.resolve({
          NodeSDK: class {
            start(): void {
              started.push('start');
            }
            async shutdown(): Promise<void> {
              shutdowns += 1;
            }
          },
        });
      }
      return Promise.resolve({ getNodeAutoInstrumentations: () => [] });
    };
    const sdk = await startOtelSdk('svc', 'http://localhost:4318', () => {}, stubImporter);
    expect(sdk).not.toBeNull();
    expect(started).toEqual(['start']);
    await sdk!.shutdown();
    expect(shutdowns).toBe(1);
  });
});
