-- Lab Step 8: the harness CATALOG — generated specs + their provenance
-- sidecars, org-scoped. Schema-ADDITIVE core under rule 2 (the 0035/0036
-- pattern): org_id NOT NULL REFERENCES orgs(id), erased by
-- deleteOrgCascade, cascade coverage proven at birth by the F5 meta-test.
-- Runs FREEZE their spec copy at start (0035 lab_runs.spec) — editing a
-- catalog row NEVER touches a run's frozen record (review outcome 2:
-- pre-edit runs replay byte-identically; tied to the Step 4 invariants by
-- test).
CREATE TABLE IF NOT EXISTS lab_harnesses (
  org_id text NOT NULL REFERENCES orgs(id),
  harness_hash text NOT NULL,
  name text NOT NULL,
  spec_text text NOT NULL,
  sidecar jsonb NOT NULL,
  cluster_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, harness_hash)
);
