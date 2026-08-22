-- 0044 — CONFIDENCE ON EVERY MEASURED CELL (mixing program, 2026-08-22).
--
-- The executors compute exp(mean token logprob) whenever a provider returns
-- logprobs; until now nothing asked for them and nothing stored them. The
-- harness now requests logprobs on every measured call and records the
-- producing stage's confidence here. This column is the training signal for
-- learned selectors and the realizability score for mixtures: "how much of a
-- pair's oracle headroom can a cheap switch actually capture?" is answerable
-- from it at $0. Nullable — Anthropic and Gemini expose no logprobs.
ALTER TABLE "eval_results" ADD COLUMN IF NOT EXISTS "confidence" double precision;
--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN IF NOT EXISTS "confidence_method" text;
