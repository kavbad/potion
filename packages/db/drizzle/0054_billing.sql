-- R0 (2026-08-24): the charge path. Invoice math and Stripe-shaped JSON have
-- existed since Wave 2; what was missing is anything that takes money.
--
-- Built to the ACCOUNT BOUNDARY: every row here is written by the 'ledger'
-- transport too, so the whole flow is exercisable before a Stripe account
-- exists. When keys arrive the transport swaps and these tables keep their
-- meaning — external_id simply stops being a local stub id.
CREATE TABLE IF NOT EXISTS billing_customers (
  org_id text PRIMARY KEY REFERENCES orgs(id),
  /** Stripe customer id, or a 'local_' stub under the ledger transport. */
  customer_id text NOT NULL,
  transport text NOT NULL DEFAULT 'ledger',
  /** Card metadata ONLY — never a PAN, never a token we could spend. */
  brand text,
  last4 text,
  exp_month integer,
  exp_year integer,
  status text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One row per (org, period) charge ATTEMPT. The local record is the audit
-- trail: what we believed was owed, what we tried to collect, what happened.
CREATE TABLE IF NOT EXISTS invoice_charges (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  period text NOT NULL,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL,
  transport text NOT NULL,
  external_id text,
  error text,
  invoice_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invoice_charges_org_period_idx ON invoice_charges (org_id, period);
