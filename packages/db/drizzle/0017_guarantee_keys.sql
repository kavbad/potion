-- Potion 0017_guarantee_keys (G0.3): quality_samples evidence is keyed
-- (org, policy, cluster, strategy) so breach windows evaluate exactly the
-- population they govern. Fixes two misattributions of the (org, strategy)
-- era: one strategy serving N clusters produced N identical incidents from
-- one pooled mean, and two policies sharing a strategy pooled their samples.
-- Window queries are STRICTLY keyed — rows with NULL keys (pre-G0.3, incl.
-- the retired Jaccard-stub era) are excluded from evidence.
-- Idempotent: safe to run at every boot.
ALTER TABLE quality_samples ADD COLUMN IF NOT EXISTS cluster_id text;
--> statement-breakpoint
ALTER TABLE quality_samples ADD COLUMN IF NOT EXISTS policy_id text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS quality_samples_keyed_window_idx
  ON quality_samples(org_id, policy_id, cluster_id, strategy_hash, created_at);
