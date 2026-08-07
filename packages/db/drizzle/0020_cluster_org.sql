-- Potion 0020_cluster_org (G1.2): customer-derived clusters are TENANT data.
-- org_id NULL = platform (static taxonomy + pre-G1.2 grandfathered agent
-- rows, which are demo-grade mock artifacts); non-NULL = the owning org.
-- Ownership checks read this column — ids are never parsed. New agent
-- clusters are additionally id-partitioned as agent-<orgHash6>-<slug6> so
-- frontiers/eval evidence/suite dirs (free-text cluster keys) partition
-- without schema changes on those tables.
-- Idempotent: safe to run at every boot.
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS org_id text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS clusters_org_idx ON clusters(org_id);
