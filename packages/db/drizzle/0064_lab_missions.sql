-- P1 (the clock, 2026-08-28): the ARMED state of a standing mission. A
-- trial stays a trial — nothing runs itself until an admin arms it, and
-- arming binds to ONE content-addressed harness version (an edit mints a
-- new hash; the operator re-arms deliberately, never by surprise). The
-- scheduler starts at most one check per cadence window (last_window_key
-- is the dedup), and missed windows are skipped, never bursted.
-- Single statement: the migration runner prepares each file whole.
CREATE TABLE IF NOT EXISTS "lab_missions" (
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "harness_hash" text NOT NULL,
  "state" text NOT NULL DEFAULT 'paused',
  "cadence_cron" text NOT NULL,
  "armed_by" text NOT NULL,
  "armed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_window_key" text,
  "last_note" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "harness_hash")
);
