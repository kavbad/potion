-- Potion 0009_share (M4, ROADMAP #31, SPEC §13.3): shareable read-only links
-- for frontier charts + savings reports.
--   share_tokens: one row per minted share link. The RAW token (`st_…`) is
--   returned to the creator exactly once and is NEVER stored — only its
--   sha256 (token_hash, globally unique — the lookup identity of the public
--   /api/public/share/:token/* endpoints). kind selects the public renderer:
--   'frontier' → /share/f/:token (payload.clusterId), 'report' →
--   /share/r/:token (payload.windowDays). redact_names (default true) strips
--   org-identifying fields (org name/id) from the public payload; cluster
--   names + strategy labels are platform evidence and always stay. revoked_at
--   set by POST /api/share/:id/revoke (admin) — a revoked link 404s,
--   indistinguishable from an unknown one (no existence oracle).
--   org_id is the tenant scope (M2 #13): mint/list/revoke are org-scoped;
--   rows are NEVER shared across orgs.
-- Idempotent: safe to run at every boot (IF NOT EXISTS throughout).
CREATE TABLE IF NOT EXISTS share_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id),
  kind text NOT NULL CHECK (kind IN ('frontier', 'report')),
  payload jsonb NOT NULL DEFAULT '{}',
  token_hash text NOT NULL UNIQUE,
  redact_names boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS share_tokens_org_created_idx ON share_tokens(org_id, created_at);
