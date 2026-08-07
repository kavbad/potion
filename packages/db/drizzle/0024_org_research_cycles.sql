-- Potion 0024_org_research_cycles (G1.8): per-org research cycles. org_id
-- NULL = platform (the G1.6 convention). A tenant's cycles (candidates,
-- spend, focus aliases) are their own — the cycles listing scopes to
-- platform-or-own-org; recipe_status remains a PLATFORM library (org cycles
-- never mutate it).
-- Idempotent: safe to run at every boot.
ALTER TABLE research_cycles ADD COLUMN IF NOT EXISTS org_id text REFERENCES orgs(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS research_cycles_org_idx ON research_cycles (org_id);
