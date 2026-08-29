-- H2 (2026-08-28): the artifact that escapes — a worker's deliverable as a
-- shareable page. Share tokens gain the 'brief' kind; everything else about
-- the rail (sha256-at-rest, one-time raw token, revocation, uniform 404)
-- is inherited unchanged from 0009.
-- Single statement: the migration runner prepares each file whole, so the
-- two ALTERs ride one DO block.
DO $$ BEGIN
  ALTER TABLE share_tokens DROP CONSTRAINT IF EXISTS share_tokens_kind_check;
  ALTER TABLE share_tokens ADD CONSTRAINT share_tokens_kind_check CHECK (kind IN ('frontier', 'report', 'brief'));
END $$;
