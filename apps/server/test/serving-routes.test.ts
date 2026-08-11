// F6 completeness: the SERVING_ROUTES fixture must stay in step with the
// live route tree, so a new spend route cannot ship unprotected.
//
// The defect this closes: /v1/completions and /v1/embeddings were added
// (M3 #25) after rate limiting (M2 Wave 2) and after the budget hard stop
// (M4 #35), and nobody widened either protection. Both were invisible for
// months because protections were maintained by copy-paste per route and
// nothing asserted parity. The behavioural loops live in budgets.test.ts and
// ratelimit.test.ts; THIS test guarantees they cover everything, in the
// route-inventory.ts / mock-eligibility-inventory.ts tradition.
import { describe, expect, it } from 'vitest';
import { ROUTE_INVENTORY } from '../src/security/route-inventory.js';
import {
  EXEMPT_SPEND_SURFACES,
  NON_SERVING_V1_ROUTES,
  SERVING_ROUTES,
} from '../src/security/serving-routes.js';

describe('serving-route inventory completeness (F6)', () => {
  it('every MUTATING /v1 route is classified: serving, or non-serving with a reason', () => {
    const mutatingV1 = ROUTE_INVENTORY.filter((r) => r.path.startsWith('/v1/') && r.mutating).map(
      (r) => r.path,
    );
    expect(mutatingV1.length).toBeGreaterThan(0);
    const classified = new Set<string>([
      ...SERVING_ROUTES,
      ...NON_SERVING_V1_ROUTES.map((r) => r.path),
    ]);
    const unclassified = mutatingV1.filter((p) => !classified.has(p));
    expect(
      unclassified,
      `unclassified mutating /v1 route(s): ${unclassified.join(', ')}. A route that can spend ` +
        'must go in SERVING_ROUTES (and will then be rate-limited + budget-gated, with the ' +
        'behavioural loops in budgets.test.ts / ratelimit.test.ts proving it); a route that ' +
        'cannot must go in NON_SERVING_V1_ROUTES with its reason.',
    ).toEqual([]);
  });

  it('every declared serving route actually exists in the route tree', () => {
    const known = new Set(ROUTE_INVENTORY.map((r) => r.path));
    for (const route of SERVING_ROUTES) {
      expect({ route, known: known.has(route) }).toEqual({ route, known: true });
    }
  });

  it('every classification carries a REASON — silence is not a decision', () => {
    for (const r of [...NON_SERVING_V1_ROUTES, ...EXEMPT_SPEND_SURFACES]) {
      expect(r.why.length, `${r.path} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('the exempt list names the playground and nothing else by accident', () => {
    // The playground executes strategies but is deliberately unmetered
    // (routes/playground.ts). If a second surface ever joins this list it
    // should be a conscious act, so pin the membership.
    expect(EXEMPT_SPEND_SURFACES.map((r) => r.path)).toEqual(['/api/playground/chat']);
  });
});
