-- 0043 — THE AUTONOMOUS LEARNING LEDGER (SERVING-ROADMAP S7 / G9, leg L4).
--
-- Every live campaign this project has ever run was ledgered by hand, under
-- an explicit `KEY_RISK_ACCEPTED` risk acceptance, with projected-vs-actual
-- recorded before and after. That rule exists because a spend nobody wrote
-- down is a spend nobody can reconcile.
--
-- L4 removes the HUMAN from that loop, not the ledger. The operator's ruling
-- (S7 §4 D2): a standing daily cap the operator can switch on and off, rather
-- than a per-run approval. So the row that a person used to write by hand is
-- written by the job — before the money moves, not after — and carries the
-- same three numbers plus the thing a hand-written row never had: WHY this
-- run and not another one.
--
--   gap_reason + cell_key    the demand that justified the spend. Without it
--                            an autonomous ledger is a list of charges with
--                            no argument attached.
--   projected_usd            the cap the run was authorized to spend, written
--                            BEFORE it ran. A row that exists with no actual
--                            is a run that died mid-flight — visible, not
--                            silently absent.
--   actual_usd               what it really cost. NULL until the run lands.
--
-- Status is not derived from the presence of actual_usd: 'refused' runs are
-- rows too, and they are the ones worth reading when the loop looks idle.

CREATE TABLE IF NOT EXISTS learning_runs (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- 'planned' (dry run), 'running', 'completed', 'failed', 'refused'.
  status text NOT NULL,
  -- The demand cell that justified this run, and what was wrong with its
  -- coverage (core/coverage.ts CoverageReason). Both nullable: a refusal
  -- before gap selection has neither, and saying so beats inventing one.
  cell_key text,
  cluster_id text,
  gap_reason text,
  gap_score double precision,
  -- The capability narrowing derived from gap_reason and handed to the
  -- sweep — recorded so the run's candidate set is reconstructable.
  capability_filter jsonb,
  projected_usd double precision NOT NULL,
  actual_usd double precision,
  -- Frontier points the run published, once it lands.
  points_published integer,
  -- Refusal reason or error detail. A refused run explains itself in the
  -- ledger rather than only in a log line that rotates away.
  detail text
);
--> statement-breakpoint

-- The daily-cap read is "what has autonomous learning already spent today",
-- which scans by start time across all runs.
CREATE INDEX IF NOT EXISTS learning_runs_started_idx ON learning_runs (started_at);
--> statement-breakpoint

-- PREMIUM PRIORITY (S7 L4, operator ruling: autonomous measurement is a
-- switchable, sellable capability).
--
-- What is sold is not access to other customers' data — a demand cell is an
-- aggregate over ≥k orgs and nothing about it is anyone's to sell. What is
-- sold is ORDER: when Potion's autonomous budget can afford one measurement
-- today, a priority org's unmet demand is measured first.
--
-- The flag therefore affects RANKING ONLY. It never lowers the k-gate, never
-- attaches an org to a published cell, and never routes anything anywhere.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS learning_priority boolean NOT NULL DEFAULT false;
