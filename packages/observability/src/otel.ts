// initObservability (SPEC §12.3): one entry point that returns a handle with
// a `meter` (Metrics) and an async `shutdown()`.
//
// CRITICAL contract: importing this package must NEVER require the
// OpenTelemetry packages — they are optionalDependencies and are only
// lazy-dynamic-imported when `otlpEndpoint` is set. If the import fails
// (otel packages not installed), we warn ONCE and continue serving.
import { NoopMetrics, PromMetrics, type Metrics } from './metrics.js';

export interface ObservabilityOptions {
  serviceName: string;
  otlpEndpoint?: string;
  /** Metrics on/off (default ON when called — the server gates this with
   * POTION_METRICS). false → NoopMetrics + no /metrics series. */
  metrics?: boolean;
}

export interface ObservabilityHandle {
  shutdown(): Promise<void>;
  meter: Metrics;
  /** Prometheus text exposition for GET /metrics. */
  metricsText(): Promise<string>;
  /** Content-Type for the /metrics response. */
  readonly metricsContentType: string;
  /** true when the OTel SDK actually started (false when disabled or when
   * the optional otel deps are missing). */
  readonly otelActive: boolean;
}

interface OtelSdkLike {
  start(): void | Promise<void>;
  shutdown(): Promise<void>;
}

let warnedOtelMissing = false;

/** Reset the warn-once latch (tests only). */
export function resetOtelWarningForTests(): void {
  warnedOtelMissing = false;
}

/** Dynamic import with an unanalyzable specifier so tsc never tries to
 * resolve the optional otel packages at compile time. */
async function importOptional(name: string): Promise<Record<string, any>> {
  return (await import(/* @vite-ignore */ name)) as Record<string, any>;
}

type OptionalImporter = (name: string) => Promise<Record<string, any>>;

/** Lazily start the OTel SDK. Never throws — failure mode is warn-once +
 * continue without tracing (SPEC §12.3: dependency is optional). The
 * importer is injectable so tests can simulate the optional otel packages
 * being absent without uninstalling anything. */
export async function startOtelSdk(
  serviceName: string,
  otlpEndpoint: string,
  warn: (msg: string) => void,
  importer: OptionalImporter = importOptional,
): Promise<OtelSdkLike | null> {
  try {
    const sdkMod = await importer('@opentelemetry/sdk-node');
    const autoMod = await importer('@opentelemetry/auto-instrumentations-node');
    const { NodeSDK } = sdkMod;
    const { getNodeAutoInstrumentations } = autoMod;
    if (typeof NodeSDK !== 'function' || typeof getNodeAutoInstrumentations !== 'function') {
      throw new Error('otel packages loaded but expected exports are missing');
    }
    // The OTLP endpoint travels via the standard env vars — sdk-node's
    // default OTLP exporters read OTEL_EXPORTER_OTLP_ENDPOINT themselves.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? otlpEndpoint;
    process.env.OTEL_SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? serviceName;
    const sdk = new NodeSDK({ instrumentations: [getNodeAutoInstrumentations()] }) as OtelSdkLike;
    await sdk.start();
    return sdk;
  } catch (err) {
    if (!warnedOtelMissing) {
      warnedOtelMissing = true;
      warn(
        `observability: otlpEndpoint set but OTel SDK could not be started ` +
          `(${(err as Error).message}) — continuing WITHOUT tracing. ` +
          `Install @opentelemetry/sdk-node + @opentelemetry/auto-instrumentations-node to enable.`,
      );
    }
    return null;
  }
}

export function initObservability(opts: ObservabilityOptions): ObservabilityHandle {
  const warn = (msg: string): void => {
    // console.warn is the pre-logger channel; the server re-warns via pino.
    console.warn(`[potion] ${msg}`);
  };
  const meter: PromMetrics | NoopMetrics =
    opts.metrics === false ? new NoopMetrics() : new PromMetrics();

  let sdkPromise: Promise<OtelSdkLike | null> | null = null;
  let sdkKnownActive = false;
  if (opts.otlpEndpoint) {
    sdkPromise = startOtelSdk(opts.serviceName, opts.otlpEndpoint, warn);
    void sdkPromise.then((sdk) => {
      sdkKnownActive = sdk !== null;
    });
  }

  return {
    meter,
    metricsText: () => meter.render(),
    get metricsContentType(): string {
      return meter.contentType;
    },
    get otelActive(): boolean {
      return sdkKnownActive;
    },
    shutdown: async () => {
      if (sdkPromise) {
        const sdk = await sdkPromise;
        sdkPromise = null;
        if (sdk) await sdk.shutdown();
      }
    },
  };
}
