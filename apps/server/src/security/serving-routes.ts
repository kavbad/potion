// SERVING-ROUTE INVENTORY (F6) — every route that can cause provider spend
// on a customer's behalf, and therefore must carry every serving protection:
// the rate limit + body ceiling, the budget hard stop, and per-request
// metering into request_logs.
//
// WHY A FIXTURE AND NOT A COMMENT. Protections were maintained by copy-paste
// across routes, so /v1/completions shipped without the budget gate and
// without rate limiting, and /v1/embeddings shipped without any metering at
// all — one credential could serve past its hard cap and past its daily cap
// by switching endpoints, and embeddings spend was invisible to the invoice
// rollup entirely. Worse, two comments (openai-parity.ts, server.ts) ASSERTED
// the rate limiting that route did not have, so a stale note read as a
// decision. This file is the single list the rate limiter matches against and
// the tests loop over, in the tradition of route-inventory.ts and
// mock-eligibility-inventory.ts: a fixture consumed by tests, not
// documentation. Add a spend route without adding it here and the
// completeness meta-test fails by name; add it here without wiring the
// protections and the behavioural loop fails immediately.
//
// The precedent is latency-policy.ts, which closed this exact class for the
// G2.6 latency bound: "a bound enforced only in /v1/chat/completions is
// silently non-binding on /v1/completions".

/** Routes that resolve a policy/strategy and can spend a customer's money. */
export const SERVING_ROUTES = [
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
] as const;

export type ServingRoute = (typeof SERVING_ROUTES)[number];

export function isServingRoute(url: string | undefined): url is ServingRoute {
  return url !== undefined && (SERVING_ROUTES as readonly string[]).includes(url);
}

/**
 * Mutating /v1 routes that are deliberately NOT serving surfaces, each with
 * the reason. The completeness meta-test requires every mutating /v1 route to
 * be in SERVING_ROUTES or here — silence is not an option.
 */
export const NON_SERVING_V1_ROUTES: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: '/v1/policies',
    why: 'policy CRUD — no strategy resolution, no provider call',
  },
  {
    path: '/v1/traces',
    why: 'trace ingestion — writes customer spans, prices them at ingest, spends nothing',
  },
  // L-G4: the runtime gate — governance calls from external runtimes.
  // They read the trust record and write run/step rows; no strategy is
  // resolved and no provider is called. Spend never happens here.
  {
    path: '/v1/lab/runtime/sessions',
    why: 'runtime-gate session registration — writes a lab_run row, spends nothing',
  },
  {
    path: '/v1/lab/runtime/pore',
    why: 'runtime-gate decision — reads the trust record, may write a check-in step; no provider call',
  },
  {
    path: '/v1/lab/runtime/pore/resolve',
    why: 'runtime-gate resolution — writes the answer step (graduation evidence); no provider call',
  },
  {
    path: '/v1/lab/runtime/outcome',
    why: 'runtime-gate outcome report — writes a tool step; no provider call',
  },
];

/**
 * Spend-capable surfaces OUTSIDE /v1 that are deliberately exempt.
 * /api/playground/chat executes strategies but is an interactive experiment
 * surface: routes/playground.ts states it is "deliberately NOT logged to
 * request_logs and NEVER shadow/guarantee sampled … metering it would pollute
 * the usage/savings evidence". Recorded here so the exemption stays a
 * decision rather than becoming another silent omission.
 */
export const EXEMPT_SPEND_SURFACES: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: '/api/playground/chat',
    why: 'interactive experiment surface, deliberately unmetered (routes/playground.ts) — dashboard-session gated, not an API credential',
  },
];
