-- Lab Step 7 (docs/specs/step-07-dial.md): the felt-sample cache — repeated
-- dial positions cost nothing. Schema-ADDITIVE core under rule 2, the Step 3
-- ruling pattern: org_id NOT NULL REFERENCES orgs(id), erased by
-- deleteOrgCascade, cascade coverage proven at birth by the F5
-- schema-derived meta-test.
--
-- The cache key is (org, probe, policy content, frontier row): everything
-- that determines which strategy serves the probe and what it says. A dial
-- move that lands on a previously felt position is a cache hit — NO serving
-- call, $0 — proven by the walkthrough's request_logs count invariant.
CREATE TABLE IF NOT EXISTS lab_felt_samples (
  org_id text NOT NULL REFERENCES orgs(id),
  probe_hash text NOT NULL,
  policy_hash text NOT NULL,
  frontier_id text NOT NULL,
  -- What actually served, recorded from the response (x-frontier-trace +
  -- request_logs) — evidence, not prediction.
  strategy_hash text NOT NULL,
  frontier_version integer NOT NULL,
  provenance text NOT NULL,
  output text NOT NULL,
  cost_usd double precision,
  latency_ms integer NOT NULL,
  completion_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, probe_hash, policy_hash, frontier_id)
);
