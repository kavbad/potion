import { describe, expect, it } from 'vitest';
import { NoopMetrics, PromMetrics, createMetrics } from './index.js';

describe('PromMetrics', () => {
  it('moves request counter + histogram and renders Prometheus text', async () => {
    const m = createMetrics();
    m.incRequest('/v1/chat/completions', 200, 42);
    m.incRequest('/v1/chat/completions', 200, 84);
    m.incRequest('/metrics', 200, 1);
    const text = await m.render();
    expect(text).toContain('potion_http_requests_total');
    expect(text).toContain('potion_http_request_duration_ms');
    expect(text).toContain(
      'potion_http_requests_total{route="/v1/chat/completions",status="200"} 2',
    );
    expect(text).toContain(
      'potion_http_request_duration_ms_count{route="/v1/chat/completions",status="200"} 2',
    );
    expect(text).toContain('potion_http_requests_total{route="/metrics",status="200"} 1');
  });

  it('observes provider calls: counter, duration histogram, cost sum, error label', async () => {
    const m = createMetrics();
    m.observeProviderCall({ provider: 'mock', model: 'mock-mid', durationMs: 900, costUsd: 0.0 });
    m.observeProviderCall({ provider: 'mock', model: 'mock-mid', durationMs: 900, costUsd: 0.5 });
    m.observeProviderCall({
      provider: 'openai',
      model: 'gpt-mini-class',
      durationMs: 12,
      costUsd: 0,
      error: 'ProviderError',
    });
    const text = await m.render();
    expect(text).toContain('potion_provider_calls_total');
    expect(text).toContain('potion_provider_call_duration_ms');
    expect(text).toContain('potion_provider_call_cost_usd_total');
    expect(text).toContain(
      'potion_provider_calls_total{provider="mock",model="mock-mid",error="none"} 2',
    );
    expect(text).toContain(
      'potion_provider_calls_total{provider="openai",model="gpt-mini-class",error="ProviderError"} 1',
    );
    expect(text).toContain('potion_provider_call_cost_usd_total{provider="mock",model="mock-mid"} 0.5');
  });

  it('observes frontier decisions with fallback + provenance labels', async () => {
    const m = createMetrics();
    m.observeFrontierDecision({
      clusterId: 'code-gen',
      strategyHash: 'abc123',
      fallback: false,
      provenance: 'mock',
    });
    m.observeFrontierDecision({
      clusterId: 'code-gen',
      strategyHash: 'def456',
      fallback: true,
      provenance: 'blocked',
    });
    const text = await m.render();
    expect(text).toContain(
      'potion_frontier_decisions_total{cluster_id="code-gen",strategy_hash="abc123",fallback="0",provenance="mock"} 1',
    );
    expect(text).toContain(
      'potion_frontier_decisions_total{cluster_id="code-gen",strategy_hash="def456",fallback="1",provenance="blocked"} 1',
    );
  });

  it('sets the breaker-state gauge (closed=0, half-open=1, open=2)', async () => {
    const m = createMetrics();
    m.setBreakerState('openai:gpt-mini-class', 'closed');
    m.setBreakerState('anthropic:haiku-class', 'open');
    m.setBreakerState('google:gemini-flash-class', 'half-open');
    const text = await m.render();
    expect(text).toContain('potion_breaker_state{key="openai:gpt-mini-class"} 0');
    expect(text).toContain('potion_breaker_state{key="google:gemini-flash-class"} 1');
    expect(text).toContain('potion_breaker_state{key="anthropic:haiku-class"} 2');
  });

  it('observes shadow sampling decisions (#21 contract)', async () => {
    const m = createMetrics();
    m.observeShadow?.({ clusterId: 'code-gen', sampled: true });
    m.observeShadow?.({ clusterId: 'code-gen', sampled: false });
    const text = await m.render();
    expect(text).toContain('potion_shadow_decisions_total{cluster_id="code-gen",sampled="1"} 1');
    expect(text).toContain('potion_shadow_decisions_total{cluster_id="code-gen",sampled="0"} 1');
  });

  it('counts guarantee breach incidents by org + action (#22 contract)', async () => {
    const m = createMetrics();
    m.observeGuaranteeBreach?.({ orgId: 'org_demo', action: 'rollback' });
    m.observeGuaranteeBreach?.({ orgId: 'org_demo', action: 'rollback' });
    m.observeGuaranteeBreach?.({ orgId: 'org_demo', action: 'alert' });
    const text = await m.render();
    expect(text).toContain('potion_guarantee_breaches_total{org_id="org_demo",action="rollback"} 2');
    expect(text).toContain('potion_guarantee_breaches_total{org_id="org_demo",action="alert"} 1');
  });

  it('uses an injected registry when provided', async () => {
    const { Registry } = await import('prom-client');
    const registry = new Registry();
    const m = new PromMetrics({ registry });
    m.incRequest('/y', 200, 1);
    const text = await registry.metrics();
    expect(text).toContain('potion_http_requests_total{route="/y",status="200"} 1');
  });
});

describe('NoopMetrics', () => {
  it('implements the contract without throwing and renders empty', async () => {
    const m = new NoopMetrics();
    m.incRequest('/x', 500, 1);
    m.observeProviderCall({ provider: 'p', model: 'm', durationMs: 1, costUsd: 1 });
    m.observeFrontierDecision({ clusterId: 'c', strategyHash: 's', fallback: true, provenance: 'mock' });
    m.setBreakerState('k', 'open');
    m.observeShadow?.({ clusterId: 'c', sampled: true });
    m.observeGuaranteeBreach?.({ orgId: 'o', action: 'rollback' });
    expect(await m.render()).toBe('');
  });
});
