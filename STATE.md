# STATE — the one file that is always current

**Read this before trusting any other prose in the repo.** Roadmaps, audits,
code comments and research notes are HISTORY the moment they land; when this
file and another document disagree, this file wins, and the other document
should gain a `SUPERSEDED BY STATE.md` stamp when touched. (Rule adopted
2026-08-25 after an external review found stale prose functioning as
executable misinformation for coding agents.)

_Last updated: 2026-08-25 (redesign S1–S4 shipped: primitives, Receipts, Evidence, Savings + the Monday Brief; final nav)._

## What Potion is (current thesis)

A continuously self-optimizing inference layer that turns quality, cost and
latency requirements into the cheapest **measured** execution plan — with a
receipt on every answer and gates that can refuse. Positioning sentence:
*others predict which model should work; Potion measures what actually
clears your bar.*

## Current truths

- **Serving**: live at withpotion.com (Hetzner + Render PG17). Routing is
  request-classified, **workload-level** optimized (per-cluster frontiers +
  policy). Per-invocation conditional routing is a NAMED FUTURE direction,
  not current behavior — copy must not claim per-request difficulty routing.
- **Model field** (migration 0058): `potion-auto` routes; a known model name
  pins; an unknown name 400s; `route_all_models` is the explicit org-level
  migration escape hatch.
- **Payments**: Stripe rails implemented (Checkout setup mode with currency
  + client_reference_id; off-session charges name their payment_method;
  signed webhooks; idempotent per-period charges) but **NOT yet proven with
  a live key** — the release-blocking test is: real card → Checkout → close
  browser → off-session charge → webhook → invoice marked paid. Charging is
  OFF until the operator pastes keys and that test passes. The old
  `billing/backend.ts` stub is legacy.
- **Pricing model (DECIDED 2026-08-25, operator)**: pricing v2 —
  **at-cost pass-through + 25% share of verified savings**, computed from
  the serve-time counterfactual the rollup now persists (migration 0059).
  Save nothing → Potion earns nothing above cost. Implemented end to end
  (invoice, HTML render, billing page, landing); charging itself remains
  OFF until the Stripe sitting. marginPct machinery retained at 0.
- **Capability mixing: CLOSED** (five pre-registered negatives, ≈$13; public
  note at /research/the-mixing-verdict). No further mixture legs; the weekly
  saturation alarm owns the reopening condition. verify-pick and
  majority-by-execution remain in the toolbox as serve-time confidence
  instruments, not routing shapes.
- **Journey-grain**: measured on our synthetic corpus — routed ≈ best
  monolith end-to-end at 3.2× cheaper; beats the premium default at 7.1×.
  Partner traffic adjudicates for real.
- **Instruments**: code-gen-hard-v2 / classification-hard-v2 serve the map;
  champions ace them (crowns are ≥-bounds; the frontier prices the gap).
  Judge calibration answered on every deterministic cluster (judges FAIL
  reference-free rule-application; anchored extraction r=1.000 twice).
- **Email**: LIVE via Resend (sign-in links, alerts). Any comment saying
  otherwise is stale.
- **Frontier Notes**: publish weekly, autonomously, under the fail-closed
  redaction gate. The operator's formal yes/no on autonomy is still pending;
  current default is publish.
- **Potion Lab**: PAUSED. Gate A (first design partner) remains the gate.

## Current blockers (all operator-side)

Stripe keys + live charge test · legal skim (terms/privacy + structural-
findings clause) · the partner name.

## Current work queue (mine, in order)

Redesign track COMPLETE (2026-08-25): brief v4 built S1–S4 — receipt
primitives + printed first-run, Receipts ledger with live tail, Today's
pulse + bar proposal, Evidence rail, docs overhaul, Savings with the kept
counterfactual, the Monday Brief (in-product; emailed edition deferred,
rides the same composition), final nav (Today · Receipts · Evidence ·
Savings · Try · Settings · Docs). Next: instrument enlargement
(extraction, rewrite-edit) · then per the roadmap ledger in
`tasks/todo.md` (the ledger is append-only history; this file is the
summary).

## North star

First design partner on real traffic; everything Phase C fires from that.
