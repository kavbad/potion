-- Least-surprise model semantics (external review, 2026-08-25): 'potion-auto'
-- routes; a known model name PINS; an unknown name 400s. Orgs migrating an
-- existing app opt into label-blind routing explicitly — a visible setting,
-- not a silent default. Default false: surprise requires consent.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS route_all_models boolean NOT NULL DEFAULT false;
