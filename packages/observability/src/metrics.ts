// Metrics surface (SPEC §12.3, ROADMAP #26): a prom-client registry behind
// the small `Metrics` contract so serving code never touches Prometheus
// directly. All series are prefixed `potion_`.
import { createHash } from 'node:crypto';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/** Circuit-breaker states (mirrors SPEC §12.1; re-declared here so this
 * package does not depend on the #24 providers stream landing first). */
export type BreakerState = 'closed' | 'open' | 'half-open';

/** Gauge encoding for `potion_breaker_state`: closed=0, half-open=1, open=2. */
export const BREAKER_STATE_VALUE: Record<BreakerState, number> = {
  closed: 0,
  'half-open': 1,
  open: 2,
};

/**
 * G2.4: metric labels carry the org's 6-char SHA1 prefix, never the raw org
 * id. /metrics is an unauthenticated Prometheus scrape surface by
 * convention, so raw ids there would let any reachable scraper enumerate
 * tenants and their breach/budget activity. The hash is the SAME one the
 * agent-<orgHash6>-* cluster ids already use, so an operator can correlate
 * metrics with cluster ids across surfaces without either exposing the id.
 * DEPLOYMENT NOTE (defense in depth): /metrics must still be
 * network-restricted — see docs/ENTERPRISE.md.
 */
export function orgLabel(orgId: string): string {
  return createHash('sha1').update(orgId).digest('hex').slice(0, 6);
}

export interface Metrics {
  incRequest(route: string, status: number, durationMs: number): void;
  observeProviderCall(p: {
    provider: string;
    model: string;
    durationMs: number;
    costUsd: number;
    error?: string;
  }): void;
  observeFrontierDecision(d: {
    clusterId: string;
    strategyHash: string;
    fallback: boolean;
    provenance: string;
  }): void;
  setBreakerState(key: string, state: BreakerState): void;
  observeShadow?(s: { clusterId: string; sampled: boolean }): void;
  /**
   * P1-3 liveness: who is draining the job queue. `stalled` is the alertable
   * one — work waiting with nothing attached to run it. OPTIONAL so
   * out-of-tree Metrics impls keep compiling.
   */
  setQueueConsumers?(c: { waiting: number; consumers: number; stalled: boolean }): void;
  /** M3 #22 quality guarantee (SPEC §12.5): one increment per guarantee
   * breach incident written. OPTIONAL so out-of-tree Metrics impls keep
   * compiling (NoopMetrics below no-ops it). */
  observeGuaranteeBreach?(b: { orgId: string; action: 'rollback' | 'alert' }): void;
  /** M4 #35 budget autopilot (SPEC §13.7): one increment per budget event
   * emitted by the budget:evaluate worker (post-dedup). OPTIONAL so
   * out-of-tree Metrics impls keep compiling (NoopMetrics no-ops it). */
  observeBudgetEvent?(e: { orgId: string; kind: 'budget_warning' | 'budget_exceeded' }): void;
  /** G2.2 incident SLAs: SLA-bound notification latency observed at the
   * SUCCESSFUL alert POST — now − the emitter-bound clock start (advisory
   * creation on the hierarchy path). OPTIONAL (NoopMetrics no-ops it). */
  observeAlertNotificationLatency?(o: { orgId: string; event: string; latencyMs: number }): void;
  /** G2.2 starved verification: one increment per advisory escalated to
   * 'guarantee currently unverifiable' (post-CAS — the emit winner). */
  observeGuaranteeUnverifiable?(o: { orgId: string }): void;
}

export interface MetricsOptions {
  /** Inject a registry (tests); a fresh one is created otherwise. */
  registry?: Registry;
}

/** Prometheus-backed Metrics. `render()` produces the /metrics text body. */
export class PromMetrics implements Metrics {
  readonly registry: Registry;
  private readonly requestsTotal: Counter<'route' | 'status'>;
  private readonly requestDurationMs: Histogram<'route' | 'status'>;
  private readonly providerCallsTotal: Counter<'provider' | 'model' | 'error'>;
  private readonly providerCallDurationMs: Histogram<'provider' | 'model'>;
  private readonly providerCallCostUsd: Counter<'provider' | 'model'>;
  private readonly frontierDecisionsTotal: Counter<
    'cluster_id' | 'strategy_hash' | 'fallback' | 'provenance'
  >;
  private readonly breakerState: Gauge<'key'>;
  private readonly queueWaiting: Gauge<string>;
  private readonly queueConsumers: Gauge<string>;
  private readonly queueStalled: Gauge<string>;
  private readonly shadowDecisionsTotal: Counter<'cluster_id' | 'sampled'>;
  private readonly guaranteeBreachesTotal: Counter<'org_id' | 'action'>;
  private readonly budgetEventsTotal: Counter<'org_id' | 'kind'>;
  private readonly alertNotificationLatencyMs: Histogram<'org_id' | 'event'>;
  private readonly guaranteeUnverifiableTotal: Counter<'org_id'>;

  constructor(opts: MetricsOptions = {}) {
    this.registry = opts.registry ?? new Registry();
    this.requestsTotal = new Counter({
      name: 'potion_http_requests_total',
      help: 'HTTP requests handled, by route and status code',
      labelNames: ['route', 'status'],
      registers: [this.registry],
    });
    this.requestDurationMs = new Histogram({
      name: 'potion_http_request_duration_ms',
      help: 'HTTP request duration in milliseconds, by route and status code',
      labelNames: ['route', 'status'],
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
      registers: [this.registry],
    });
    this.providerCallsTotal = new Counter({
      name: 'potion_provider_calls_total',
      help: 'Upstream provider calls (complete/embed), by provider/model/outcome',
      labelNames: ['provider', 'model', 'error'],
      registers: [this.registry],
    });
    this.providerCallDurationMs = new Histogram({
      name: 'potion_provider_call_duration_ms',
      help: 'Upstream provider call duration in milliseconds',
      labelNames: ['provider', 'model'],
      buckets: [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
      registers: [this.registry],
    });
    this.providerCallCostUsd = new Counter({
      name: 'potion_provider_call_cost_usd_total',
      help: 'Accumulated USD cost of upstream provider calls',
      labelNames: ['provider', 'model'],
      registers: [this.registry],
    });
    this.frontierDecisionsTotal = new Counter({
      name: 'potion_frontier_decisions_total',
      help: 'Frontier operating-point decisions served, by cluster/strategy/outcome',
      labelNames: ['cluster_id', 'strategy_hash', 'fallback', 'provenance'],
      registers: [this.registry],
    });
    this.breakerState = new Gauge({
      name: 'potion_breaker_state',
      help: 'Circuit-breaker state per (provider,model) key: 0=closed 1=half-open 2=open',
      labelNames: ['key'],
      registers: [this.registry],
    });
    this.queueWaiting = new Gauge({
      name: 'potion_queue_waiting_jobs',
      help: 'Jobs accepted and not yet started',
      registers: [this.registry],
    });
    this.queueConsumers = new Gauge({
      name: 'potion_queue_consumers',
      help: 'Processes attached to the job queue as consumers',
      registers: [this.registry],
    });
    this.queueStalled = new Gauge({
      name: 'potion_queue_stalled',
      help: 'P1-3: 1 when work is waiting and NO consumer is attached to run it',
      registers: [this.registry],
    });
    this.shadowDecisionsTotal = new Counter({
      name: 'potion_shadow_decisions_total',
      help: 'Shadow-mode sampling decisions (ROADMAP #21 contract), by cluster',
      labelNames: ['cluster_id', 'sampled'],
      registers: [this.registry],
    });
    this.guaranteeBreachesTotal = new Counter({
      name: 'potion_guarantee_breaches_total',
      help: 'Quality-guarantee breach incidents (ROADMAP #22 contract), by org and action',
      labelNames: ['org_id', 'action'],
      registers: [this.registry],
    });
    this.budgetEventsTotal = new Counter({
      name: 'potion_budget_events_total',
      help: 'Budget-autopilot events emitted (ROADMAP #35 contract), by org and kind',
      labelNames: ['org_id', 'kind'],
      registers: [this.registry],
    });
    this.alertNotificationLatencyMs = new Histogram({
      name: 'potion_alert_notification_latency_ms',
      help:
        'SLA-bound notification latency: successful alert POST minus the emitter-bound ' +
        'clock start (G2.2; advisory creation on the hierarchy path). Buckets span ' +
        'ms→hours — an advisory→verdict chain legitimately takes hours.',
      labelNames: ['org_id', 'event'],
      buckets: [250, 1000, 5000, 30_000, 60_000, 300_000, 900_000, 3_600_000, 14_400_000],
      registers: [this.registry],
    });
    this.guaranteeUnverifiableTotal = new Counter({
      name: 'potion_guarantee_unverifiable_total',
      help: 'Advisories escalated to guarantee-currently-unverifiable (G2.2 starved verification), by org',
      labelNames: ['org_id'],
      registers: [this.registry],
    });
  }

  incRequest(route: string, status: number, durationMs: number): void {
    const labels = { route, status: String(status) };
    this.requestsTotal.inc(labels);
    this.requestDurationMs.observe(labels, durationMs);
  }

  observeProviderCall(p: {
    provider: string;
    model: string;
    durationMs: number;
    costUsd: number;
    error?: string;
  }): void {
    this.providerCallsTotal.inc({
      provider: p.provider,
      model: p.model,
      error: p.error ?? 'none',
    });
    if (p.error === undefined) {
      // Duration/cost only make sense for answered calls; failures show up in
      // the counter's error label only.
      this.providerCallDurationMs.observe({ provider: p.provider, model: p.model }, p.durationMs);
      this.providerCallCostUsd.inc({ provider: p.provider, model: p.model }, p.costUsd);
    }
  }

  observeFrontierDecision(d: {
    clusterId: string;
    strategyHash: string;
    fallback: boolean;
    provenance: string;
  }): void {
    this.frontierDecisionsTotal.inc({
      cluster_id: d.clusterId,
      strategy_hash: d.strategyHash,
      fallback: d.fallback ? '1' : '0',
      provenance: d.provenance,
    });
  }

  setQueueConsumers(c: { waiting: number; consumers: number; stalled: boolean }): void {
    this.queueWaiting.set(c.waiting);
    this.queueConsumers.set(c.consumers);
    this.queueStalled.set(c.stalled ? 1 : 0);
  }

  setBreakerState(key: string, state: BreakerState): void {
    this.breakerState.set({ key }, BREAKER_STATE_VALUE[state]);
  }

  observeShadow(s: { clusterId: string; sampled: boolean }): void {
    this.shadowDecisionsTotal.inc({
      cluster_id: s.clusterId,
      sampled: s.sampled ? '1' : '0',
    });
  }

  observeGuaranteeBreach(b: { orgId: string; action: 'rollback' | 'alert' }): void {
    this.guaranteeBreachesTotal.inc({ org_id: orgLabel(b.orgId), action: b.action });
  }

  observeBudgetEvent(e: { orgId: string; kind: 'budget_warning' | 'budget_exceeded' }): void {
    this.budgetEventsTotal.inc({ org_id: orgLabel(e.orgId), kind: e.kind });
  }

  observeAlertNotificationLatency(o: { orgId: string; event: string; latencyMs: number }): void {
    this.alertNotificationLatencyMs.observe({ org_id: orgLabel(o.orgId), event: o.event }, o.latencyMs);
  }

  observeGuaranteeUnverifiable(o: { orgId: string }): void {
    this.guaranteeUnverifiableTotal.inc({ org_id: orgLabel(o.orgId) });
  }

  /** Prometheus text exposition for GET /metrics. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }

  /** Content-Type for the /metrics response. */
  get contentType(): string {
    return this.registry.contentType;
  }
}

/** No-op Metrics — same contract, zero cost. Used when metrics are disabled
 * (POTION_METRICS=0) so call sites never need a null check. */
export class NoopMetrics implements Metrics {
  incRequest(): void {}
  observeProviderCall(): void {}
  observeFrontierDecision(): void {}
  setBreakerState(): void {}
  observeShadow(): void {}
  setQueueConsumers(): void {}
  observeGuaranteeBreach(): void {}
  observeBudgetEvent(): void {}
  observeAlertNotificationLatency(): void {}
  observeGuaranteeUnverifiable(): void {}
  async render(): Promise<string> {
    return '';
  }
  get contentType(): string {
    return 'text/plain; version=0.0.4; charset=utf-8';
  }
}

export function createMetrics(opts: MetricsOptions = {}): PromMetrics {
  return new PromMetrics(opts);
}
