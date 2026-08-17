-- 0039 — BILLING TRUTH (SERVING-ROADMAP S3, legs 1 and 3).
--
-- The operator's pricing model is usage-based for customers who do NOT bring
-- their own provider key, moving to outcome-based (a share of money saved)
-- later. Neither is billable against what request_logs records today:
--
--   WHO PAID is absent. `OrgProviders.byok` is computed on every request and
--   consumed nowhere durable, and usage_daily.platform_cost_usd is the SAME
--   SQL expression as cost_usd (repos/usage.ts) — so platform-funded and
--   customer-funded spend are indistinguishable after the fact. An invoice
--   that cannot separate them is not an invoice.
--
--   WHAT IT SAVED is absent, and this is the one with a DEADLINE. "Money
--   saved" is a comparison, and the thing compared against — the price table
--   and the frontier as they stood at serve time — both drift. Recorded per
--   request it is a fact; reconstructed next quarter it is an estimate built
--   on numbers that have since changed. Outcome pricing is not immediate,
--   but the evidence for it has to start accruing before it is wanted.
--
-- Both columns are NULLABLE and unwritten by any pre-0039 row: this is a new
-- fact about new traffic, never a backfilled guess. Absence reads as "we did
-- not record this", which is true, rather than as a zero that would quietly
-- enter a sum.

-- 'platform' = Potion's own provider key funded this request (billable to
-- the customer under usage pricing). 'byok' = the customer's own key did
-- (their provider bills them directly). NULL = pre-0039, or a request that
-- never reached execution (auth failures, budget refusals) and so cost
-- nothing to anybody.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS paid_by text;
--> statement-breakpoint

-- What this same request would have cost on the frontier's HIGHEST-QUALITY
-- point — the honest counterfactual for "what if you had just always used
-- the best model", which is the alternative a customer is actually choosing
-- between.
--
-- METHOD (see baselineCostUsd in apps/server/src/routes/chat.ts): the real
-- cost of this request scaled by the RATIO of the two points' measured
-- costPer1K. Not a re-pricing of tokens against the baseline model — that
-- is ill-defined for composite strategies, where token counts do not map to
-- one model. The ratio shares a measurement basis with itself and cancels,
-- and its one assumption — that the cost ratio between two strategies does
-- not depend on request size — is exactly true under per-token pricing and
-- approximately true otherwise.
--
-- NOT a savings claim by itself: savings = baseline_cost_usd − actual cost,
-- and that subtraction belongs to the reporting layer where it can be shown
-- with its provenance. Stored raw so the arithmetic stays auditable.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS baseline_cost_usd double precision;
--> statement-breakpoint

-- The invoice and savings reads are both (org, day, paid_by) scans over
-- served rows; without this they are sequential scans over the whole table
-- once traffic is real.
CREATE INDEX IF NOT EXISTS request_logs_org_paid_by_ts_idx
  ON request_logs (org_id, paid_by, ts);
