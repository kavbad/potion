-- Lab Step 10: superpower grants — the FIRST reversible secret store.
-- OAuth tokens must be read back to be used, so this row carries sealed
-- envelopes (packages/custody AES-256-GCM, per-row data key wrapped by
-- POTION_MASTER_KEY) — NEVER plaintext, and never selected by any
-- route-facing read (repos/lab-grants.ts excludes the envelope columns;
-- repos/lab-grants-runtime.ts is the worker-only read, import-fenced).
-- Schema-ADDITIVE under rule 2 (the 0035 pattern): org_id NOT NULL
-- REFERENCES orgs(id), erased by deleteOrgCascade, cascade coverage proven
-- at birth by the F5 meta-test. One grant per connector per org in v1.
CREATE TABLE IF NOT EXISTS lab_superpower_grants (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  connector_id text NOT NULL,
  superpower_id text NOT NULL,
  scopes_granted jsonb NOT NULL,
  token_envelope text NOT NULL,
  refresh_envelope text,
  token_expires_at timestamptz,
  status text NOT NULL,
  granted_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS lab_superpower_grants_org_connector
  ON lab_superpower_grants (org_id, connector_id);
