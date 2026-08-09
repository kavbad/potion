-- 0029 — durable guarantee verdicts (post-capstone item 0, completing G2.8's
-- blocking finding).
--
-- WHY. Pre-0029, a suite-verify verdict was durable ONLY when it went badly:
-- a contractual breach wrote an incident, and an all-clear wrote nothing
-- unless an advisory happened to be attached. G2.8's 1.0645 all-clear left no
-- record at all — no inputs, no seed, no pairing — which is precisely why it
-- could never be root-caused. The instrument recorded its failures and not its
-- passes.
--
-- THE RULE THIS TABLE ENFORCES: a verdict is a measurement, and measurements
-- are kept regardless of which way they came out. Every suite-verify writes
-- one row here, for ALL eight outcomes (contractual-breach, all-clear,
-- self-incumbent, no-incumbent, incumbent-unresolvable, no-suite,
-- insufficient-pairs, budget-refused). Breaches ALSO keep writing their
-- incident — the incident is the alarm, this row is the lab notebook.
--
-- `retention` carries the full block including pairEvidence (the ordered
-- per-item candidate/incumbent/ratio list) — the diffable record whose absence
-- made two disagreeing verdicts unexplainable.
--
-- Supersession is rubric-style: a corrected verdict is a NEW row; the prior
-- gets superseded_by + supersede_reason and stays readable. The audit trail
-- shows the instrument catching and correcting itself — history is an asset.
CREATE TABLE IF NOT EXISTS guarantee_verdicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id),
  policy_id text NOT NULL,
  cluster_id text NOT NULL,
  suite_id text,
  suite_version text,
  candidate_hash text NOT NULL,
  incumbent_hash text,
  incumbent_designation_id text,
  provider_mode text NOT NULL DEFAULT 'unknown',
  prices_version text,
  outcome text NOT NULL,
  retention jsonb,
  unpairable jsonb NOT NULL DEFAULT '[]'::jsonb,
  detail text,
  run_id text,
  spend_usd double precision NOT NULL DEFAULT 0,
  rubric_hash text,
  calibration_id text,
  advisory_incident_id text,
  verdict_incident_id text,
  superseded_by uuid,
  supersede_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS guarantee_verdicts_tuple_idx
  ON guarantee_verdicts (org_id, policy_id, cluster_id, created_at);
