-- Potion 0023_org_frontiers (G1.6): per-org frontiers + schema-level
-- provenance. org_id (NULL = platform) lands on the four evidence tables;
-- reads become org-preferred with platform fallback; the (org, cluster,
-- version) unique turns the saveFrontier read-then-insert race into a
-- retryable conflict instead of a silently forked version chain.
-- OWNER RULE (provenance): every frontier point must carry links to the
-- evidence ids, rubric hashes, and calibration records it rests on — the
-- guarantee report is "here's your frontier and here's why we believe each
-- point". Evidence rides in frontiers.points jsonb (the serving read path)
-- and is mirrored on frontier_points.evidence for SQL audit.
-- Backfill runs BEFORE index creation: pre-G1.6 org rows are attributable
-- through clusters.org_id (agent-* clusters are org-owned since G1.2);
-- without it the new org predicates would silently orphan existing
-- evidence (resume-cache hits never re-insert, so rows would never get
-- re-stamped).
-- Idempotent: safe to run at every boot.
ALTER TABLE frontiers ADD COLUMN IF NOT EXISTS org_id text REFERENCES orgs(id);
--> statement-breakpoint
ALTER TABLE frontier_points ADD COLUMN IF NOT EXISTS org_id text REFERENCES orgs(id);
--> statement-breakpoint
ALTER TABLE frontier_points ADD COLUMN IF NOT EXISTS evidence jsonb;
--> statement-breakpoint
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS org_id text REFERENCES orgs(id);
--> statement-breakpoint
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS org_id text REFERENCES orgs(id);
--> statement-breakpoint
UPDATE frontiers SET org_id = c.org_id
  FROM clusters c
  WHERE frontiers.cluster_id = c.id AND c.org_id IS NOT NULL AND frontiers.org_id IS NULL;
--> statement-breakpoint
UPDATE frontier_points SET org_id = c.org_id
  FROM clusters c
  WHERE frontier_points.cluster_id = c.id AND c.org_id IS NOT NULL AND frontier_points.org_id IS NULL;
--> statement-breakpoint
UPDATE eval_results SET org_id = c.org_id
  FROM clusters c
  WHERE eval_results.cluster_id = c.id AND c.org_id IS NOT NULL AND eval_results.org_id IS NULL;
--> statement-breakpoint
UPDATE eval_runs SET org_id = c.org_id
  FROM clusters c
  WHERE eval_runs.options->>'agentCluster' = c.id AND c.org_id IS NOT NULL AND eval_runs.org_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS frontiers_org_cluster_version
  ON frontiers (org_id, cluster_id, version) NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS frontiers_cluster_org_version_idx
  ON frontiers (cluster_id, org_id, version DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS eval_results_cluster_prices_idx
  ON eval_results (cluster_id, prices_version) WHERE stale = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS eval_results_org_idx ON eval_results (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS eval_runs_org_idx ON eval_runs (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS frontier_points_frontier_idx ON frontier_points (frontier_id);
