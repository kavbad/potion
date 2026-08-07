-- Potion 0021_derived_suites (G1.3): suites synthesized from customer traces
-- move OFF worker-local disk into governed storage. derived_suites is the
-- provenance row (org attribution the disk manifests never carried);
-- derived_suite_items carry source_trace_id + created_at so trace retention
-- can purge by time window. days=0 retention empties items but keeps the
-- provenance stub. Authored (checked-in) suites stay repo files — the
-- discriminator is the agent- id prefix.
-- Idempotent: safe to run at every boot.
CREATE TABLE IF NOT EXISTS derived_suites (
  suite_id text PRIMARY KEY,
  cluster_id text NOT NULL,
  org_id text NOT NULL REFERENCES orgs(id),
  manifest jsonb NOT NULL,
  version text NOT NULL DEFAULT '1.0.0',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS derived_suites_org_idx ON derived_suites(org_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS derived_suite_items (
  suite_id text NOT NULL REFERENCES derived_suites(suite_id) ON DELETE CASCADE,
  item_id text NOT NULL,
  cluster_id text NOT NULL,
  prompt jsonb NOT NULL,
  reference jsonb,
  scoring jsonb NOT NULL,
  source_trace_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (suite_id, item_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS derived_suite_items_created_idx
  ON derived_suite_items(suite_id, created_at);
