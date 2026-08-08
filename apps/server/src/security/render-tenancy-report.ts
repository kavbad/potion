// The tenancy classification report (G2.4) — a PURE renderer over the two
// committed inventories. This is the security-questionnaire answer and the
// design-partner diligence exhibit: every route, its tenancy class, the
// credential it requires, and the cross-org posture asserted against it.
//
// Deterministic by construction (fixed ordering, no clock, no environment),
// so the committed artifact is byte-stable and a stale checkout fails the
// up-to-date test rather than drifting silently.
import type { RouteInventoryRow } from './route-inventory.js';
import type { MockEligibilityRow } from './mock-eligibility-inventory.js';

const SURFACE_ORDER = ['v1', 'api', 'auth', 'operator', 'infra'] as const;

const SURFACE_TITLES: Record<string, string> = {
  v1: 'Serving surface (`/v1`)',
  api: 'Tenant surface (`/api`)',
  auth: 'Authentication (`/auth`)',
  operator: 'Operator surface (`/operator`)',
  infra: 'Infrastructure',
};

const GUARD_MEANING: Record<string, string> = {
  public: 'none (public by design)',
  serve: 'any valid api key',
  viewer: 'any org credential',
  member: 'member+ (serve key or member session)',
  admin: 'admin only (`serve+admin` key or admin session)',
  operator: 'operator token',
};

const PROBE_MEANING: Record<string, string> = {
  'uniform-404': 'uniform 404 (probed)',
  'org-list-absent': "absent from other orgs' responses (probed)",
  skip: 'n/a',
};

function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function routeTable(rows: RouteInventoryRow[]): string {
  const header =
    '| Method | Path | Mutating | Credential required | Tenancy class | Cross-org posture |\n' +
    '|---|---|---|---|---|---|';
  const body = rows
    .map((r) => {
      const posture =
        r.crossOrgProbe?.expect === 'skip'
          ? `not applicable — ${r.crossOrgProbe.skipReason ?? ''}`
          : (PROBE_MEANING[r.crossOrgProbe?.expect ?? 'skip'] ?? '—');
      return `| ${r.method} | \`${cell(r.path)}\` | ${r.mutating ? 'yes' : 'no'} | ${
        GUARD_MEANING[r.guard] ?? r.guard
      } | ${r.tenancyClass ?? '—'} | ${cell(posture)} |`;
    })
    .join('\n');
  return `${header}\n${body}`;
}

function mockTable(rows: MockEligibilityRow[]): string {
  const header =
    '| Site | Symbol | Kind | Posture under live | Pinned by |\n|---|---|---|---|---|';
  const body = rows
    .map(
      (r) =>
        `| \`${cell(r.file)}\` | ${cell(r.symbol)} | ${r.kind} | ${r.mockPosture} | ${
          r.regressionTest ? `\`${cell(r.regressionTest)}\`` : '—'
        } |`,
    )
    .join('\n');
  return `${header}\n${body}`;
}

export function renderTenancyReport(
  routes: RouteInventoryRow[],
  mockSites: MockEligibilityRow[],
): string {
  const sorted = [...routes].sort(
    (a, b) =>
      SURFACE_ORDER.indexOf(a.surface) - SURFACE_ORDER.indexOf(b.surface) ||
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method),
  );
  const counts = sorted.reduce<Record<string, number>>((acc, r) => {
    const k = r.tenancyClass ?? 'unclassified';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  const probed = sorted.filter((r) => r.crossOrgProbe?.expect === 'uniform-404').length;
  const lists = sorted.filter((r) => r.crossOrgProbe?.expect === 'org-list-absent').length;

  const sections = SURFACE_ORDER.filter((s) => sorted.some((r) => r.surface === s))
    .map((s) => `### ${SURFACE_TITLES[s]}\n\n${routeTable(sorted.filter((r) => r.surface === s))}`)
    .join('\n\n');

  const mockSorted = [...mockSites].sort(
    (a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol),
  );

  return `# Potion — route tenancy & isolation classification

Generated from the committed inventories
(\`apps/server/src/security/route-inventory.ts\`,
\`apps/server/src/security/mock-eligibility-inventory.ts\`).
Regenerate with \`pnpm --filter @potion/server tenancy-report\`; a stale copy
fails \`apps/server/test/tenancy-report.test.ts\`.

Every row here is **enforced by tests**, not asserted by prose:

- \`key-role-split.test.ts\` diffs this route list against the live fastify
  route tree both ways, and probes every admin-guarded route with a
  serving-scoped key.
- \`tenancy-sweep.test.ts\` acts as org B against org A's **real** resources on
  every org-scoped route and requires the response to be indistinguishable
  from one naming a resource that never existed — same status, same body
  shape — under **both** credential kinds (api key and session cookie).
- \`mock-eligibility.test.ts\` re-greps the source tree for provider-resolution
  sites and fails if one is missing from the mock-eligibility inventory.

## Summary

- **${sorted.length}** routes classified.
- **${probed}** org-scoped routes probed for the uniform no-existence-oracle 404.
- **${lists}** org-scoped collections probed for cross-tenant absence.
- Tenancy classes: ${Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')}.

### What the tenancy classes mean

| Class | Meaning |
|---|---|
| org-param | names an org-owned resource by path param; another org's real id is indistinguishable from a nonexistent one |
| org-list | returns a collection scoped to the caller's org; other tenants' rows never appear |
| self-scoped | acts only on the caller's own credential, session or org |
| shared-global | a deliberate platform asset (taxonomy frontiers, price table, recipe library, leaderboard) |
| platform-job | owned by no org — visible only on the operator surface |
| public / operator / non-tenant | outside the tenant model by design |

## Routes

${sections}

## Provider-resolution sites (false-live audit)

A separate lens over the same discipline: can a **mock** provider, alias or
entry be selected, executed or recorded while the surrounding mode is
\`live\`? Sites are code locations rather than routes, so completeness is
grep-derived and enforced by \`mock-eligibility.test.ts\`.

${mockTable(mockSorted)}

## Deployment notes

- \`/metrics\` is an unauthenticated Prometheus scrape surface by convention.
  Org identifiers in metric labels are **hashed** (the same 6-character hash
  used in \`agent-<orgHash6>-*\` cluster ids), and the endpoint must still be
  network-restricted — defense in depth.
- The demo tenant's API credential is seeded **only** when
  \`POTION_SEED_DEMO\` is set; production boots carry no demo credential.
- Self-serve org provisioning is gated behind \`POTION_SELF_SERVE\`; operator
  onboarding is otherwise the only way an org comes into being.
`;
}
