-- Potion 0002_provenance (ADDITIVE, M1a): evidence-integrity columns.
--   eval_results.provider_mode / frontier_points.provider_mode:
--     'mock' | 'live' | 'unknown'. DEFAULT 'unknown' makes ABSENCE explicit —
--     a row whose provenance was never recorded can never masquerade as live
--     evidence (the serve-time guard and the dashboard treat 'unknown' like
--     'mock'). A 'live' DEFAULT would have laundered every pre-M1a row into
--     fake live evidence.
--   eval_results.stale: set by the M1a staleness engine (markStale) when the
--     prices/judge/model versions a row was measured under drift from the
--     current ones; aggregates exclude stale rows by default.
-- Idempotent: safe to run at every boot (ADD COLUMN IF NOT EXISTS + guarded
-- constraint creation).
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS provider_mode text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'eval_results_provider_mode_check') THEN
    ALTER TABLE eval_results ADD CONSTRAINT eval_results_provider_mode_check
      CHECK (provider_mode IN ('mock', 'live', 'unknown'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS stale boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE frontier_points ADD COLUMN IF NOT EXISTS provider_mode text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'frontier_points_provider_mode_check') THEN
    ALTER TABLE frontier_points ADD CONSTRAINT frontier_points_provider_mode_check
      CHECK (provider_mode IN ('mock', 'live', 'unknown'));
  END IF;
END $$;
