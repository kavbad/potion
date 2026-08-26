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

/**
 * G2.4 TENANCY LENS (added to the SAME rows, not a fork):
 *   'org-param'   — the route names an org-owned resource by param; another
 *                   org's real id must be indistinguishable from a nonexistent
 *                   one (the uniform no-existence-oracle 404).
 *   'org-list'    — returns a collection scoped to the caller's org; another
 *                   org's rows must never appear.
 *   'self-scoped' — acts only on the CALLER's own credential/session.
 *   'shared-global' — platform assets by design (taxonomy frontiers, price
 *                   table, recipe library, leaderboard).
 *   'platform-job'— a job with no owning org (the sweeps): invisible to
 *                   tenants, operator-only.
 *   'public' | 'operator' | 'non-tenant' — no tenant dimension.
 */
export type TenancyClass =
  | 'org-param'
  | 'org-list'
  | 'self-scoped'
  | 'shared-global'
  | 'platform-job'
  | 'public'
  | 'operator'
  | 'non-tenant';

export interface CrossOrgProbe {
  /** 'uniform-404': org B hitting org A's real id is byte-indistinguishable
   *  from a nonexistent id. 'org-list-absent': org A's rows never appear in
   *  org B's response. 'skip': cannot leak — skipReason REQUIRED. */
  expect: 'uniform-404' | 'org-list-absent' | 'skip';
  skipReason?: string;
}

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
  // ---- G2.4 tenancy lens ----
  tenancyClass?: TenancyClass;
  /** The path param naming the org-owned resource (org-param rows). */
  resourceParam?: string;
  /** For org-param routes whose resource id travels in the BODY, not the
   * path (POST /api/lab/runs, the clusterId job triggers): the probeBody
   * field the sweep must substitute with the foreign/unknown/malformed id.
   * Without this the cross-org probe is VACUOUS — every arm sends the same
   * fixed body and the uniform-404 comparison passes trivially (Step 8
   * review finding). */
  resourceBodyField?: string;
  /** What the sweep must seed in ORG_A so the probe uses a REAL foreign id. */
  seededResource?:
    | 'providerKey'
    | 'apiKey'
    | 'job'
    | 'cluster'
    | 'trace'
    | 'incident'
    | 'rubric'
    | 'certification'
  | 'proposal'
    | 'shareToken'
    | 'alertRule'
    | 'labHarness'
    | 'labRun'
    | 'labGrant'
    | 'invite'
    | 'none';
  crossOrgProbe?: CrossOrgProbe;
}

export const ROUTE_INVENTORY: RouteInventoryRow[] = [
  // ---- infra ----
  { method: 'GET', path: '/healthz', surface: 'infra', mutating: false, guard: 'public', tenancyClass: 'non-tenant', crossOrgProbe: { expect: 'skip', skipReason: "no tenant dimension — process liveness" } },
  { method: 'GET', path: '/readyz', surface: 'infra', mutating: false, guard: 'public', tenancyClass: 'non-tenant', crossOrgProbe: { expect: 'skip', skipReason: "no tenant dimension — dependency readiness" } },
  { method: 'GET', path: '/metrics', surface: 'infra', mutating: false, guard: 'public', tenancyClass: 'non-tenant', crossOrgProbe: { expect: 'skip', skipReason: "Prometheus scrape; org labels are HASHED (G2.4) and the surface is network-restricted by deployment posture" } },

  // ---- /v1 serving surface (scopes deliberately NOT enforced here) ----
  { method: 'POST', path: '/v1/chat/completions', surface: 'v1', mutating: true, guard: 'serve', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "serves the CALLING key’s org only; forged-credential cases in tenant-isolation.test.ts" } },
  { method: 'POST', path: '/v1/completions', surface: 'v1', mutating: true, guard: 'serve', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "as /v1/chat/completions" } },
  { method: 'POST', path: '/v1/embeddings', surface: 'v1', mutating: true, guard: 'serve', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "as /v1/chat/completions" } },
  { method: 'GET', path: '/v1/models', surface: 'v1', mutating: false, guard: 'serve', tenancyClass: 'shared-global', crossOrgProbe: { expect: 'skip', skipReason: "the platform price table — a shared asset by design" } },
  { method: 'GET', path: '/v1/policies', surface: 'v1', mutating: false, guard: 'serve', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "returns the CALLING key’s own bound policy" } },
  {
    method: 'POST', path: '/v1/policies', surface: 'v1', mutating: true, guard: 'serve',
    notes: "G2.3 DELIBERATE: rebinds the CALLING key's OWN policy only — self-scoped onboarding mutation, stays serve-reachable", tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "rebinds the CALLING key’s own policy (G2.3 deliberate)" } },
  { method: 'POST', path: '/v1/traces', surface: 'v1', mutating: true, guard: 'serve', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "stamps spans with the CALLING key’s org" } },

  // ---- /api reads (viewer+) ----
  { method: 'GET', path: '/api/frontiers', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'cluster', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/frontiers/:clusterId', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-param', resourceParam: ':clusterId', seededResource: 'cluster', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'GET', path: '/api/endpoint-snippet', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'non-tenant', crossOrgProbe: { expect: 'skip', skipReason: "pure snippet rendering; reads no tenant state" } },
  // SERVING-ROADMAP S1 — the connect surface. Both are org-scoped READS over
  // state the caller's own traffic wrote: /api/connection returns the org's
  // policy + serving-key metadata (never raw key material — only sha256 is
  // stored), /api/routing-activity returns the org's own request_logs rows.
  { method: 'GET', path: '/api/connection', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'apiKey', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/routing-activity', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  // S2 — "what are you building?". POST but READ-ONLY: it classifies text and
  // reads the caller's org-preferred frontier, creating nothing. Guard is
  // member+ (matching POST /api/workloads, the other embed-spending read)
  // because embedding under a live embedder costs money, so a viewer-level
  // credential must not be able to drive spend.
  { method: 'POST', path: '/api/plan', surface: 'api', mutating: false, guard: 'member', probeBody: { description: 'a customer support triage bot' }, tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/usage', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/usage/current', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/usage/export.csv', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/usage/invoice', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/keys', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'providerKey', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/keys/:id/audit', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'providerKey', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'GET', path: '/api/api-keys', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'apiKey', crossOrgProbe: { expect: 'org-list-absent' } },
  // the learning period (2026-08-22): what the org uses today, consent, samples, proposals
  { method: 'GET', path: '/api/incumbents/options', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'shared-global', crossOrgProbe: { expect: 'skip', skipReason: 'the public price roster — the same list for every org' } },
  { method: 'GET', path: '/api/incumbents', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'PUT', path: '/api/incumbents', surface: 'api', mutating: true, guard: 'admin', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/learning', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'POST', path: '/api/learning/run', surface: 'api', mutating: true, guard: 'admin', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: 'enqueues the learning period for the CALLER\'s org only — no parameter, nothing to cross' } },
  { method: 'POST', path: '/api/learning/proposals/:id/apply', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/learning/proposals/lp-x/apply', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'proposal', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/learning/proposals/apply-all', surface: 'api', mutating: true, guard: 'admin', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: 'merges the CALLER\'s own open proposals into its own policy — no parameter, nothing to cross' } },
  { method: 'GET', path: '/api/org-settings', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: 'reads the CALLER\'s own org row — no cross-org parameter exists' } },
  { method: 'PUT', path: '/api/org-settings', surface: 'api', mutating: true, guard: 'admin', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: 'flips the CALLER\'s own model-semantics flag (0058) — no cross-org parameter exists' } },
  { method: 'PUT', path: '/api/floor', surface: 'api', mutating: true, guard: 'admin', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: 'sets the CALLER\'s own org-wide floor (new policy row, own keys rebound) — no cross-org parameter exists' } },
  { method: 'GET', path: '/api/members', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/invites', surface: 'api', mutating: false, guard: 'admin', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/billing', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/invoices/:period', surface: 'api', mutating: false, guard: 'viewer', probeUrl: '/api/invoices/2026-08', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'POST', path: '/api/billing/payment-method', surface: 'api', mutating: true, guard: 'admin', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "starts checkout for the CALLER's own org; the customer id is derived from the session, never from input" } },
  { method: 'POST', path: '/api/billing/charge/:period', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/billing/charge/2026-08', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "charges the CALLER's own org for a period; a period is not tenant data" } },
  { method: 'POST', path: '/webhooks/stripe', surface: 'infra', mutating: true, guard: 'public', tenancyClass: 'non-tenant', crossOrgProbe: { expect: 'skip', skipReason: "public by necessity and SIGNATURE-VERIFIED — an unsigned or stale body is refused, so it cannot mark invoices paid" } },
  { method: 'GET', path: '/api/pins', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/frontier-changelog', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'PUT', path: '/api/pins/:clusterId', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/pins/code-gen', tenancyClass: 'shared-global', crossOrgProbe: { expect: 'skip', skipReason: "pins the CALLER's own org to a cluster from the shared taxonomy; the pin row it writes is org-scoped and the cluster id is not tenant data" } },
  { method: 'DELETE', path: '/api/pins/:clusterId', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/pins/code-gen', tenancyClass: 'shared-global', crossOrgProbe: { expect: 'skip', skipReason: "releases the CALLER's own pin; a cluster id is shared taxonomy, and another org's pin is unreachable by construction" } },
  { method: 'POST', path: '/api/support', surface: 'api', mutating: true, guard: 'viewer', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: 'emails the CALLER\'s own message with its own org context attached — no cross-org parameter exists' } },
  { method: 'POST', path: '/api/invites', surface: 'api', mutating: true, guard: 'admin', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: 'creates an invite in the CALLER\'s own org — no cross-org parameter exists' } },
  { method: 'DELETE', path: '/api/invites/:id', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/invites/00000000-0000-4000-8000-000000000000', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'invite', crossOrgProbe: { expect: 'uniform-404' } },

  { method: 'GET', path: '/api/alerts', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'alertRule', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/alerts/deliveries', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'alertRule', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/jobs/:id', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'platform-job', resourceParam: ':id', seededResource: 'job', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'GET', path: '/api/guarantee/status', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'incident', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/guarantee/clusters/:clusterId/incumbent', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-param', resourceParam: ':clusterId', seededResource: 'cluster', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'GET', path: '/api/reports/savings', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/reports/savings.csv', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/reports/guarantee', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'incident', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/research/cycles', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  // Recently-promoted recipes (the pull half of "how do I hear about a
  // breakthrough"). Platform-scoped research output — recipe hashes/configs,
  // no per-org rows — readable by any authenticated viewer.
  { method: 'GET', path: '/api/research/promotions', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'shared-global', crossOrgProbe: { expect: 'skip', skipReason: "platform research promotions — a shared asset by design, no org dimension in the response" } },
  { method: 'GET', path: '/api/recipes', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'shared-global', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/rubrics', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'rubric', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/certifications', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'certification', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/share', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'shareToken', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/budgets', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/traces', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'trace', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/traces/retention', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/traces/:traceId', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-param', resourceParam: ':traceId', seededResource: 'trace', crossOrgProbe: { expect: 'uniform-404' } },

  // ---- /api/lab (Step 8, the novice-loop surface — spec routes table) ----
  { method: 'POST', path: '/api/lab/harnesses', surface: 'api', mutating: true, guard: 'member', probeUrl: '/api/lab/harnesses', probeBody: { answers: { goal: 'probe goal', kind: 'task', doneDefinition: 'probe done', accounts: [], worthUsd: 1 } }, notes: 'interview → generateSpec; ≤2 model calls via serving under an ephemeral key', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "creates in the CALLER’s org catalog" } },
  { method: 'GET', path: '/api/lab/harnesses', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-list', seededResource: 'labHarness', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/lab/harnesses/:hash', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-param', resourceParam: ':hash', seededResource: 'labHarness', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/lab/harnesses/:hash/dial', surface: 'api', mutating: true, guard: 'admin', probeUrl: `/api/lab/harnesses/${'0'.repeat(64)}/dial`, probeBody: { slot: 'brain', qualityIndex: 0 }, tenancyClass: 'org-param', resourceParam: ':hash', seededResource: 'labHarness', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/lab/harnesses/:hash/felt', surface: 'api', mutating: true, guard: 'member', probeUrl: `/api/lab/harnesses/${'0'.repeat(64)}/felt`, probeBody: { positions: [{ qualityIndex: 0 }] }, notes: 'SPEND-bearing (cap-bound, cached)', tenancyClass: 'org-param', resourceParam: ':hash', seededResource: 'labHarness', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/lab/runs', surface: 'api', mutating: true, guard: 'member', probeUrl: '/api/lab/runs', probeBody: { harnessHash: '0'.repeat(64) }, notes: 'starts a trial run; spend bounded by the harness fuel', tenancyClass: 'org-param', resourceBodyField: 'harnessHash', seededResource: 'labHarness', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'GET', path: '/api/lab/runs/:id', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'labRun', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/lab/runs/:id/answer', surface: 'api', mutating: true, guard: 'member', probeUrl: '/api/lab/runs/run-00000000/answer', probeBody: { answer: 'probe answer' }, tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'labRun', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/lab/runs/:id/kill', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/lab/runs/run-00000000/kill', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'labRun', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'GET', path: '/api/lab/runs/:id/report', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'labRun', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'GET', path: '/api/lab/memory/:hash', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-param', resourceParam: ':hash', seededResource: 'labHarness', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'PUT', path: '/api/lab/memory/:hash/:key', surface: 'api', mutating: true, guard: 'member', probeUrl: `/api/lab/memory/${'0'.repeat(64)}/probekey`, probeBody: { text: 'probe' }, tenancyClass: 'org-param', resourceParam: ':hash', seededResource: 'labHarness', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'DELETE', path: '/api/lab/memory/:hash/:key', surface: 'api', mutating: true, guard: 'admin', probeUrl: `/api/lab/memory/${'0'.repeat(64)}/probekey`, tenancyClass: 'org-param', resourceParam: ':hash', seededResource: 'labHarness', crossOrgProbe: { expect: 'uniform-404' } },
  // ---- Step 9 (the derived form) additive routes ----
  { method: 'GET', path: '/api/lab/harnesses/:hash/runs', surface: 'api', mutating: false, guard: 'viewer', tenancyClass: 'org-param', resourceParam: ':hash', seededResource: 'labHarness', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/lab/harnesses/:hash/edit', surface: 'api', mutating: true, guard: 'member', probeUrl: `/api/lab/harnesses/${'0'.repeat(64)}/edit`, probeBody: { ops: [{ op: 'add-rule', rule: 'probe rule' }] }, notes: 'plain-language spec patch → NEW content-addressed catalog row (dial-motion precedent)', tenancyClass: 'org-param', resourceParam: ':hash', seededResource: 'labHarness', crossOrgProbe: { expect: 'uniform-404' } },
  // ---- Step 10 (connectors + token custody) additive routes ----
  { method: 'GET', path: '/api/lab/connectors', surface: 'api', mutating: false, guard: 'viewer', notes: 'catalog + this org’s grant STATUSES; envelope columns never selected (lab-grants.ts projection); the grant-absence sweep drives EVERY inventory row against a seeded token', tenancyClass: 'org-list', seededResource: 'labGrant', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'POST', path: '/api/lab/connectors/:id/oauth/start', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/lab/connectors/github/oauth/start', notes: 'PKCE + org-bound HMAC state cookie; mutates no tenant rows (grant lands at the callback)', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: 'no resource id travels; the state cookie binds the CALLER’s org and the callback enforces it' } },
  { method: 'GET', path: '/api/lab/connectors/:id/oauth/callback', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/lab/connectors/github/oauth/callback', notes: 'code exchange server-side; grant row upserted into the FLOW org only after the org-match check', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: 'requires a signed state cookie for the caller’s own org; without it every probe 400s uniformly (connector-routes tests pin the org-mismatch 403)' } },
  { method: 'POST', path: '/api/lab/connectors/:id/revoke', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/lab/connectors/github/revoke', notes: 'typed cut (local truth) + best-effort provider revocation via lab:grant-revoke', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: 'connector id is a shared catalog key, not a tenant id; the mutation touches only the CALLER org’s grant row (a foreign org simply 404s on its own absent grant)' } },

  // ---- /api public exemptions (hook-level carve-outs) ----
  { method: 'GET', path: '/api/public/share/:token/frontier', surface: 'api', mutating: false, guard: 'public', tenancyClass: 'public', crossOrgProbe: { expect: 'skip', skipReason: "the TOKEN is the credential; unknown/revoked tokens 404 uniformly (share.test.ts)" } },
  { method: 'GET', path: '/api/public/answers', surface: 'api', mutating: false, guard: 'public', tenancyClass: 'public', crossOrgProbe: { expect: 'skip', skipReason: "PLATFORM frontiers only, live-only, redaction-swept fail-closed (public-answers.test.ts) — no tenant data exists on this route" } },
  { method: 'GET', path: '/api/public/share/:token/report', surface: 'api', mutating: false, guard: 'public', tenancyClass: 'public', crossOrgProbe: { expect: 'skip', skipReason: "as above; org identity comes from the token row, redacted by default" } },
  { method: 'GET', path: '/api/leaderboard', surface: 'api', mutating: false, guard: 'public', tenancyClass: 'shared-global', crossOrgProbe: { expect: 'skip', skipReason: "public platform leaderboard — opt-in orgs only, platform clusters pinned" } },

  // ---- /api member-grade mutations (self-service; serve keys allowed) ----
  { method: 'POST', path: '/api/workloads', surface: 'api', mutating: true, guard: 'member', tenancyClass: 'non-tenant', crossOrgProbe: { expect: 'skip', skipReason: "cluster ASSIGNMENT over the platform taxonomy; reads/writes no tenant rows" } },
  {
    method: 'POST', path: '/api/policies', surface: 'api', mutating: true, guard: 'member',
    notes: 'G2.3: plain policy creation is member+; the createKey/keyId branches are ADMIN (probed separately in key-role-split.test.ts)', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "creates in the CALLER’s org; the keyId cross-org case is pinned in tenant-isolation.test.ts" } },
  { method: 'POST', path: '/api/playground/chat', surface: 'api', mutating: true, guard: 'member', tenancyClass: 'org-param', seededResource: 'cluster', crossOrgProbe: { expect: 'skip', skipReason: "body-named cluster resolves org-preferred with platform fallback; a foreign agent cluster has no platform frontier and 404s — same property the frontier probe asserts" } },
  { method: 'POST', path: '/api/evals', surface: 'api', mutating: true, guard: 'member', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "suiteIds resolve to PLATFORM suite files only; the job is stamped with the caller’s org" } },
  { method: 'POST', path: '/api/keys', surface: 'api', mutating: true, guard: 'member', notes: 'BYOK provider-key registration (custody-encrypted) — org self-service', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "registers into the CALLER’s org (custody-encrypted)" } },
  { method: 'POST', path: '/api/share', surface: 'api', mutating: true, guard: 'member', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "mints a token for the CALLER’s org over a platform frontier" } },

  // ---- /api ADMIN mutations (G2.3: serve keys get 403 on EVERY row) ----
  { method: 'POST', path: '/api/frontiers/live-sweep', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/frontiers/live-sweep', probeBody: { clusterId: 'agent-x' }, notes: 'SPEND-bearing', tenancyClass: 'org-param', resourceBodyField: 'clusterId', seededResource: 'cluster', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/usage/aggregate', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/usage/aggregate', probeBody: { from: '2026-08-01', to: '2026-08-02' }, notes: 'G2.3-tightened (had no check)', tenancyClass: 'non-tenant', crossOrgProbe: { expect: 'skip', skipReason: "admin-only platform rollup trigger; names no tenant resource" } },
  { method: 'POST', path: '/api/keys/:id/rotate', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/keys/k-x/rotate', probeBody: { apiKey: 'sk-rotated-000000' }, tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'providerKey', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/keys/:id/revoke', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/keys/k-x/revoke', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'providerKey', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/keys/:id/validate', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/keys/k-x/validate', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'providerKey', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/api-keys', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/api-keys', probeBody: { name: 'probe' }, tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "mints into the CALLER’s org; cross-org policyId 404s (tenant-isolation.test.ts)" } },
  { method: 'POST', path: '/api/api-keys/:id/revoke', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/api-keys/k-x/revoke', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'apiKey', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'GET', path: '/api/audit', surface: 'api', mutating: false, guard: 'admin', tenancyClass: 'org-list', seededResource: 'providerKey', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'GET', path: '/api/audit/export.jsonl', surface: 'api', mutating: false, guard: 'admin', tenancyClass: 'org-list', seededResource: 'providerKey', crossOrgProbe: { expect: 'org-list-absent' } },
  { method: 'POST', path: '/api/alerts', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/alerts', probeBody: { kind: 'webhook', targetUrl: 'https://x.example/h', events: ['quality_breach'] }, tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "creates in the CALLER’s org" } },
  { method: 'DELETE', path: '/api/alerts/:id', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/alerts/00000000-0000-4000-8000-000000000000', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'alertRule', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/alerts/test', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/alerts/test', probeBody: { url: 'https://x.example/h', kind: 'webhook' }, tenancyClass: 'non-tenant', crossOrgProbe: { expect: 'skip', skipReason: "fires at a caller-supplied URL; names no stored tenant resource" } },
  { method: 'POST', path: '/api/guarantee/clusters/:clusterId/incumbent', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/guarantee/clusters/agent-x/incumbent', probeBody: { strategyHash: 'sha-x' }, tenancyClass: 'org-param', resourceParam: ':clusterId', seededResource: 'cluster', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/guarantee/clusters/:clusterId/verify', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/guarantee/clusters/agent-x/verify', probeBody: { policyId: 'pol-x', servingStrategyHash: 'sha-x' }, tenancyClass: 'org-param', resourceParam: ':clusterId', seededResource: 'cluster', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/incidents/:id/resolve', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/incidents/00000000-0000-4000-8000-000000000000/resolve', notes: 'THE G2.3 headline: serving keys must not resolve incidents', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'incident', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/research/scan', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/research/scan', probeBody: {}, tenancyClass: 'non-tenant', crossOrgProbe: { expect: 'skip', skipReason: "platform registry scan; the job carries the caller’s org for attribution only" } },
  { method: 'POST', path: '/api/research/cycle', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/research/cycle', probeBody: { clusterId: 'agent-x' }, tenancyClass: 'org-param', resourceBodyField: 'clusterId', seededResource: 'cluster', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/recipes/:hash/evaluate', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/recipes/sha-x/evaluate', probeBody: {}, tenancyClass: 'shared-global', resourceParam: ':hash', crossOrgProbe: { expect: 'skip', skipReason: "recipes are content-addressed PLATFORM configs; unknown hashes 404 for everyone" } },
  { method: 'POST', path: '/api/rubrics/generate', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/rubrics/generate', probeBody: { clusterId: 'agent-x' }, tenancyClass: 'org-param', resourceBodyField: 'clusterId', seededResource: 'cluster', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/certifications/run', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/certifications/run', probeBody: { clusterId: 'agent-x' }, tenancyClass: 'org-param', resourceBodyField: 'clusterId', seededResource: 'cluster', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/rubrics/:id/approve', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/rubrics/00000000-0000-4000-8000-000000000000/approve', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'rubric', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/rubrics/:id/reject', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/rubrics/00000000-0000-4000-8000-000000000000/reject', probeBody: { reason: 'probe' }, tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'rubric', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'POST', path: '/api/share/:id/revoke', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/share/st_x/revoke', tenancyClass: 'org-param', resourceParam: ':id', seededResource: 'shareToken', crossOrgProbe: { expect: 'uniform-404' } },
  { method: 'PUT', path: '/api/budgets', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/budgets', probeBody: { monthlyCapUsd: 10, hardStop: false }, tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "upserts the CALLER’s org budget" } },
  { method: 'PUT', path: '/api/traces/retention', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/traces/retention', probeBody: { days: 30 }, tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "sets the CALLER’s org retention" } },
  { method: 'POST', path: '/api/traces/redact', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/traces/redact', probeBody: {}, tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "org forced into the job payload from the session" } },
  { method: 'POST', path: '/api/traces/cluster', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/traces/cluster', probeBody: {}, tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "org forced into the job payload from the session" } },
  { method: 'POST', path: '/api/traces/purge', surface: 'api', mutating: true, guard: 'admin', probeUrl: '/api/traces/purge', probeBody: {}, tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "org forced into the job payload from the session" } },

  // ---- /auth ----
  { method: 'POST', path: '/auth/request-link', surface: 'auth', mutating: true, guard: 'public', notes: 'self-serve provisioning gated by POTION_SELF_SERVE (G2.7)', tenancyClass: 'public', crossOrgProbe: { expect: 'skip', skipReason: "pre-auth; neutral response, self-serve gated (G2.7)" } },
  { method: 'GET', path: '/auth/verify', surface: 'auth', mutating: true, guard: 'public', notes: 'consumes a single-use token', tenancyClass: 'public', crossOrgProbe: { expect: 'skip', skipReason: "single-use token consumption; session pinned to the link’s org" } },
  { method: 'POST', path: '/auth/logout', surface: 'auth', mutating: true, guard: 'viewer', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "revokes the CALLER’s own session" } },
  { method: 'POST', path: '/auth/invite', surface: 'auth', mutating: true, guard: 'admin', notes: 'own preHandler: requireRole(admin) incl. the api-key scope gate', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "membership lands in the INVITER’s org" } },
  { method: 'GET', path: '/auth/me', surface: 'auth', mutating: false, guard: 'viewer', tenancyClass: 'self-scoped', crossOrgProbe: { expect: 'skip', skipReason: "reports the caller’s own credential; forged-header cases in tenant-isolation.test.ts" } },

  // ---- /operator (fail-closed token surface; never sees the /api hook) ----
  { method: 'POST', path: '/operator/orgs', surface: 'operator', mutating: true, guard: 'operator', tenancyClass: 'operator', crossOrgProbe: { expect: 'skip', skipReason: "operator token surface — outside the tenant model" } },
  { method: 'GET', path: '/operator/orgs', surface: 'operator', mutating: false, guard: 'operator', tenancyClass: 'operator', crossOrgProbe: { expect: 'skip', skipReason: "operator token surface — outside the tenant model" } },
  { method: 'DELETE', path: '/operator/orgs/:id', surface: 'operator', mutating: true, guard: 'operator', tenancyClass: 'operator', crossOrgProbe: { expect: 'skip', skipReason: "operator token surface — outside the tenant model" } },
  { method: 'POST', path: '/operator/frontiers/platform-sweep', surface: 'operator', mutating: true, guard: 'operator', tenancyClass: 'operator', crossOrgProbe: { expect: 'skip', skipReason: "operator token surface — platform-scope spend job, no tenant dimension" } },
  { method: 'GET', path: '/operator/jobs/:id', surface: 'operator', mutating: false, guard: 'operator', tenancyClass: 'operator', crossOrgProbe: { expect: 'skip', skipReason: "operator token surface — the deliberate platform-job mirror" } },
];
