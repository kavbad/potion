# Enterprise: SSO + Audit Export (ROADMAP #34, SPEC §13.6)

The two enterprise table-stakes: single sign-on against your IdP, and a
unified audit trail you can export to your SIEM.

## SSO (OIDC)

Potion supports OpenID Connect **authorization-code flow with PKCE** for the
dashboard. Magic-link auth remains the default and is untouched when SSO is
not configured — there is no mixed-mode confusion: the OIDC routes simply do
not exist until all four env vars are set.

### Configuration

Set the full quartet (any missing var → OIDC off, magic-link stays default):

| Var                        | Example                                        |
|----------------------------|------------------------------------------------|
| `POTION_OIDC_ISSUER`       | `https://yourco.okta.com`                      |
| `POTION_OIDC_CLIENT_ID`    | `0oa1example…`                                 |
| `POTION_OIDC_CLIENT_SECRET`| `•••`                                          |
| `POTION_OIDC_REDIRECT_URI` | `https://potion.yourco.com/auth/oidc/callback` |

Optional: `POTION_DASHBOARD_URL` when the dashboard lives on a different
origin than the API (the post-login redirect target).

### IdP setup

1. Register a **web / authorization-code** application at your IdP
   (Okta, Entra ID, Google Workspace, Auth0, Keycloak all work).
2. Allowed redirect URI: exactly `…/auth/oidc/callback` on the API origin.
3. Scopes: `openid email profile` (the email claim is required — it maps to
   the Potion user).
4. Point users at `GET /auth/oidc/login` (link it from your SSO portal or
   your own sign-in page).

### Security checklist (what the implementation enforces)

- **PKCE S256** on every authorization request; the verifier is sealed in a
  10-minute HMAC-signed `potion_oidc` cookie, never in the URL.
- **State + nonce**: exact state match on callback (login-CSRF), nonce match
  inside the id_token (replay).
- **id_token verification**: RS256 only (no HS*/none downgrade), signature
  verified against the IdP's discovered JWKS (cached 10 min; one refetch on
  unknown kid for rotation), plus `iss` / `aud` / `exp` checks.
- **Provisioning**: the email claim maps to a user through the *same*
  create-or-get + solo-org auto-provisioning the magic-link flow uses, and
  the session minted is the *same* `potion_session` cookie — SSO users get
  byte-identical semantics, and every OIDC login writes an `auth_events`
  row with `method='oidc'`.
- Token exchange uses `client_secret_post` (supported by Okta/Entra/Google).

### Deferred, deliberately

- **SAML** — OIDC covers the IdPs that matter first (Okta/Entra/Google all
  speak OIDC natively); SAML adds an XML/Signature stack for marginal
  coverage. `/auth/saml/*` stays **reserved** (404) so a later build can
  claim it without breaking this contract.
- **SCIM** — provisioning via invite links + solo-org auto-provisioning is
  enough for the current tenant model. `/scim/*` likewise reserved.

## Audit export

One unified chronology over the three event sources, org-scoped and
admin-only:

| Source          | Kind prefix      | Examples                                  |
|-----------------|------------------|-------------------------------------------|
| `custody_audit` | `custody.*`      | key encrypt/decrypt/rotate/revoke/validate |
| `auth_events`   | `auth.*`         | login / logout / invite (magic-link + OIDC)|
| `incidents`     | `incident.*`     | quality_breach / rollback                  |

### Endpoints

- `GET /api/audit` — recent 100 unified events, newest first. Powers the
  dashboard `/settings/audit` page. Admin only.
- `GET /api/audit/export.jsonl?from&to` — JSONL download. `from`/`to` are
  **required** (ISO dates or datetimes) and the window is bounded to
  **92 days**. The body is **streamed** (chunked source reads, k-way merged
  by timestamp — never fully buffered) with
  `Content-Disposition: attachment; filename="potion-audit-<org>-<from>-<to>.jsonl"`.

### Line schema

```json
{"ts":"2026-07-01T11:00:00.000Z","kind":"auth.login","actor":"admin@yourco.com","detail":{"method":"oidc"},"ip":"10.0.0.9","requestId":"req-…"}
```

- `ts` — ISO-8601 event time; the export is ascending.
- `actor` — user id, email, api-key id, or a system actor.
- `ip` / `requestId` — present where the source captures them
  (`auth_events` does; custody/incident rows predate per-request capture →
  `null`).
- `detail` — source-specific metadata; **never** key material or
  credentials (the custody boundary is unbroken here too).

### Feeding a SIEM

```bash
curl -H "Authorization: Bearer pk_…" \
  'https://potion.yourco.com/api/audit/export.jsonl?from=2026-07-01&to=2026-07-31' \
  -o potion-audit-july.jsonl
```

Note: api keys need the **`admin` scope** (`serve+admin`) for audit reads —
serve-only keys get 403, same as every admin route (M2 #15 discipline).

## RBAC recap

| Role   | Can                                                        |
|--------|------------------------------------------------------------|
| viewer | read everything org-scoped (usage, frontiers, reports, audit **no**) |
| member | + write methods (playground, share links, eval runs)       |
| admin  | + key lifecycle, invites, budget, alert rules, **audit reads/exports**, incident resolve |

Api-key credentials (G2.3 key role split): the key's ROLE derives from its
scopes at resolution. `serve` (the default) resolves to **member grade** —
serving, org reads, and self-service mutations (policy create, workloads,
evals, share mint), but **no admin mutations**: a serving key cannot resolve
incidents, designate incumbents, toggle budgets, manage alert rules, run
rubric/research/trace operations, or trigger spend-bearing live sweeps.
`serve+admin` resolves to **admin grade** — the explicit choice at mint.
FAIL CLOSED: an empty, malformed, or unrecognized scopes value resolves to
serve-only; a typo can never mint an admin credential. The full route-by-
route classification lives in `apps/server/test/fixtures/route-inventory.ts`
and is enforced by an exhaustive test.

## Related surfaces

- Operator onboarding + org offboarding (TRUE-CASCADE deletion): `docs/ONBOARDING-RUNBOOK.md`.

- **Alerts & integrations** (#33): webhook/Slack rules for
  `quality_breach`, `rollback`, `budget_warning`, `budget_exceeded`,
  `breaker_open` — the push complement to the audit pull. Target URLs are
  write-only over the API (listed masked: scheme+host only).
- **Budget autopilot** (#35): monthly cap + optional hard stop + anomaly
  alerts; see `GET/PUT /api/budgets` and the dashboard budget card on
  `/reports`.
