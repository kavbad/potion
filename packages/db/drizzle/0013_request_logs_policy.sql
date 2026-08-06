-- M4 #30 (SPEC §13.1): per-request policy override (X-Potion-Policy).
-- request_logs.policy_id records the policy row that SERVED the request —
-- the api key's bound policy by default, or the override resolution when
-- the header is present. Correlation label only (no FK): log rows outlive
-- policy rows.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS policy_id text;
