-- Potion 0016_guarantee_judge (G0.1): quality_samples become auditable
-- judge evidence. The Jaccard stub is retired — every sampled served answer
-- is scored by a real llm-judge call (mock-judge fixture in mock mode,
-- labeled). Additive columns (rows from the stub era carry NULLs):
--   scorer         — scorer label, e.g. 'llm-judge:judge-class'
--   judge_model    — the judge model alias that produced the score
--   judge_cost_usd — the judge call's provider spend (also metered as a
--                    status='guarantee_judge' request_logs row, which the
--                    usage rollup counts toward org COST but never toward
--                    served request/token counts)
-- Idempotent: safe to run at every boot.
ALTER TABLE quality_samples ADD COLUMN IF NOT EXISTS scorer text;
--> statement-breakpoint
ALTER TABLE quality_samples ADD COLUMN IF NOT EXISTS judge_model text;
--> statement-breakpoint
ALTER TABLE quality_samples ADD COLUMN IF NOT EXISTS judge_cost_usd double precision;
