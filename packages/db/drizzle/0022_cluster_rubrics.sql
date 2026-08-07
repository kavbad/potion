-- Potion 0022_cluster_rubrics (G1.5): per-cluster generated rubrics with a
-- customer-visible review lifecycle. A rubric is generated from cluster
-- exemplars (admin-triggered, capped, metered), probe-calibrated, and only
-- USED after human approval — status is the gate, and the partial unique
-- index makes "the approved rubric for a cluster" a total function.
-- status_reason is first-class: rejected/uncalibrated rubrics stay visible
-- WITH the why (owner rule: customers see everything derived from their
-- data, paired with status + evidence — never hidden).
-- Also: judge_calibrations gains rubric_hash — rubric identity was invisible
-- to every invalidation and evidence path before dynamic rubrics existed.
-- NULL = pre-0022 rows (CALIBRATION_RUBRIC or serve-path, unrecorded).
-- Idempotent: safe to run at every boot.
CREATE TABLE IF NOT EXISTS cluster_rubrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id),
  cluster_id text NOT NULL,
  suite_id text NOT NULL,
  rubric_text text NOT NULL,
  rubric_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  status_reason text,
  reviewed_at timestamptz,
  generator_model text NOT NULL,
  provider_mode text NOT NULL DEFAULT 'mock',
  exemplar_count integer NOT NULL DEFAULT 0,
  calibration_id uuid,
  spend_usd double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS cluster_rubrics_one_approved
  ON cluster_rubrics(cluster_id) WHERE status = 'approved';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cluster_rubrics_org_idx
  ON cluster_rubrics(org_id, created_at);
--> statement-breakpoint
ALTER TABLE judge_calibrations ADD COLUMN IF NOT EXISTS rubric_hash text;
