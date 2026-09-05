-- Potion 0092_lab_runs_reminded (2026-09-05): one email is a nudge, not a
-- system.
--
-- ON THE DUPLICATE NUMBER. Another session took 0092 for router generations
-- in the same hour and both files landed on main. I renamed this one to
-- 0094 to clear the collision, on the reasoning that it had not yet reached
-- a real database — and by then it HAD: production applied it under this
-- name at 01:58 UTC. So it is 0092 again, and stays 0092.
--
-- A migration's filename is its identity in schema_migrations. Renaming an
-- APPLIED one does not tidy anything up; it mints a second identity for one
-- logical change, and the runner dutifully re-runs it under the new name.
-- These statements are IF NOT EXISTS so that would have been harmless here,
-- which is the only reason this was a tidiness question and not an
-- incident. The number is shared with 0092_router_generations. That is
-- ugly and it is fine: the ledger keys on the filename, the two touch
-- different tables, and neither depends on the other's order.
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
