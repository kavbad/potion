-- Potion 0019_calibration_spearman (G1.2 pre-work, owner-directed): rank
-- correlation on calibration records. A large spearman-pearson gap means the
-- judge RANKS answers correctly on a compressed/shifted scale — monotone
-- recalibration territory — distinct from "cannot rank" (untrustworthy).
-- Additive; pre-0019 rows carry NULL (pairs are stored, so it is re-derivable).
ALTER TABLE judge_calibrations ADD COLUMN IF NOT EXISTS spearman_vs_truth double precision;
