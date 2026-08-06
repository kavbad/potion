-- Potion 0003_tenancy (M2 Wave 1, ROADMAP #13): the tenant foundation.
--   orgs / users / memberships: every customer asset hangs off an org.
--   api_keys / provider_keys / policies / request_logs gain org_id —
--   backfilled to the seeded default org 'org_demo', then NOT NULL + FK.
-- Frontiers/clusters/taxonomy stay shared-GLOBAL by design (ROADMAP #13):
-- the routing evidence base is a platform asset, not a tenant asset.
-- Idempotent: safe to run at every boot (IF NOT EXISTS + guarded DO blocks;
-- ALTER COLUMN ... SET NOT NULL is a no-op when already NOT NULL).
CREATE TABLE IF NOT EXISTS orgs (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS memberships (
  org_id text NOT NULL REFERENCES orgs(id),
  user_id text NOT NULL REFERENCES users(id),
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memberships_role_check') THEN
    ALTER TABLE memberships ADD CONSTRAINT memberships_role_check
      CHECK (role IN ('admin', 'member', 'viewer'));
  END IF;
END $$;
--> statement-breakpoint
-- Seeded default org: the backfill target for every pre-tenancy row AND the
-- demo tenant the boot seed binds its key/policies to.
INSERT INTO orgs (id, name) VALUES ('org_demo', 'Demo Org') ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS org_id text;
--> statement-breakpoint
ALTER TABLE provider_keys ADD COLUMN IF NOT EXISTS org_id text;
--> statement-breakpoint
ALTER TABLE policies ADD COLUMN IF NOT EXISTS org_id text;
--> statement-breakpoint
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS org_id text;
--> statement-breakpoint
UPDATE api_keys SET org_id = 'org_demo' WHERE org_id IS NULL;
--> statement-breakpoint
UPDATE provider_keys SET org_id = 'org_demo' WHERE org_id IS NULL;
--> statement-breakpoint
UPDATE policies SET org_id = 'org_demo' WHERE org_id IS NULL;
--> statement-breakpoint
UPDATE request_logs SET org_id = 'org_demo' WHERE org_id IS NULL;
--> statement-breakpoint
ALTER TABLE api_keys ALTER COLUMN org_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE provider_keys ALTER COLUMN org_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE policies ALTER COLUMN org_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE request_logs ALTER COLUMN org_id SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_org_id_fkey') THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_org_id_fkey FOREIGN KEY (org_id) REFERENCES orgs(id);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_keys_org_id_fkey') THEN
    ALTER TABLE provider_keys ADD CONSTRAINT provider_keys_org_id_fkey FOREIGN KEY (org_id) REFERENCES orgs(id);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policies_org_id_fkey') THEN
    ALTER TABLE policies ADD CONSTRAINT policies_org_id_fkey FOREIGN KEY (org_id) REFERENCES orgs(id);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'request_logs_org_id_fkey') THEN
    ALTER TABLE request_logs ADD CONSTRAINT request_logs_org_id_fkey FOREIGN KEY (org_id) REFERENCES orgs(id);
  END IF;
END $$;
--> statement-breakpoint
-- Tenant-correct dedup for provider keys: the same raw key may be registered
-- by two different orgs (each org's custody is its own — ROADMAP #16), so
-- the pre-tenancy global UNIQUE(key_hash) becomes UNIQUE(org_id, key_hash).
ALTER TABLE provider_keys DROP CONSTRAINT IF EXISTS provider_keys_key_hash_key;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_keys_org_key_hash_key') THEN
    ALTER TABLE provider_keys ADD CONSTRAINT provider_keys_org_key_hash_key UNIQUE (org_id, key_hash);
  END IF;
END $$;
