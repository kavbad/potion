-- The instrument a measurement was taken on (MIXING M3, 2026-08-23).
-- Tool-call cells (items carrying real tools, scored on the call) cannot be
-- averaged with text-judged cells for the same model, and a frontier built
-- from them cannot be mixed into the text-measured frontier a cluster serves.
-- Cells, aggregates, frontiers and the route all carry the instrument; a
-- tool-carrying request consults the cluster's 'tools' frontier first.
ALTER TABLE eval_results ADD COLUMN IF NOT EXISTS instrument text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE frontiers ADD COLUMN IF NOT EXISTS instrument text NOT NULL DEFAULT 'default';
--> statement-breakpoint
UPDATE eval_results SET instrument = 'tools' WHERE scorer = 'tool-call';
--> statement-breakpoint
DROP INDEX IF EXISTS frontiers_org_cluster_version;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS frontiers_org_cluster_instrument_version
  ON frontiers (org_id, cluster_id, instrument, version) NULLS NOT DISTINCT;
