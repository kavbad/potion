// THE ROUTE INVENTORY (G2.3, owner requirement) — every route the server
// registers, enumerated and classified. This is a SHARED FIXTURE:
//   · G2.3 (key-role-split.test.ts) asserts a plain 'serve' api key gets 403
//     on EVERY admin-guarded mutating /api route, and that this list matches
//     the live fastify route tree BOTH ways (a route added without a row
//     here fails the suite — the 20th site next month is caught by design).
//   · G2.4 (tenancy + self-serve-posture sweep) extends the SAME rows with
//     additional lenses (tenancy class, self-serve posture) — add fields,
//     don't fork the list.
//
// guard vocabulary (what the route requires of the caller):
//   'admin'    — role admin (session admin / serve+admin api key / dev bypass)
//   'member'   — role member+ (any org api key, member+ session)
//   'viewer'   — any authenticated org credential (reads)
//   'serve'    — a valid api key on the /v1 serving surface
//   'operator' — the POTION_OPERATOR_TOKEN bearer (fail-closed surface)
//   'public'   — unauthenticated by design
// `probeBody` is a minimal VALID payload so admin-gate probes reach the role
// check (not a 400) on routes that validate before guarding.

export interface RouteInventoryRow {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** fastify-registered form, e.g. '/api/incidents/:id/resolve'. */
  path: string;
  surface: 'api' | 'v1' | 'auth' | 'operator' | 'infra';
  mutating: boolean;
  guard: 'admin' | 'member' | 'viewer' | 'serve' | 'operator' | 'public';
  /** Concrete URL for probing (params filled with syntactically-valid ids). */
  probeUrl?: string;
  probeBody?: Record<string, unknown>;
  notes?: string;
}

export const ROUTE_INVENTORY: RouteInventoryRow[] = [
  // ---- infra ----
  { method: 'GET', path: '/healthz', surface: 'infra', mutating: false, guard: 'public' },
  { method: 'GET', path: '/readyz', surface: 'infra', mutating: false, guard: 'public' },
  { method: 'GET', path: '/metrics', surface: 'infra', mutating: false, guard: 'public' },

  // ---- /v1 serving surface (scopes deliberately NOT enforced here) ----
  { method: 'POST', path: '/v1/chat/completions', surface: 'v1', mutating: true, guard: 'serve' },
  { method: 'POST', path: '/v1/completions', surface: 'v1', mutating: true, guard: 'serve' },
  { method: 'POST', path: '/v1/embeddings', surface: 'v1', mutating: true, guard: 'serve' },
  { method: 'GET', path: '/v1/models', surface: 'v1', mutating: false, guard: 'serve' },
  { method: 'GET', path: '/v1/policies', surface: 'v1', mutating: false, guard: 'serve' },
  {
    method: 'POST', path: '/v1/policies', surface: 'v1', mutating: true, guard: 'serve',
    notes: "G2.3 DELIBERATE: rebinds the CALLING key's OWN policy only — self-scoped onboarding mutation, stays serve-reachable",
  },
  { method: 'POST', path: '/v1/traces', surface: 'v1', mutating: true, guard: 'serve' },

  // ---- /api reads (viewer+) ----
  { method: 'GET', path: '/api/frontiers', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/frontiers/:clusterId', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/endpoint-snippet', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/usage', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/usage/current', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/usage/export.csv', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/usage/invoice', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/keys', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/keys/:id/audit', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/api-keys', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/alerts', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/alerts/deliveries', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/jobs/:id', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/guarantee/status', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/guarantee/clusters/:clusterId/incumbent', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/reports/savings', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/reports/savings.csv', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/reports/guarantee', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/research/cycles', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/recipes', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/rubrics', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/share', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/budgets', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/traces', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/traces/retention', surface: 'api', mutating: false, guard: 'viewer' },
  { method: 'GET', path: '/api/traces/:traceId', surface: 'api', mutating: false, guard: 'viewer' },

  // ---- /api public exemptions (hook-level carve-outs) ----
  { method: 'GET', path: '/api/public/share/:token/frontier', surface: 'api', mutating: false, guard: 'public' },
  { method: 'GET', path: '/api/public/share/:token/report', surface: 'api', mutating: false, guard: 'public' },
  { method: 'GET', path: '/api/leaderboard', surface: 'api', mutating: false, guard: 'public' },

  // ---- /api member-grade mutations (self-service; serve keys allowed) ----
  { method: 'POST', path: '/api/workloads', surface: 'api', mutating: true, guard: 'member' },
  {
    method: 'POST', path: '/api/policies', surface: 'api', mutating: true, guard: 'member',
    notes: 'G2.3: plain policy creation is member+; the createKey/keyId branches are ADMIN (probed separately in key-role-split.test.ts)',
  },
  { method: 'POST', path: '/api/playground/chat', surface: 'api', mutating: true, guard: 'member' },
  { method: 'POST', path: '/api/evals', surface: 'api', mutating: true, guard: 'member' },
  { method: 'POST', path: '/api/keys', surface: 'api', mutating: true, guard: 'member', notes: 'BYOK provider-key registration (custody-encrypted) — org self-service' },
  { method: 'POST', path: '/api/share', surface: 'api', mutating: true, guard: 'member' },

  // ---- /api ADMIN mutations (G2.3: serve keys get 403 on EVERY row) ----
  { method: 'POST', path: '/api/frontiers/live-sweep', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/frontiers/live-sweep', probeBody: { clusterId: 'agent-x' }, notes: 'SPEND-bearing' },
  { method: 'POST', path: '/api/usage/aggregate', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/usage/aggregate', probeBody: { from: '2026-08-01', to: '2026-08-02' }, notes: 'G2.3-tightened (had no check)' },
  { method: 'POST', path: '/api/keys/:id/rotate', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/keys/k-x/rotate', probeBody: { apiKey: 'sk-rotated-000000' } },
  { method: 'POST', path: '/api/keys/:id/revoke', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/keys/k-x/revoke' },
  { method: 'POST', path: '/api/keys/:id/validate', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/keys/k-x/validate' },
  { method: 'POST', path: '/api/api-keys', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/api-keys', probeBody: { name: 'probe' } },
  { method: 'POST', path: '/api/api-keys/:id/revoke', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/api-keys/k-x/revoke' },
  { method: 'GET', path: '/api/audit', surface: 'api', mutating: false, guard: 'admin' },
  { method: 'GET', path: '/api/audit/export.jsonl', surface: 'api', mutating: false, guard: 'admin' },
  { method: 'POST', path: '/api/alerts', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/alerts', probeBody: { kind: 'webhook', targetUrl: 'https://x.example/h', events: ['quality_breach'] } },
  { method: 'DELETE', path: '/api/alerts/:id', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/alerts/00000000-0000-4000-8000-000000000000' },
  { method: 'POST', path: '/api/alerts/test', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/alerts/test', probeBody: { kind: 'webhook', targetUrl: 'https://x.example/h' } },
  { method: 'POST', path: '/api/guarantee/clusters/:clusterId/incumbent', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/guarantee/clusters/agent-x/incumbent', probeBody: { strategyHash: 'sha-x' } },
  { method: 'POST', path: '/api/guarantee/clusters/:clusterId/verify', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/guarantee/clusters/agent-x/verify', probeBody: { policyId: 'pol-x', servingStrategyHash: 'sha-x' } },
  { method: 'POST', path: '/api/incidents/:id/resolve', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/incidents/00000000-0000-4000-8000-000000000000/resolve', notes: 'THE G2.3 headline: serving keys must not resolve incidents' },
  { method: 'POST', path: '/api/research/scan', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/research/scan', probeBody: {} },
  { method: 'POST', path: '/api/research/cycle', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/research/cycle', probeBody: { suiteId: 'agent-x-replays-v1' } },
  { method: 'POST', path: '/api/recipes/:hash/evaluate', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/recipes/sha-x/evaluate', probeBody: {} },
  { method: 'POST', path: '/api/rubrics/generate', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/rubrics/generate', probeBody: { clusterId: 'agent-x' } },
  { method: 'POST', path: '/api/rubrics/:id/approve', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/rubrics/00000000-0000-4000-8000-000000000000/approve' },
  { method: 'POST', path: '/api/rubrics/:id/reject', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/rubrics/00000000-0000-4000-8000-000000000000/reject', probeBody: { reason: 'probe' } },
  { method: 'POST', path: '/api/share/:id/revoke', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/share/st_x/revoke' },
  { method: 'PUT', path: '/api/budgets', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/budgets', probeBody: { monthlyCapUsd: 10, hardStop: false } },
  { method: 'PUT', path: '/api/traces/retention', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/traces/retention', probeBody: { days: 30 } },
  { method: 'POST', path: '/api/traces/redact', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/traces/redact', probeBody: {} },
  { method: 'POST', path: '/api/traces/cluster', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/traces/cluster', probeBody: {} },
  { method: 'POST', path: '/api/traces/purge', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/traces/purge', probeBody: {} },

  // ---- /auth ----
  { method: 'POST', path: '/auth/request-link', surface: 'auth', mutating: true, guard: 'public', notes: 'self-serve provisioning gated by POTION_SELF_SERVE (G2.7)' },
  { method: 'GET', path: '/auth/verify', surface: 'auth', mutating: true, guard: 'public', notes: 'consumes a single-use token' },
  { method: 'POST', path: '/auth/logout', surface: 'auth', mutating: true, guard: 'viewer' },
  { method: 'POST', path: '/auth/invite', surface: 'auth', mutating: true, guard: 'admin', notes: 'own preHandler: requireRole(admin) incl. the api-key scope gate' },
  { method: 'GET', path: '/auth/me', surface: 'auth', mutating: false, guard: 'viewer' },

  // ---- /operator (fail-closed token surface; never sees the /api hook) ----
  { method: 'POST', path: '/operator/orgs', surface: 'operator', mutating: true, guard: 'operator' },
  { method: 'GET', path: '/operator/orgs', surface: 'operator', mutating: false, guard: 'operator' },
  { method: 'DELETE', path: '/operator/orgs/:id', surface: 'operator', mutating: true, guard: 'operator' },
  { method: 'GET', path: '/operator/jobs/:id', surface: 'operator', mutating: false, guard: 'operator' },
];
