-- 0040 — THE MODEL REGISTRY MOVES INTO THE DATABASE (SERVING-ROADMAP S5).
--
-- `prices.json` IS the registry today (researcher/registry.ts), and the only
-- thing that grows it — `research:scan` — grows it with writeFileSync
-- (workers/handlers.ts). Two consequences, both fatal to breadth:
--
--   A scan's results DIE ON REDEPLOY. The file ships inside the container
--   image, so every deploy resets the catalog to whatever was committed.
--
--   And they never reach the RUNNING process anyway: loadPrices() runs once
--   at boot (context.ts), so appending to the file changes nothing until
--   someone restarts the server.
--
-- The `models` table already existed with exactly the right core shape and
-- was DEAD — no reader, no writer anywhere in the monorepo (only an
-- org-delete test counting its rows). This migration adopts it rather than
-- adding a second registry beside it, and adds the catalog facts a scan can
-- learn that a price table has nowhere to put.
--
-- Rows here are the CATALOG: everything Potion knows it could call. That is
-- deliberately not the set it will route to — only measured frontier points
-- are routable (the standing dial-honesty decision), and this table has no
-- opinion about measurement. Catalog ≠ frontier.
--
-- `prices.json` stays, demoted to a SEED for a fresh database: a from-scratch
-- boot keeps working with no network, and the committed baseline stays
-- reviewable in git, while the live catalog becomes durable state.

-- Catalog facts. ALL NULLABLE — absent means "the provider did not report
-- it", never a fabricated default. A guessed context window silently
-- truncates someone's prompt, and a guessed tool-capability flag routes a
-- tool-calling request to a model that cannot do it.
ALTER TABLE models ADD COLUMN IF NOT EXISTS context_length integer;
--> statement-breakpoint
ALTER TABLE models ADD COLUMN IF NOT EXISTS max_output_tokens integer;
--> statement-breakpoint
ALTER TABLE models ADD COLUMN IF NOT EXISTS supports_tools boolean;
--> statement-breakpoint

-- 'seed' = came from the committed prices.json; 'scan' = discovered live.
-- Kept so the origin of any entry is legible in SQL rather than only in
-- history, and so a scan's additions can be told from the baseline.
ALTER TABLE models ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'seed';
--> statement-breakpoint
ALTER TABLE models ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
