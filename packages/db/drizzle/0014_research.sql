-- Potion 0014_research (M4b, ROADMAP #37, SPEC §15.6): the autoresearcher
-- ledger + recipe lifecycle. (Renumbered from SPEC's original 0013 — M4 #30's
-- request_logs_policy took that number first.)
--   research_cycles: one row per candidate-generation+sweep cycle. trigger ∈
--   scan|manual|schedule; candidates is the StrategyConfig[] swept; spend_usd
--   is the cycle's LIVE spend — the research loop keeps its OWN ledger,
--   separate from the M1b cap (SPEC §15.3); seed feeds the promotion gate's
--   mulberry32 paired bootstrap (SPEC §15.4) so every promote/hold decision
--   is exactly reproducible.
--   recipe_status: lifecycle per strategy content-hash — candidate (mock may
--   shortlist, never promote) → frontier (live-verified, published) →
--   archived. strategy_hash is TEXT and deliberately NOT an FK: status rows
--   outlive config rows.
-- Both tables are platform-GLOBAL (like frontiers/strategy_configs): research
-- publishes frontier versions every org inherits. Per-org private research is
-- a documented follow-up (SPEC §15).
-- Idempotent: safe to run at every boot (IF NOT EXISTS throughout).
CREATE TABLE IF NOT EXISTS research_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL CHECK (trigger IN ('scan', 'manual', 'schedule')),
  focus_alias text,
  candidates jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  spend_usd double precision NOT NULL DEFAULT 0,
  provenance text NOT NULL DEFAULT 'unknown',
  seed integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS research_cycles_created_idx
  ON research_cycles(created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS recipe_status (
  strategy_hash text PRIMARY KEY,
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'frontier', 'archived')),
  first_cycle_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS recipe_status_status_idx ON recipe_status(status);
