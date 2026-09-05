-- 0092, G2 rung 4 (2026-09-04): ROUTER GENERATIONS.
--
-- Until now a router VERSION was descriptive: compileAndMintRouter minted
-- one whenever the decision inputs changed, and it was live the instant it
-- existed because serving recomputes from current frontiers. There was no
-- way to stage a routing change, and no way to put one back.
--
-- A GENERATION is that same routing decision made DURABLE and REVERSIBLE:
-- an immutable set of per-cluster frontier ids, exactly the thing
-- frontier_pins already expresses one cluster at a time, captured atomically
-- with a lifecycle. Serving needs no new concept — getServingFrontier
-- already honours a pin — so promoting a generation is writing its pin set,
-- and rolling back is writing the previous one's.
--
-- status: 'candidate'  staged, serving nothing yet
--         'serving'    its pins are the ones in force (at most one per org)
--         'superseded' promoted, then replaced by a later generation
--         'rolled-back' promoted, then explicitly reverted away from
CREATE TABLE IF NOT EXISTS "router_generations" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "orgs"("id"),
  "status" text NOT NULL DEFAULT 'candidate',
  -- { [clusterId]: { frontierId, frontierVersion, instrument } } — the whole
  -- routing surface at capture time, not a diff. A generation must be
  -- re-appliable years later without replaying history.
  "pins" jsonb NOT NULL,
  -- The compiled router version this generation was captured from, so the
  -- artifact a reader sees and the pins that serve can be tied together.
  "router_version" integer,
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "promoted_at" timestamp with time zone,
  "ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "router_generations_org_status_idx"
  ON "router_generations" ("org_id", "status");
