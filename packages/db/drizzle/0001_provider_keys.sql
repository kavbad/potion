-- Potion 0001_provider_keys (ADDITIVE, Phase 5): masked provider-key refs
-- registered via the dashboard API (SPEC §8 POST /api/keys). The RAW key is
-- never stored — only a masked display form plus a sha256 hash for dedup.
-- Idempotent: safe to run at every boot.
CREATE TABLE IF NOT EXISTS provider_keys (
  id text PRIMARY KEY,
  provider text NOT NULL,
  name text NOT NULL,
  masked_key text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
