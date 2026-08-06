// Metrics surface (SPEC §12.3, ROADMAP #26): a prom-client registry behind
// the small `Metrics` contract so serving code never touches Prometheus
// directly. All series are prefixed `potion_`.
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
  /** M3 #22 quality guarantee (SPEC §12.5): one increment per guarantee
   * breach incident written. OPTIONAL so out-of-tree Metrics impls keep
   * compiling (NoopMetrics below no-ops it). */
  observeGuaranteeBreach?(b: { orgId: string; action: 'rollback' | 'alert' }): void;
  /** M4 #35 budget autopilot (SPEC §13.7): one increment per budget event
   * emitted by the budget:evaluate worker (post-dedup). OPTIONAL so
   * out-of-tree Metrics impls keep compiling (NoopMetrics no-ops it). */
  observeBudgetEvent?(e: { orgId: string; kind: 'budget_warning' | 'budget_exceeded' }): void;
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
  private readonly shadowDecisionsTotal: Counter<'cluster_id' | 'sampled'>;
  private readonly guaranteeBreachesTotal: Counter<'org_id' | 'action'>;
  private readonly budgetEventsTotal: Counter<'org_id' | 'kind'>;

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
    this.guaranteeBreachesTotal.inc({ org_id: b.orgId, action: b.action });
  }

  observeBudgetEvent(e: { orgId: string; kind: 'budget_warning' | 'budget_exceeded' }): void {
    this.budgetEventsTotal.inc({ org_id: e.orgId, kind: e.kind });
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
  observeGuaranteeBreach(): void {}
  observeBudgetEvent(): void {}
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
