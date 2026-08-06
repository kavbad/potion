-- Potion 0004_auth (M2 Wave 2, ROADMAP #14): dashboard auth — magic-link
-- sign-in + user sessions, the identity layer RBAC rides on.
--   sessions:     one row per verified sign-in. Raw tokens are NEVER stored —
--                 only sha256(token) (token_hash, globally unique). A session
--                 is pinned to the org the user signed into (org_id), so the
--                 role lookup is one membership read (resolveOrgContext's
--                 session path). expires_at + revoked_at support TTL + logout.
--   magic_links:  single-use sign-in/invite links, keyed by token_hash (raw
--                 token never stored). email (not user_id) because a link can
--                 target a not-yet-provisioned user (auto-provision + invite
--                 flows). consumed_at enforces single-use; expires_at the TTL.
-- Additive only: 0003 tables are untouched.
-- Idempotent: safe to run at every boot (IF NOT EXISTS everywhere).
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  org_id text NOT NULL REFERENCES orgs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS magic_links (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  org_id text NOT NULL REFERENCES orgs(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links(email);
