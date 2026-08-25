-- Walkthrough seam (2026-08-24): minting a SERVING key — the first thing
-- every partner does — wrote no audit row, while /settings/audit promises
-- "key custody, one chronology". Widen the custody action vocabulary with
-- 'issue' so serving-key issue/revoke join the trail the page already reads.
ALTER TABLE custody_audit DROP CONSTRAINT IF EXISTS custody_audit_action_check;
--> statement-breakpoint
ALTER TABLE custody_audit ADD CONSTRAINT custody_audit_action_check
  CHECK (action IN ('encrypt', 'decrypt', 'rotate', 'revoke', 'validate', 'issue'));
