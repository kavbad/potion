-- Potion 0011_budgets (M4, ROADMAP #35, SPEC §13.7): budget autopilot.
--   budgets: one row per org (org_id IS the pk). monthly_cap_usd is the
--   customer-facing MTD cap (request_logs.usage->>'costUsd' rollup — the
--   same number /api/usage/current reports). hard_stop=false (SOFT cap,
--   the default) NEVER blocks serving — warn_pct drives the warn crossing
--   (percentage of cap, default 80). hard_stop=true makes the serving path
--   fail-closed at the cap (429 budget_exceeded; MTD read is cached 60s
--   per org — see apps/server/src/budget.ts).
--   budget_events: the budget:evaluate worker's DEDUP LEDGER (documented
--   choice — SPEC §13.7 allows alert_deliveries or a ledger; a ledger is
--   exact and rule-independent). One row per (org_id, kind, UTC day):
--   the worker inserts ON CONFLICT DO NOTHING and only emits the alert
--   (alerts:dispatch) when the insert landed, so a kind fires at most once
--   per org per day no matter how often the evaluator runs.
-- Idempotent: safe to run at every boot (IF NOT EXISTS throughout).
CREATE TABLE IF NOT EXISTS budgets (
  org_id text PRIMARY KEY REFERENCES orgs(id),
  monthly_cap_usd double precision NOT NULL,
  hard_stop boolean NOT NULL DEFAULT false,
  warn_pct int NOT NULL DEFAULT 80,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS budget_events (
  org_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('budget_warning', 'budget_exceeded')),
  day text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, kind, day)
);
