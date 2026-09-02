-- G2 rung 1 (2026-09-01): ORG WORKLOAD DISCOVERY — the fixed taxonomy
-- becomes a PRIOR, and the org's own consented learning samples reveal the
-- sub-workloads that actually exist inside each serving cluster. Rows are
-- OBSERVED structure only (status 'observed'): nothing routes by them yet —
-- routing adoption is a later rung, explicit and never silent. Snapshot
-- semantics: each discovery run replaces the org's rows (current structure,
-- not history). Labels are never fabricated: the exemplar text IS the
-- (already-redacted) medoid sample.
CREATE TABLE IF NOT EXISTS "org_workloads" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "parent_cluster" text NOT NULL,
  "sample_count" integer NOT NULL,
  "cohesion" double precision NOT NULL,
  "exemplar_text" text NOT NULL,
  "centroid" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'observed',
  "window_days" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_workloads_org_idx" ON "org_workloads" ("org_id", "parent_cluster");
