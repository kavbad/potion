-- F12 repair: undo what the boot-time re-attribution did, but ONLY where the
-- answer is provable.
--
-- Before the migrations ledger (see packages/db/src/migrate.ts), every boot
-- re-ran 0023's tenancy backfill, which sets org_id from the owning cluster
-- WHERE org_id IS NULL — and on these four tables NULL *means platform*. So
-- restarts moved platform evidence into tenants' pools.
--
-- THE DAMAGE IS LOSSY. `SET org_id = c.org_id WHERE org_id IS NULL` destroys
-- the only bit that said "platform"; there is no shadow column and no audit
-- row, so the general case CANNOT be reliably reversed and this migration
-- does not guess.
--
-- What IS provable: a row whose created_at PRECEDES its claimed org's own
-- created_at cannot legitimately belong to that org — the org did not exist
-- yet, and 0023 only ever moved rows that were NULL (platform). That subset
-- is reset to NULL with zero false positives. Everything else that merely
-- LOOKS re-attributable is recorded for operator review and left untouched:
-- a wrong "repair" of tenant attribution is the same class of harm as the
-- bug.
--
-- Runs exactly once, guaranteed by the ledger — which is what makes a data
-- migration safe to write at all. That guarantee is the reason this file
-- exists rather than a one-off script.
CREATE TABLE IF NOT EXISTS evidence_attribution_audit (
  id serial PRIMARY KEY,
  table_name text NOT NULL,
  row_key text NOT NULL,
  cluster_id text,
  claimed_org_id text NOT NULL,
  row_created_at timestamptz,
  org_created_at timestamptz,
  -- 'reset-to-platform' = provably impossible, org_id set back to NULL.
  -- 'ambiguous-review'  = indistinguishable from legitimate ownership; NOT
  --                       modified. Operator decides.
  disposition text NOT NULL,
  noted_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_attribution_audit_disposition_idx
  ON evidence_attribution_audit (disposition, table_name);
--> statement-breakpoint
-- ---- frontiers ----------------------------------------------------------
INSERT INTO evidence_attribution_audit
  (table_name, row_key, cluster_id, claimed_org_id, row_created_at, org_created_at, disposition)
SELECT 'frontiers', f.id, f.cluster_id, f.org_id, f.created_at::timestamptz, o.created_at,
       CASE WHEN f.created_at::timestamptz < o.created_at
            THEN 'reset-to-platform' ELSE 'ambiguous-review' END
FROM frontiers f
JOIN clusters c ON c.id = f.cluster_id
JOIN orgs o ON o.id = f.org_id
WHERE f.org_id IS NOT NULL AND c.org_id = f.org_id;
--> statement-breakpoint
UPDATE frontiers f SET org_id = NULL
FROM clusters c, orgs o
WHERE c.id = f.cluster_id AND o.id = f.org_id
  AND f.org_id IS NOT NULL AND c.org_id = f.org_id
  AND f.created_at::timestamptz < o.created_at;
--> statement-breakpoint
-- ---- frontier_points (move with their parent frontier) -------------------
INSERT INTO evidence_attribution_audit
  (table_name, row_key, cluster_id, claimed_org_id, row_created_at, org_created_at, disposition)
SELECT 'frontier_points', p.id::text, p.cluster_id, p.org_id, f.created_at::timestamptz, o.created_at,
       CASE WHEN f.created_at::timestamptz < o.created_at
            THEN 'reset-to-platform' ELSE 'ambiguous-review' END
FROM frontier_points p
JOIN frontiers f ON f.id = p.frontier_id
JOIN clusters c ON c.id = p.cluster_id
JOIN orgs o ON o.id = p.org_id
WHERE p.org_id IS NOT NULL AND c.org_id = p.org_id;
--> statement-breakpoint
UPDATE frontier_points p SET org_id = NULL
FROM frontiers f, clusters c, orgs o
WHERE f.id = p.frontier_id AND c.id = p.cluster_id AND o.id = p.org_id
  AND p.org_id IS NOT NULL AND c.org_id = p.org_id
  AND f.created_at::timestamptz < o.created_at;
--> statement-breakpoint
-- ---- eval_results -------------------------------------------------------
INSERT INTO evidence_attribution_audit
  (table_name, row_key, cluster_id, claimed_org_id, row_created_at, org_created_at, disposition)
SELECT 'eval_results', e.cache_key, e.cluster_id, e.org_id, e.created_at::timestamptz, o.created_at,
       CASE WHEN e.created_at::timestamptz < o.created_at
            THEN 'reset-to-platform' ELSE 'ambiguous-review' END
FROM eval_results e
JOIN clusters c ON c.id = e.cluster_id
JOIN orgs o ON o.id = e.org_id
WHERE e.org_id IS NOT NULL AND c.org_id = e.org_id;
--> statement-breakpoint
UPDATE eval_results e SET org_id = NULL
FROM clusters c, orgs o
WHERE c.id = e.cluster_id AND o.id = e.org_id
  AND e.org_id IS NOT NULL AND c.org_id = e.org_id
  AND e.created_at::timestamptz < o.created_at;
--> statement-breakpoint
-- ---- eval_runs (joined the way 0023 joined them) -------------------------
INSERT INTO evidence_attribution_audit
  (table_name, row_key, cluster_id, claimed_org_id, row_created_at, org_created_at, disposition)
SELECT 'eval_runs', r.id, c.id, r.org_id, r.created_at, o.created_at,
       CASE WHEN r.created_at < o.created_at
            THEN 'reset-to-platform' ELSE 'ambiguous-review' END
FROM eval_runs r
JOIN clusters c ON c.id = r.options->>'agentCluster'
JOIN orgs o ON o.id = r.org_id
WHERE r.org_id IS NOT NULL AND c.org_id = r.org_id;
--> statement-breakpoint
UPDATE eval_runs r SET org_id = NULL
FROM clusters c, orgs o
WHERE c.id = r.options->>'agentCluster' AND o.id = r.org_id
  AND r.org_id IS NOT NULL AND c.org_id = r.org_id
  AND r.created_at < o.created_at;
