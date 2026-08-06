-- Potion 0012_auth_events (M4, ROADMAP #34, SPEC §13.6): enterprise audit —
-- the auth-event trail feeding the unified audit export, plus the org
-- leaderboard opt-in flag (surface needed by ROADMAP #32).
--
--   auth_events: append-only trail of auth-side actions — magic-link and
--   OIDC logins, logouts, and admin invites. custody_audit (0005) covers
--   key lifecycle; incidents (0008) cover guarantee events; auth_events
--   closes the gap so /api/audit/export.jsonl can present ONE unified
--   org-scoped chronology. actor is the ACTOR'S EMAIL (human-readable in
--   exports; the sessions table already carries user ids). ip + request_id
--   are captured from the request for correlation with the observability
--   request id (M3 #26). detail NEVER contains credentials, tokens, or
--   secrets — operational metadata only (e.g. { invitedRole }).
--
--   orgs gains publish_to_leaderboard (boolean, NOT NULL DEFAULT false) —
--   the opt-in flag the public leaderboard (ROADMAP #32) will read.
--   Default false: existing orgs stay private unless they explicitly opt in.
--
-- Additive + idempotent: safe to run at every boot (IF NOT EXISTS
-- throughout; guarded constraint creation).
CREATE TABLE IF NOT EXISTS auth_events (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  -- 'login' | 'logout' | 'invite'
  kind text NOT NULL,
  -- 'magic_link' | 'oidc'
  method text NOT NULL,
  -- the acting user's email (invitee's email for kind='invite')
  actor text NOT NULL,
  ip text,
  -- Fastify request id (x-request-id honored inbound) — correlation with
  -- the observability logs/metrics.
  request_id text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_events_kind_check') THEN
    ALTER TABLE auth_events ADD CONSTRAINT auth_events_kind_check
      CHECK (kind IN ('login', 'logout', 'invite'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_events_method_check') THEN
    ALTER TABLE auth_events ADD CONSTRAINT auth_events_method_check
      CHECK (method IN ('magic_link', 'oidc'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_events_org_created_idx ON auth_events(org_id, created_at);
--> statement-breakpoint
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS publish_to_leaderboard boolean NOT NULL DEFAULT false;
