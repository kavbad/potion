-- Potion 0025_guarantee_report (G2.1): incumbent baseline + trust hierarchy
-- + the quality↔spend correlation column.
--
-- TRUST HIERARCHY (owner standing decision, 2026-08-07; G2.2 binds SLAs to
-- it): serve-path floor crossings (floor derived from the INCUMBENT's own
-- serve-path distribution — same scale as the comparison) are ADVISORY
-- TRIGGERS that enqueue an anchored suite re-eval; only SUITE-leg evidence
-- (serving strategy + designated incumbent re-evaluated on the derived
-- suite, retention on identical items) renders the CONTRACTUAL verdict.
-- Hence: cluster_incumbents (the designation, at most one active per
-- (org, cluster) — the cluster_rubrics lifecycle shape) and the new
-- incidents kind 'advisory' (durable, dedupable, resolvable tripwire rows
-- that can never become rollback sources — readers filter by kind).
--
-- request_logs.completion_id: the chat completion id (chatcmpl-…) as a
-- correlation label, not an FK — joins quality_samples.request_id so
-- quality finally meets spend/latency per request.
-- Idempotent: safe to run at every boot.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS completion_id text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS request_logs_completion_id_idx
  ON request_logs(completion_id) WHERE completion_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cluster_incumbents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id),
  cluster_id text NOT NULL,
  strategy_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  status_reason text,
  designated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS cluster_incumbents_one_active
  ON cluster_incumbents(org_id, cluster_id) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cluster_incumbents_org_idx
  ON cluster_incumbents(org_id, designated_at);
--> statement-breakpoint
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_kind_check;
--> statement-breakpoint
ALTER TABLE incidents ADD CONSTRAINT incidents_kind_check
  CHECK (kind IN ('quality_breach', 'rollback', 'advisory'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS eval_results_cluster_hash_prices_idx
  ON eval_results (cluster_id, strategy_hash, prices_version) WHERE stale = false;
