-- Pricing v2 (operator decision 2026-08-25): the invoice's savings-share line
-- needs the serve-time counterfactual IN the billing rollup, not in
-- retention-pruned logs. The rollup query has computed this sum since 0039;
-- now it is persisted. Backfill happens on the next idempotent rollup run.
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS baseline_cost_usd double precision NOT NULL DEFAULT 0;
