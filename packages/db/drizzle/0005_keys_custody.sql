-- Potion 0005_keys_custody (ADDITIVE, M2 Wave 2, ROADMAP #15/#16): real BYOK
-- key custody + key lifecycle.
--
--   provider_keys gains the custody columns — the M1a build stored ONLY the
--   masked display form + sha256 dedup hash and discarded the raw key, so
--   BYOK could never serve. Now:
--     ciphertext        envelope-encrypted raw key (AES-256-GCM; per-key data
--                       key wrapped by the master key — see
--                       apps/server/src/custody/). NULL for pre-0005 rows
--                       (masked-only legacy refs; they can validate nothing
--                       and never serve — register a fresh key).
--     key_version       bumped on every rotate (raw-key replacement).
--     status            active | revoked | rotating — only 'active' rows with
--                       a ciphertext are eligible for the serving path.
--     last_validated_at set by POST /api/keys/:id/validate.
--
--   api_keys gains the lifecycle columns:
--     name        (already present since 0000 — the ADD is a no-op guard)
--     scopes      space-separated; minimal v1 vocabulary: 'serve' (default —
--                 chat completions only) and 'serve+admin' (adds key-lifecycle
--                 admin mutations). Documented in apps/server/src/auth.ts.
--     env         'live' (default) | 'test' — a label for now: test keys serve
--                 identically but are badgeable in the dashboard/billing.
--     revoked_at  set on revoke — the auth hot path 401s revoked keys.
--     expires_at  optional hard expiry — the auth hot path 401s expired keys.
--
--   custody_audit is the append-only custody trail: every decrypt (serving
--   path), encrypt (register), rotate, revoke and validate writes a row.
--   metadata NEVER contains key material — envelope params and operational
--   detail only.
--
-- Idempotent: safe to run at every boot (ADD COLUMN IF NOT EXISTS + guarded
-- constraint creation, CREATE TABLE IF NOT EXISTS).
ALTER TABLE provider_keys ADD COLUMN IF NOT EXISTS ciphertext text;
--> statement-breakpoint
ALTER TABLE provider_keys ADD COLUMN IF NOT EXISTS key_version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE provider_keys ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_keys_status_check') THEN
    ALTER TABLE provider_keys ADD CONSTRAINT provider_keys_status_check
      CHECK (status IN ('active', 'revoked', 'rotating'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE provider_keys ADD COLUMN IF NOT EXISTS last_validated_at timestamptz;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS name text;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes text NOT NULL DEFAULT 'serve';
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS env text NOT NULL DEFAULT 'live';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_env_check') THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_env_check
      CHECK (env IN ('live', 'test'));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS custody_audit (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  -- who acted: a user id, an api-key id, or a system actor ('system:serve',
  -- 'system:master-rotation').
  actor text NOT NULL,
  action text NOT NULL,
  -- nullable: master-key rotation writes one summary row not pinned to a
  -- single key. Plain text (no FK) so a deleted provider key never breaks
  -- the audit trail.
  provider_key_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custody_audit_action_check') THEN
    ALTER TABLE custody_audit ADD CONSTRAINT custody_audit_action_check
      CHECK (action IN ('encrypt', 'decrypt', 'rotate', 'revoke', 'validate'));
  END IF;
END $$;
