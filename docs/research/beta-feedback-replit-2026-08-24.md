# The first external integration report (Replit beta), and what it changed

The report is the most valuable artifact a beta can produce: a team that is
not us, integrating from the docs, writing down where they guessed wrong.
Every finding triaged; the fixes shipped the same day.

## Their pains → what shipped

1. **"Generic policy names were not portable"** (`unknown policy 'min_cost'`).
   True by design — policies are org rows — but nothing helped them recover.
   Shipped: `policy_not_found` now carries `hint` ("omit the header to use
   the key's bound policy") and `available_policies` (ids + names).
2. **"Policy discovery was missing."** `GET /v1/policies` existed but
   returned only the bound policy. Shipped: it now lists the org's policies
   with ids, names, and a `bound` marker — a selector can be populated from
   real data.
3. **"Typed routing metadata."** Shipped: every non-streaming answer carries
   a top-level `potion` object — requested vs resolved cluster and policy,
   `policy_source` (`key_default` | `override`), the answering model,
   `fallback` + `fallback_reason`, `instrument`, `provenance`. The trace
   header stays the source record.
4. **"A deliberate key-default convention."** Documented: omitting
   `x-potion-policy` is the convention, and the response now *says*
   `policy_source: "key_default"`.
5. **`x-latency-contract` semantics** — documented (it appears only when a
   measured combination cannot token-stream).

## What their fallbacks actually were

Both of their `fallback=1` runs were **correct routing under a strict bar**:
their key is bound to a learning-derived floor of 0.9785, and neither
creative (best 0.900) nor rewrite-edit (best 0.967) has a measured point
above it — so the best point served, honestly flagged. The product failure
was explanation, not routing; `fallback_reason: "policy_infeasible"` now
says it in the response.

## Governance note

The beta key lives on **org-potion** — the dogfood org — so their traffic
mixes into our usage, samples, and budget. Recommendation: issue betas
their own org via the operator route; one command, clean measurement.

## Their app-side findings we endorse

Server-held keys only (our agent blocks already say never to accept a key
in a browser form); auth + durable limits before exposing a playground
publicly; show raw evidence beside parsed fields.
