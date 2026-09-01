-- G0 (2026-08-31, external core-API review): the receipt names the router
-- version that SERVED. Stamped at serve time by content match against the
-- latest minted artifact (apps/server routing/router-stamp.ts) — never
-- reconstructed newest-wins after the fact. NULL = nothing minted contained
-- the served assignment, or a pre-0082 row; receipts fall back to read-time
-- reconstruction for those.
-- Single statement: the migration runner prepares each file whole.
ALTER TABLE "request_logs" ADD COLUMN IF NOT EXISTS "router_version" integer;
