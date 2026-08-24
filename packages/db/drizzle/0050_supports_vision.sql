-- G (2026-08-23): vision capability LEARNED onto the registry from evidence.
-- A model gets supports_vision=true only when a vision-instrument cell
-- exists for it — measured, never claimed. Models that error on image input
-- stay NULL (unknown-excluded, the same posture as supports_tools).
ALTER TABLE models ADD COLUMN IF NOT EXISTS supports_vision boolean;
--> statement-breakpoint
UPDATE models SET supports_vision = true WHERE alias IN (
  SELECT DISTINCT (strategy_config->>'model')
  FROM eval_results
  WHERE instrument = 'vision' AND strategy_config->>'type' = 'single'
);
