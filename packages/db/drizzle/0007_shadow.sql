-- Potion 0007_shadow (M3, ROADMAP #21, SPEC §12.4): shadow mode evidence.
--   shadow_results: one row per shadow-candidate execution. When a served
--   request is sampled (policy.shadow.sampleRate, per-request), up to 2
--   candidate strategies re-execute AFTER the primary response was sent and
--   each outcome lands here: candidate quality (deterministic in-process
--   scorer, NULL while a queued shadow:judge job is pending), cost and
--   latency. The savings report (GET /api/reports/savings) projects
--   per-candidate spend from these rows + the request_logs usage rollup.
--   org_id is the tenant scope (M2 #13); shadow rows are NEVER shared
--   across orgs. request_id is the chat completion id (chatcmpl-…) — a
--   correlation label, not an FK (request_logs rows are keyed by bigserial).
-- Idempotent: safe to run at every boot (IF NOT EXISTS throughout).
CREATE TABLE IF NOT EXISTS shadow_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id),
  request_id text,
  cluster_id text NOT NULL,
  primary_hash text NOT NULL,
  candidate_hash text NOT NULL,
  candidate_model text NOT NULL,
  -- NULL while a queued shadow:judge job is pending (live mode); the
  -- in-process deterministic scorer always writes a value.
  quality double precision,
  cost_usd double precision NOT NULL,
  latency_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shadow_results_org_created_idx ON shadow_results(org_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shadow_results_org_cluster_idx ON shadow_results(org_id, cluster_id);
