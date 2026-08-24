-- P1-8 (2026-08-24): reasoning marks persisted onto the registry. Until now
-- the mark lived in process memory (seeded from POTION_REASONING_MODELS), so
-- every restart re-paid one wasted customer call per reasoning model before
-- the skip-below-budget guard re-learned it. NULL = unknown; true = observed
-- (reasoning tokens in usage, or an empty answer that exhausted its budget).
-- Never guessed from a model name — same evidence-only posture as
-- supports_tools / supports_vision.
ALTER TABLE models ADD COLUMN IF NOT EXISTS reasoning boolean;
