-- Potion 0006_metering (M2 Wave 2, ROADMAP #17/#18): rate-limit overrides +
-- the usage rollup table.
--   api_keys gains rate_rps / daily_cap / max_body_kb — NULL means "use the
--   platform default" (10 req/s, 10k req/day, 1 MiB body; see
--   apps/server/src/middleware/ratelimit.ts). Per-key overrides are set by
--   UPDATE on these columns (a keys-admin UI is Wave-2 follow-up).
--   usage_daily is the billing/usage source of truth at (org, UTC day,
--   cluster) grain, populated by the idempotent batch rollup
--   aggregateUsage() in packages/db/src/repos/usage.ts (NOT write-through
--   from the chat path — see the repo file for the rationale).
-- Idempotent: safe to run at every boot (IF NOT EXISTS throughout).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_rps integer;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS daily_cap integer;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS max_body_kb integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_daily (
  org_id text NOT NULL REFERENCES orgs(id),
  -- UTC calendar day 'YYYY-MM-DD' (text, not date: deterministic across the
  -- PGlite/node-postgres drivers and trivially comparable/groupable).
  day text NOT NULL,
  -- 'unassigned' when the request never resolved a cluster (kept NOT NULL so
  -- the PK holds and rollups never drop a row).
  cluster_id text NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  -- Customer-facing cost of served usage. Pricing v1 is pass-through
  -- (margin 0), so today this equals platform_cost_usd; the configurable
  -- margin is applied at invoice time (apps/server/src/billing).
  cost_usd double precision NOT NULL DEFAULT 0,
  -- Our price-table cost of the served usage (summed from
  -- request_logs.usage->>'costUsd').
  platform_cost_usd double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day, cluster_id)
);
