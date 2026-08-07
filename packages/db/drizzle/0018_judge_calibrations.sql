-- Potion 0018_judge_calibrations (G0.2): judge-trust evidence. One row per
-- calibration run of ONE judge against DETERMINISTIC ground truth (exact /
-- field-match / code-exec items): the judge re-scores answers whose true
-- quality is known, and pearson_vs_truth measures whether the judge can be
-- trusted to stand behind a guarantee. Platform-global (recipe_status
-- precedent: text keys, no FKs — evidence outlives configs).
--   judge_resolved_model — the prices-resolved provider-native id (the SAME
--   resolution as the eval cache key's judgeVersion), so calibration records
--   go stale in lockstep with eval rows when the judge alias is repointed.
--   provider_mode — 0002 provenance convention: a mock calibration must
--   never read as live evidence ('unknown' is treated as simulated).
--   pairs — content-free evidence: {itemId, truth, scores{judge:score}}.
-- Idempotent: safe to run at every boot.
CREATE TABLE IF NOT EXISTS judge_calibrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id text,
  suite_id text,
  judge_model text NOT NULL,
  judge_resolved_model text NOT NULL,
  answerer_model text NOT NULL,
  prices_version text NOT NULL,
  provider_mode text NOT NULL DEFAULT 'unknown'
    CONSTRAINT judge_calibrations_provider_mode_check
    CHECK (provider_mode IN ('mock', 'live', 'unknown')),
  n integer NOT NULL,
  pearson_vs_truth double precision,
  judge_agreement double precision,
  mean_abs_err double precision,
  flagged boolean NOT NULL,
  spend_usd double precision NOT NULL DEFAULT 0,
  pairs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS judge_calibrations_judge_created_idx
  ON judge_calibrations(judge_model, provider_mode, created_at);
