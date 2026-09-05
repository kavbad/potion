# Potion — route tenancy & isolation classification

Generated from the committed inventories
(`apps/server/src/security/route-inventory.ts`,
`apps/server/src/security/mock-eligibility-inventory.ts`).
Regenerate with `pnpm --filter @potion/server tenancy-report`; a stale copy
fails `apps/server/test/tenancy-report.test.ts`.

Every row here is **enforced by tests**, not asserted by prose:

- `key-role-split.test.ts` diffs this route list against the live fastify
  route tree both ways, and probes every admin-guarded route with a
  serving-scoped key.
- `tenancy-sweep.test.ts` acts as org B against org A's **real** resources on
  every org-scoped route and requires the response to be indistinguishable
  from one naming a resource that never existed — same status, same body
  shape — under **both** credential kinds (api key and session cookie).
- `mock-eligibility.test.ts` re-greps the source tree for provider-resolution
  sites and fails if one is missing from the mock-eligibility inventory.

## Summary

- **181** routes classified.
- **54** org-scoped routes probed for the uniform no-existence-oracle 404.
- **44** org-scoped collections probed for cross-tenant absence.
- Tenancy classes: non-tenant 11, operator 5, org-list 43, org-param 58, platform-job 1, public 9, self-scoped 46, shared-global 8.

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

### Serving surface (`/v1`)

| Method | Path | Mutating | Credential required | Tenancy class | Cross-org posture |
|---|---|---|---|---|---|
| POST | `/v1/chat/completions` | yes | any valid api key | self-scoped | not applicable — serves the CALLING key’s org only; forged-credential cases in tenant-isolation.test.ts |
| POST | `/v1/completions` | yes | any valid api key | self-scoped | not applicable — as /v1/chat/completions |
| POST | `/v1/embeddings` | yes | any valid api key | self-scoped | not applicable — as /v1/chat/completions |
| POST | `/v1/lab/evidence` | yes | any valid api key | self-scoped | not applicable — as /v1/lab/runtime/pore |
| POST | `/v1/lab/runtime/outcome` | yes | any valid api key | self-scoped | not applicable — as /v1/lab/runtime/pore |
| POST | `/v1/lab/runtime/pore` | yes | any valid api key | self-scoped | not applicable — runId is body-carried and org-guarded (getExternalSession); cross-org 404 pinned in lab-runtime-gate.test.ts |
| POST | `/v1/lab/runtime/pore/resolve` | yes | any valid api key | self-scoped | not applicable — as /v1/lab/runtime/pore |
| POST | `/v1/lab/runtime/sessions` | yes | any valid api key | self-scoped | not applicable — registers a session in the CALLING key’s org; foreign harness hashes 404 (lab-runtime-gate.test.ts) |
| GET | `/v1/models` | no | any valid api key | shared-global | not applicable — the platform price table — a shared asset by design |
| POST | `/v1/outcomes` | yes | any valid api key | self-scoped | not applicable — attaches to the CALLING key's org's own served request; foreign request ids 404 (outcomes.test.ts) |
| GET | `/v1/policies` | no | any valid api key | self-scoped | not applicable — returns the CALLING key’s own bound policy |
| POST | `/v1/policies` | yes | any valid api key | self-scoped | not applicable — rebinds the CALLING key’s own policy (G2.3 deliberate) |
| POST | `/v1/traces` | yes | any valid api key | self-scoped | not applicable — stamps spans with the CALLING key’s org |

### Tenant surface (`/api`)

| Method | Path | Mutating | Credential required | Tenancy class | Cross-org posture |
|---|---|---|---|---|---|
| GET | `/api/alerts` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/alerts` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — creates in the CALLER’s org |
| DELETE | `/api/alerts/:id` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/alerts/deliveries` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/alerts/test` | yes | admin only (`serve+admin` key or admin session) | non-tenant | not applicable — fires at a caller-supplied URL; names no stored tenant resource |
| GET | `/api/api-keys` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/api-keys` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — mints into the CALLER’s org; cross-org policyId 404s (tenant-isolation.test.ts) |
| POST | `/api/api-keys/:id/revoke` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/audit` | no | admin only (`serve+admin` key or admin session) | org-list | absent from other orgs' responses (probed) |
| GET | `/api/audit/export.jsonl` | no | admin only (`serve+admin` key or admin session) | org-list | absent from other orgs' responses (probed) |
| GET | `/api/billing` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/billing/charge/:period` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — charges the CALLER's own org for a period; a period is not tenant data |
| POST | `/api/billing/payment-method` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — starts checkout for the CALLER's own org; the customer id is derived from the session, never from input |
| GET | `/api/budgets` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| PUT | `/api/budgets` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — upserts the CALLER’s org budget |
| GET | `/api/certifications` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/certifications/run` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/challengers` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/challengers/:id/apply` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/connection` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/endpoint-snippet` | no | any org credential | non-tenant | not applicable — pure snippet rendering; reads no tenant state |
| POST | `/api/evals` | yes | member+ (serve key or member session) | self-scoped | not applicable — suiteIds resolve to PLATFORM suite files only; the job is stamped with the caller’s org |
| PUT | `/api/floor` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — sets the CALLER's own org-wide floor (new policy row, own keys rebound) — no cross-org parameter exists |
| GET | `/api/frontier-changelog` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/frontiers` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/frontiers/:clusterId` | no | any org credential | org-param | uniform 404 (probed) |
| POST | `/api/frontiers/live-sweep` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/guarantee/clusters/:clusterId/incumbent` | no | any org credential | org-param | uniform 404 (probed) |
| POST | `/api/guarantee/clusters/:clusterId/incumbent` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/guarantee/clusters/:clusterId/verify` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/guarantee/status` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/holdout` | no | any org credential | self-scoped | not applicable — reads the CALLING org's own holdout config — no parameter, nothing to cross |
| PUT | `/api/holdout` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — writes the CALLING org's own holdout config — no parameter, nothing to cross |
| POST | `/api/incidents/:id/resolve` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/incumbents` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| PUT | `/api/incumbents` | yes | admin only (`serve+admin` key or admin session) | org-list | absent from other orgs' responses (probed) |
| GET | `/api/incumbents/options` | no | any org credential | shared-global | not applicable — the public price roster — the same list for every org |
| GET | `/api/invites` | no | admin only (`serve+admin` key or admin session) | org-list | absent from other orgs' responses (probed) |
| POST | `/api/invites` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — creates an invite in the CALLER's own org — no cross-org parameter exists |
| DELETE | `/api/invites/:id` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/invoices/:period` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/jobs/:id` | no | any org credential | platform-job | uniform 404 (probed) |
| GET | `/api/keys` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/keys` | yes | member+ (serve key or member session) | self-scoped | not applicable — registers into the CALLER’s org (custody-encrypted) |
| GET | `/api/keys/:id/audit` | no | any org credential | org-param | uniform 404 (probed) |
| POST | `/api/keys/:id/revoke` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/keys/:id/rotate` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/keys/:id/validate` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/lab/connectors` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/lab/connectors/:id/oauth/callback` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — requires a signed state cookie for the caller’s own org; without it every probe 400s uniformly (connector-routes tests pin the org-mismatch 403) |
| POST | `/api/lab/connectors/:id/oauth/start` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — no resource id travels; the state cookie binds the CALLER’s org and the callback enforces it |
| POST | `/api/lab/connectors/:id/revoke` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — connector id is a shared catalog key, not a tenant id; the mutation touches only the CALLER org’s grant row (a foreign org simply 404s on its own absent grant) |
| POST | `/api/lab/connectors/custom` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — creates rows only under the CALLER’s org id; no foreign id travels |
| DELETE | `/api/lab/connectors/custom/:id` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — the slug is scoped by (org_id, connector_id) — a foreign org 404s on its own absent row; no cross-org id exists to probe |
| POST | `/api/lab/connectors/custom/probe` | no | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — no tenant resource id travels — the body is an external URL and nothing is read or written |
| POST | `/api/lab/grants/:id/accept` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/lab/harnesses` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/lab/harnesses` | yes | member+ (serve key or member session) | self-scoped | not applicable — creates in the CALLER’s org catalog |
| GET | `/api/lab/harnesses/:hash` | no | any org credential | org-param | uniform 404 (probed) |
| POST | `/api/lab/harnesses/:hash/arm` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/lab/harnesses/:hash/candidates` | no | any org credential | org-param | uniform 404 (probed) |
| POST | `/api/lab/harnesses/:hash/candidates` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/lab/harnesses/:hash/dial` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/lab/harnesses/:hash/edit` | yes | member+ (serve key or member session) | org-param | uniform 404 (probed) |
| POST | `/api/lab/harnesses/:hash/felt` | yes | member+ (serve key or member session) | org-param | uniform 404 (probed) |
| GET | `/api/lab/harnesses/:hash/grants` | no | any org credential | org-param | uniform 404 (probed) |
| POST | `/api/lab/harnesses/:hash/grants/evaluate` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/lab/harnesses/:hash/improvements` | no | any org credential | org-param | uniform 404 (probed) |
| POST | `/api/lab/harnesses/:hash/pause` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/lab/harnesses/:hash/promote` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/lab/harnesses/:hash/runs` | no | any org credential | org-param | uniform 404 (probed) |
| PUT | `/api/lab/harnesses/:hash/spec` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/lab/memory/:hash` | no | any org credential | org-param | uniform 404 (probed) |
| DELETE | `/api/lab/memory/:hash/:key` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| PUT | `/api/lab/memory/:hash/:key` | yes | member+ (serve key or member session) | org-param | uniform 404 (probed) |
| GET | `/api/lab/recent` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/lab/runs` | yes | member+ (serve key or member session) | org-param | uniform 404 (probed) |
| GET | `/api/lab/runs/:id` | no | any org credential | org-param | uniform 404 (probed) |
| POST | `/api/lab/runs/:id/answer` | yes | member+ (serve key or member session) | org-param | uniform 404 (probed) |
| GET | `/api/lab/runs/:id/files` | no | any org credential | org-param | uniform 404 (probed) |
| GET | `/api/lab/runs/:id/files/:name` | no | any org credential | org-param | uniform 404 (probed) |
| POST | `/api/lab/runs/:id/kill` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/lab/runs/:id/live` | no | any org credential | org-param | uniform 404 (probed) |
| GET | `/api/lab/runs/:id/report` | no | any org credential | org-param | uniform 404 (probed) |
| POST | `/api/lab/runs/:id/share` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/lab/runs/:id/steer` | yes | member+ (serve key or member session) | org-param | uniform 404 (probed) |
| POST | `/api/lab/runs/:id/verify` | no | any org credential | org-param | uniform 404 (probed) |
| GET | `/api/leaderboard` | no | none (public by design) | shared-global | not applicable — public platform leaderboard — opt-in orgs only, platform clusters pinned |
| GET | `/api/learning` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/learning/proposals/:id/apply` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/learning/proposals/apply-all` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — merges the CALLER's own open proposals into its own policy — no parameter, nothing to cross |
| POST | `/api/learning/run` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — enqueues the learning period for the CALLER's org only — no parameter, nothing to cross |
| GET | `/api/members` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/onboarding/interpret` | yes | member+ (serve key or member session) | org-list | absent from other orgs' responses (probed) |
| GET | `/api/org-settings` | no | any org credential | self-scoped | not applicable — reads the CALLER's own org row — no cross-org parameter exists |
| PUT | `/api/org-settings` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — flips the CALLER's own model-semantics flag (0058) — no cross-org parameter exists |
| GET | `/api/pins` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| DELETE | `/api/pins/:clusterId` | yes | admin only (`serve+admin` key or admin session) | shared-global | not applicable — releases the CALLER's own pin; a cluster id is shared taxonomy, and another org's pin is unreachable by construction |
| PUT | `/api/pins/:clusterId` | yes | admin only (`serve+admin` key or admin session) | shared-global | not applicable — pins the CALLER's own org to a cluster from the shared taxonomy; the pin row it writes is org-scoped and the cluster id is not tenant data |
| POST | `/api/plan` | no | member+ (serve key or member session) | org-list | absent from other orgs' responses (probed) |
| POST | `/api/playground/chat` | yes | member+ (serve key or member session) | org-param | not applicable — body-named cluster resolves org-preferred with platform fallback; a foreign agent cluster has no platform frontier and 404s — same property the frontier probe asserts |
| POST | `/api/policies` | yes | member+ (serve key or member session) | self-scoped | not applicable — creates in the CALLER’s org; the keyId cross-org case is pinned in tenant-isolation.test.ts |
| GET | `/api/public/answers` | no | none (public by design) | public | not applicable — PLATFORM frontiers only, live-only, redaction-swept fail-closed (public-answers.test.ts) — no tenant data exists on this route |
| GET | `/api/public/share/:token/brief` | no | none (public by design) | public | not applicable — the token is the credential; the payload was frozen and custody-scanned at mint and carries no org identity |
| GET | `/api/public/share/:token/frontier` | no | none (public by design) | public | not applicable — the TOKEN is the credential; unknown/revoked tokens 404 uniformly (share.test.ts) |
| GET | `/api/public/share/:token/report` | no | none (public by design) | public | not applicable — as above; org identity comes from the token row, redacted by default |
| GET | `/api/recipes` | no | any org credential | shared-global | absent from other orgs' responses (probed) |
| POST | `/api/recipes/:hash/evaluate` | yes | admin only (`serve+admin` key or admin session) | shared-global | not applicable — recipes are content-addressed PLATFORM configs; unknown hashes 404 for everyone |
| GET | `/api/reports/guarantee` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/reports/savings` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/reports/savings.csv` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/research/cycle` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/research/cycles` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/research/frontier-notes` | no | admin only (`serve+admin` key or admin session) | non-tenant | not applicable — fleet clock status — platform ops, no org dimension in the response |
| POST | `/api/research/frontier-notes` | yes | admin only (`serve+admin` key or admin session) | non-tenant | not applicable — the fleet clock is platform ops — org fixed by env (org-research), disarmed without POTION_RESEARCH_* env |
| GET | `/api/research/promotions` | no | any org credential | shared-global | not applicable — platform research promotions — a shared asset by design, no org dimension in the response |
| POST | `/api/research/scan` | yes | admin only (`serve+admin` key or admin session) | non-tenant | not applicable — platform registry scan; the job carries the caller’s org for attribution only |
| GET | `/api/router` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/router/generations` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/router/generations` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — captures the CALLING org's own serving surface — no parameter, nothing to cross |
| POST | `/api/router/generations/:id/canary` | yes | admin only (`serve+admin` key or admin session) | org-param | not applicable — org-scoped getRouterGeneration → a foreign org's id is a uniform 404 (pinned in generations.test.ts) |
| GET | `/api/router/generations/:id/evidence` | no | any org credential | org-param | not applicable — org-scoped getRouterGeneration → a foreign org's id is a uniform 404 (pinned in generations.test.ts) |
| POST | `/api/router/generations/:id/promote` | yes | admin only (`serve+admin` key or admin session) | org-param | not applicable — org-scoped getRouterGeneration → a foreign org's id is a uniform 404 (pinned in generations.test.ts) |
| POST | `/api/router/generations/:id/rollback` | yes | admin only (`serve+admin` key or admin session) | org-param | not applicable — org-scoped getRouterGeneration → a foreign org's id is a uniform 404 (pinned in generations.test.ts) |
| POST | `/api/router/whatif` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/routing-activity` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/rubrics` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/rubrics/:id/approve` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/rubrics/:id/reject` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/rubrics/generate` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| GET | `/api/share` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/share` | yes | member+ (serve key or member session) | self-scoped | not applicable — mints a token for the CALLER’s org over a platform frontier |
| POST | `/api/share/:id/revoke` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/support` | yes | any org credential | self-scoped | not applicable — emails the CALLER's own message with its own org context attached — no cross-org parameter exists |
| GET | `/api/traces` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/traces/:traceId` | no | any org credential | org-param | uniform 404 (probed) |
| POST | `/api/traces/cluster` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — org forced into the job payload from the session |
| POST | `/api/traces/purge` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — org forced into the job payload from the session |
| POST | `/api/traces/redact` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — org forced into the job payload from the session |
| GET | `/api/traces/retention` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| PUT | `/api/traces/retention` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — sets the CALLER’s org retention |
| GET | `/api/usage` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/usage/aggregate` | yes | admin only (`serve+admin` key or admin session) | non-tenant | not applicable — admin-only platform rollup trigger; names no tenant resource |
| GET | `/api/usage/current` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/usage/export.csv` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| GET | `/api/usage/invoice` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/api/workloads` | yes | member+ (serve key or member session) | non-tenant | not applicable — cluster ASSIGNMENT over the platform taxonomy; reads/writes no tenant rows |
| POST | `/api/workloads/:id/adopt` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/workloads/:id/retire` | yes | admin only (`serve+admin` key or admin session) | org-param | uniform 404 (probed) |
| POST | `/api/workloads/discover` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — enqueues discovery for the CALLING org only — no parameter, nothing to cross |
| GET | `/api/workloads/discovered` | no | any org credential | org-list | absent from other orgs' responses (probed) |
| POST | `/hooks/lab/:token` | yes | none (public by design) | public | not applicable — addressed by an unguessable 48-hex secret, not an org or resource id; the token IS the capability and hashes to exactly one armed mission |

### Authentication (`/auth`)

| Method | Path | Mutating | Credential required | Tenancy class | Cross-org posture |
|---|---|---|---|---|---|
| POST | `/auth/invite` | yes | admin only (`serve+admin` key or admin session) | self-scoped | not applicable — membership lands in the INVITER’s org |
| POST | `/auth/logout` | yes | any org credential | self-scoped | not applicable — revokes the CALLER’s own session |
| GET | `/auth/me` | no | any org credential | self-scoped | not applicable — reports the caller’s own credential; forged-header cases in tenant-isolation.test.ts |
| GET | `/auth/providers` | no | none (public by design) | public | not applicable — pre-auth; deployment-wide configuration, carries no org or user data |
| POST | `/auth/request-link` | yes | none (public by design) | public | not applicable — pre-auth; neutral response, self-serve gated (G2.7) |
| GET | `/auth/verify` | yes | none (public by design) | public | not applicable — single-use token consumption; session pinned to the link’s org |
| POST | `/auth/verify-code` | yes | none (public by design) | public | not applicable — single-use code consumption; session pinned to the code’s org |

### Operator surface (`/operator`)

| Method | Path | Mutating | Credential required | Tenancy class | Cross-org posture |
|---|---|---|---|---|---|
| POST | `/operator/frontiers/platform-sweep` | yes | operator token | operator | not applicable — operator token surface — platform-scope spend job, no tenant dimension |
| GET | `/operator/jobs/:id` | no | operator token | operator | not applicable — operator token surface — the deliberate platform-job mirror |
| GET | `/operator/orgs` | no | operator token | operator | not applicable — operator token surface — outside the tenant model |
| POST | `/operator/orgs` | yes | operator token | operator | not applicable — operator token surface — outside the tenant model |
| DELETE | `/operator/orgs/:id` | yes | operator token | operator | not applicable — operator token surface — outside the tenant model |

### Infrastructure

| Method | Path | Mutating | Credential required | Tenancy class | Cross-org posture |
|---|---|---|---|---|---|
| GET | `/healthz` | no | none (public by design) | non-tenant | not applicable — no tenant dimension — process liveness |
| GET | `/metrics` | no | none (public by design) | non-tenant | not applicable — Prometheus scrape; org labels are HASHED (G2.4) and the surface is network-restricted by deployment posture |
| GET | `/readyz` | no | none (public by design) | non-tenant | not applicable — no tenant dimension — dependency readiness |
| POST | `/webhooks/stripe` | yes | none (public by design) | non-tenant | not applicable — public by necessity and SIGNATURE-VERIFIED — an unsigned or stale body is refused, so it cannot mark invoices paid |

## Provider-resolution sites (false-live audit)

A separate lens over the same discipline: can a **mock** provider, alias or
entry be selected, executed or recorded while the surrounding mode is
`live`? Sites are code locations rather than routes, so completeness is
grep-derived and enforced by `mock-eligibility.test.ts`.

| Site | Symbol | Kind | Posture under live | Pinned by |
|---|---|---|---|---|
| `apps/server/src/guarantee.ts` | runGuaranteeSample (judge resolution) | class-resolution | excluded-live | `apps/server/test/guarantee.test.ts` |
| `apps/server/src/routes/challengers.ts` | apply (aggregatesFromEvalResults + servingDecisionFor) | alias-guard | excluded-live | `apps/server/test/challengers.test.ts` |
| `apps/server/src/routes/chat.ts` | guardFrontierProvenance | alias-guard | excluded-live | `apps/server/test/provenance.test.ts` |
| `apps/server/src/routes/connection.ts` | clusterReadiness (guardFrontierProvenance) + providersForOrg | alias-guard | excluded-live | `apps/server/test/connection.test.ts` |
| `apps/server/src/routes/discovery.ts` | adopt (aggregatesFromEvalResults + servingDecisionFor) | alias-guard | excluded-live | `apps/server/test/workload-adoption.test.ts` |
| `apps/server/src/routes/generations.ts` | captureServingPins (servingDecisionFor) | alias-guard | excluded-live | `apps/server/test/generations.test.ts` |
| `apps/server/src/routes/keys.ts` | PostKeyBodySchema (provider enum) | byok-validate | excluded-live | `apps/server/test/keys.test.ts` |
| `apps/server/src/routes/plan.ts` | POST /api/plan (guardFrontierProvenance + selectPoint) | alias-guard | excluded-live | `apps/server/test/plan.test.ts` |
| `apps/server/src/routes/playground.ts` | resolvePlaygroundPoint | default-strategy | excluded-live | — |
| `apps/server/src/routing/compile-router.ts` | compileAndMintRouter (servingDecisionFor) | alias-guard | excluded-live | `apps/server/test/router.test.ts` |
| `apps/server/src/routing/holdout.ts` | eligibleIncumbent (mock exclusion under live) | alias-guard | excluded-live | `apps/server/test/holdout.test.ts` |
| `apps/server/src/routing/workload-assignment.ts` | resolveWorkloadSubAssignment (guardFrontierProvenance) | alias-guard | excluded-live | `apps/server/test/workload-adoption.test.ts` |
| `apps/server/src/shadow.ts` | runShadow (judge resolution) | class-resolution | excluded-live | `apps/server/test/shadow.test.ts` |
| `packages/harness/src/calibrate.ts` | runJudgeCalibration (providerMode guard) | alias-guard | refuses-live | `packages/harness/src/calibrate.test.ts` |
| `packages/harness/src/cli.ts` | potion-harness --provider (calibration + run wiring) | alias-guard | refuses-live | `packages/harness/src/calibrate.test.ts` |
| `packages/harness/src/runner.ts` | MockAliasInLiveRunError | alias-guard | refuses-live | `packages/harness/src/runner.test.ts` |
| `packages/harness/src/runner.ts` | providerModeOverride | mode-override | test-seam | `packages/harness/src/provenance.test.ts` |
| `packages/harness/src/serve-judge.ts` | defaultServeJudgeModel | class-resolution | excluded-live | `packages/harness/src/serve-judge.test.ts` |
| `packages/pareto/src/recompute.ts` | aggregatesFromEvalResults (providerMode filter) | aggregation-filter | excluded-live | `packages/pareto/src/provenance.test.ts` |
| `packages/pareto/src/recompute.ts` | hasLiveEvidence | aggregation-filter | excluded-live | `packages/workers/src/live-sweep.test.ts` |
| `packages/pareto/src/serving.ts` | DEFAULT_STRATEGY / liveDefaultStrategy / fallbackStrategyFor / servingDecisionFor | default-strategy | excluded-live | `apps/server/test/provenance.test.ts` |
| `packages/providers/src/factory.ts` | createProviders | factory | mode-blind | — |
| `packages/providers/src/scan.ts` | diffModelListings / isMockListingId | scan-stamp | excluded-live | `packages/workers/src/false-live.test.ts` |
| `packages/researcher/src/registry.ts` | buildRegistry | registry-build | mock-allowed-by-design | `packages/researcher/src/registry.test.ts` |
| `packages/researcher/src/registry.ts` | classRepresentative | class-resolution | excluded-live | `packages/researcher/src/registry.test.ts` |
| `packages/strategies/src/resolve.ts` | createResolver | factory | mode-blind | — |
| `packages/workers/src/handlers.ts` | frontierLiveSweepHandler (reachable filter) | registry-build | excluded-live | `packages/workers/src/live-sweep.test.ts` |
| `packages/workers/src/handlers.ts` | guaranteeSuiteVerifyHandler (judge resolution) | class-resolution | excluded-live | `packages/workers/src/suite-verify.test.ts` |
| `packages/workers/src/handlers.ts` | researchCycleHandler (candidate registry) | registry-build | excluded-live | `packages/workers/src/false-live.test.ts` |
| `packages/workers/src/handlers.ts` | rubricGenerateHandler (classRepresentative) | class-resolution | excluded-live | — |
| `packages/workers/src/handlers.ts` | tracesClusterHandler (suite judge + strategies) | class-resolution | mock-allowed-by-design | — |

## Deployment notes

- `/metrics` is an unauthenticated Prometheus scrape surface by convention.
  Org identifiers in metric labels are **hashed** (the same 6-character hash
  used in `agent-<orgHash6>-*` cluster ids), and the endpoint must still be
  network-restricted — defense in depth.
- The demo tenant's API credential is seeded **only** when
  `POTION_SEED_DEMO` is set; production boots carry no demo credential.
- Self-serve org provisioning is gated behind `POTION_SELF_SERVE`; operator
  onboarding is otherwise the only way an org comes into being.
