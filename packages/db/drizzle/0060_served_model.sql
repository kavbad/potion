-- S2 (the Receipts surface): the ledger's "served by" column. request_logs
-- recorded the REQUESTED label only; the served model was derivable from the
-- strategy hash but not readable. Stamped at serve time from here on; old
-- rows stay NULL and render as "—", never guessed.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS served_model text;
