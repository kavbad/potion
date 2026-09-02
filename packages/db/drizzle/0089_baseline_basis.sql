-- 0089 — the savings number carries its comparator (review P0 "savings
-- baseline asymmetry"): 'cluster-incumbent' | 'org-incumbent' |
-- 'best-of-frontier'; NULL = no baseline number on the row. IF NOT EXISTS:
-- post-0032 migrations re-execute on an upgrade boot (F12 baselining).
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS baseline_basis text;
