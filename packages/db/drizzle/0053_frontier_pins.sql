-- R7 (2026-08-24): "don't move under me without telling me."
--
-- Silent improvement is the product's promise and an eval nightmare for a
-- customer testing their own product against ours. A pin freezes the exact
-- frontier version an org is served for one cluster+instrument, so a
-- published movement cannot change their served point until they release it.
--
-- Org-level, NOT policy-level, deliberately: policies are immutable history
-- and a pin is a toggle — churning a policy row per toggle would bury the
-- audit trail that makes policies worth versioning. Releasing = deleting the
-- row, so an absent row means "serve the latest", the historical behavior.
CREATE TABLE IF NOT EXISTS frontier_pins (
  org_id text NOT NULL REFERENCES orgs(id),
  cluster_id text NOT NULL,
  instrument text NOT NULL DEFAULT 'default',
  frontier_id text NOT NULL,
  frontier_version integer NOT NULL,
  pinned_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, cluster_id, instrument)
);
