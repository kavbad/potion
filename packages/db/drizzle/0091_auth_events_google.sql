-- Potion 0091_auth_events_google (2026-09-04): "Sign in with Google" earns
-- its own name in the audit trail.
--
-- auth_events.method was CHECKed to ('magic_link', 'oidc') by 0012. Google
-- sign-in IS OIDC underneath, so recording it as 'oidc' would not be a lie
-- — but the audit export is read by a person asking "how did this account
-- get in", and "oidc" there means the org's enterprise IdP. Two different
-- doors deserve two different words.
--
-- Widening a CHECK is a drop + add, and dropping first is what makes it
-- rerunnable: an ADD alone would fail on the second run, and an
-- IF NOT EXISTS guard would silently keep the OLD, narrower constraint on
-- any database that already has it — which is every database that has ever
-- run 0012. So: drop by name (IF EXISTS), then add the widened form.
ALTER TABLE auth_events DROP CONSTRAINT IF EXISTS auth_events_method_check;
--> statement-breakpoint
ALTER TABLE auth_events ADD CONSTRAINT auth_events_method_check
  CHECK (method IN ('magic_link', 'oidc', 'google'));
