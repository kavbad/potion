-- Team invites (P0-2, 2026-08-24): a partner's second engineer could not
-- sign in at all — memberships existed only via the operator route. An
-- invite authorizes an email for an org; the existing magic-link flow
-- proves possession; verification converts invite → membership.
CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  invited_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS invites_email_open_idx ON invites (email, created_at DESC);
