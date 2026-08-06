// packages/observability public surface (SPEC §12.3, ROADMAP #26).
export {
  BREAKER_STATE_VALUE,
  NoopMetrics,
  PromMetrics,
  createMetrics,
  type BreakerState,
  type Metrics,
  type MetricsOptions,
} from './metrics.js';
export {
  initObservability,
  resetOtelWarningForTests,
  startOtelSdk,
  type ObservabilityHandle,
  type ObservabilityOptions,
} from './otel.js';
export {
  REDACT_PATHS,
  REQUEST_ID_HEADER,
  createLoggerOptions,
  genRequestId,
  type LoggerOptions,
} from './logger.js';
export { observabilityPlugin, type ObservabilityPluginOptions } from './plugin.js';
export { withMetrics, type WithMetricsOptions } from './with-metrics.js';
