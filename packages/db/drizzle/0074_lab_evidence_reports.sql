CREATE TABLE IF NOT EXISTS lab_evidence_reports (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  harness_hash text NOT NULL,
  run_id text NOT NULL,
  action_class text NOT NULL,
  action_id text,
  kind text NOT NULL,
  detail text,
  reported_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
