-- 0042 — DEMAND CELLS (SERVING-ROADMAP S7 / G9, leg L2).
--
-- The step where what customers ask for stops being per-request traffic and
-- becomes an aggregate Potion is allowed to learn from. The operator's ruling
-- (S7 §4 D1(b)): cross-org learning may use a RUNNING CENTROID of request
-- embeddings, published only once enough distinct orgs have fed it, and no
-- prompt, response, or per-request embedding is ever persisted.
--
-- THREE TABLES, because the k-anonymity gate is a WRITE gate.
--
--   demand_cell_staging       private. Running sums, fed by the serve path's
--                             in-process accumulator on a timer. A cell here
--                             may be one customer's traffic, so nothing
--                             outside the aggregator may read it.
--   demand_cell_contributors  private. Which orgs fed which cell — presence
--                             only, no counts, no vectors. This is how a cell
--                             knows whether it has reached k. It says nothing
--                             request_logs does not already say.
--   demand_cells              PUBLISHED. Written only when the cell cleared
--                             both thresholds. This is the only table L3's
--                             coverage ranking, L4's probes, and any surface
--                             may read.
--
-- Why not one table with a `published` flag: because "we hold it but hide it"
-- is a promise about queries, and this needs to be a promise about storage.
-- A row that must never be read by feature code does not belong in the table
-- feature code reads.
--
-- WHAT IS NOT HERE, deliberately: no prompt text, no response text, no
-- per-request embedding, no org id on any published row. The centroid is a
-- SUM over many requests from ≥k orgs — arithmetic that cannot be run
-- backwards to a request.

CREATE TABLE IF NOT EXISTS demand_cell_staging (
  cell_key text PRIMARY KEY,
  bucket text NOT NULL,
  bucket_kind text NOT NULL,
  shape_class text NOT NULL,
  week_start date NOT NULL,
  requests bigint NOT NULL DEFAULT 0,
  confidence_sum double precision NOT NULL DEFAULT 0,
  -- Observations that CARRIED a fit (≤ requests). A cluster-hinted request
  -- has no measured fit, and averaging over `requests` instead of this would
  -- report a cell as worse-fitting the more its customers told us the answer.
  confidence_count bigint NOT NULL DEFAULT 0,
  confidence_min double precision,
  -- The running SUM of embeddings, as jsonb rather than a vector column:
  -- a sum is not a point in the embedding space and must not be searchable
  -- as though it were. Only the normalized, published centroid becomes a
  -- vector.
  centroid_sum jsonb,
  centroid_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS demand_cell_contributors (
  cell_key text NOT NULL,
  org_id text NOT NULL,
  PRIMARY KEY (cell_key, org_id)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS demand_cells (
  cell_key text PRIMARY KEY,
  -- A taxonomy cluster id, or an `lsh:xxxx` label for a region of demand
  -- that matched nothing well enough to route (core/lsh.ts). The prefix is
  -- what stops an unmeasured region from ever being mistaken downstream for
  -- a measured cluster.
  bucket text NOT NULL,
  bucket_kind text NOT NULL,
  shape_class text NOT NULL,
  week_start date NOT NULL,
  requests bigint NOT NULL,
  -- Published as a COUNT. The identities stay in the private table.
  org_count integer NOT NULL,
  -- NULLABLE, and it matters: a cell fed only by cluster-hinted traffic has
  -- no measured fit at all. NULL says "not measured"; a 0 would say "fits
  -- nothing we serve", which is a finding, not a gap in the data.
  confidence_mean double precision,
  -- The worst fit in the cell. The mean says how it usually goes; this says
  -- whether anything in here was badly served, which is the finding.
  confidence_min double precision,
  -- How much of the cell actually measured a fit.
  confidence_count bigint NOT NULL DEFAULT 0,
  centroid vector(384),
  published_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- L3 ranks demand by week and reads unassigned regions separately from
-- measured clusters; both are covered by this one index.
CREATE INDEX IF NOT EXISTS demand_cells_week_kind_idx
  ON demand_cells (week_start, bucket_kind);
--> statement-breakpoint

-- ORG-LEVEL OPT-OUT (S7 §4 D1(b), the posture the operator approved).
--
-- Cross-org learning is defensible because a published cell is an aggregate
-- over ≥k orgs — but "defensible" is not the same as "chosen", and a customer
-- who does not want their traffic shaping anyone's measurement decisions gets
-- to say so. Opted-out traffic is not counted, not summed, and not staged: it
-- is excluded at OBSERVATION, before any accumulator holds it.
--
-- Default false: the aggregate is the product's own quality loop, and an
-- opt-out that nobody knows about protects nobody. The surface that exposes
-- it ships with the entitlement work (L4).
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS demand_learning_opt_out boolean NOT NULL DEFAULT false;
