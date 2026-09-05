-- Potion 0094_lab_runs_reminded (2026-09-05): one email is a nudge, not a
-- system.
--
-- RENUMBERED from 0092. Another session claimed 0092 for router generations
-- in the same hour, and both files sat on main at once. The runner keys its
-- ledger on the FILENAME, so nothing would have broken — but two migrations
-- sharing a number means lexical order silently decides which runs first,
-- and the next pair to collide might actually depend on that order. It had
-- not reached any real database (production applied 0091, then the other
-- 0092, then 0093), so renaming is free today and never again.
--
-- A run that parks for a human sends exactly one notification, at the
-- moment it parks, and then goes silent for the rest of its life. On
-- production a run has been waiting since 2026-08-31: the mail was sent,
-- the person missed it, and nothing ever asked again. The worker is still
-- there.
--
-- reminded_at is the ledger that makes a SECOND ask safe — sweep, remind
-- once, stamp. Without it a periodic sweep either re-mails on every tick
-- (which trains people to ignore it, the exact failure it is meant to fix)
-- or has to keep the memory somewhere that does not survive a restart.
--
-- NULL means "never reminded", which is every existing row, including the
-- one this was written for. It gets its reminder on the first sweep.
ALTER TABLE lab_runs ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
--> statement-breakpoint
-- The sweep's whole predicate, so it never walks the table: parked runs
-- that have not been reminded, oldest first.
CREATE INDEX IF NOT EXISTS lab_runs_parked_unreminded_idx
  ON lab_runs (updated_at)
  WHERE state = 'awaiting-human' AND reminded_at IS NULL;
