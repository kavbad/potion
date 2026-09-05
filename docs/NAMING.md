# Naming: Potion is a compiler

**Operator directive, 2026-09-04. Binding on all new copy, code and docs.**

Potion is **never** called a router again — internally or externally. It is a
**compiler**. The tagline is **The Compiler for Inference**.

> A router picks a road; a compiler designs the route.

## Why

A router chooses among a fixed set of options, one decision per request, and
its output is a model. That is exactly the thing gateways now ship for free as
an "auto-router", and calling ourselves one caps the product at the layer that
is becoming free. A compiler takes an objective plus constraints plus a
workload and emits an executable strategy — model, branching, verification,
retries, reasoning, parallelism, caching — and optimises the whole program
rather than one hop of it.

This is not a repositioning away from what the code does; it is catching the
words up to it. `docs/INFERENCE-COMPILER.md` (2026-08-23) already states the
thesis: *an inference compiler whose output, today, is usually a one-node
program*.

## The lexicon

| Say | For |
|---|---|
| **the compiler** | Potion itself — the thing that decides how a request is executed |
| **your plan** | what the compiler emits for one org: versioned, readable, `potion/<org>` is its model id |
| **compile / recompile** | the verb; a new plan version is *minted* |
| **kind of work** | a cluster, in customer-facing copy |
| **the frontier** | the measured curve a plan is compiled from |

Do not say: *your router*, *the router*, *a measured model router*, *routes to*
(as the name of what a plan does — prefer *compiles to* / *serves*).

"Router" is still correct for **other people's products** ("gateways now ship
auto-routers", "most AI router products pick one model per request") and in the
frozen identifiers below.

## What is deliberately NOT renamed

The rename covers everything a person reads. It stops at the line where a
rename would be a breaking change to stored data or a deployed contract. These
keep their `router` spelling, and that is not an oversight:

**Database** (`packages/db/src/schema.ts`) — renaming these is a production
migration on a live database, not a copy change:
`router_versions`, `router_generations`, `router_interpretations`,
`router_version`, `router_hash`, and their indexes.

**HTTP paths** — dashboard-facing, but the dashboard and the server deploy
separately, so renaming them makes deploy order load-bearing:
`GET /api/router`, `POST /api/router/whatif`, `/api/router/generations*`.
The browser routes `/router` and `/compiler` both redirect to `/`; the old
spelling stays for bookmarks.

**Receipts** — `x-frontier-trace` carries a `router=vN` token, and customers
parse it. It stays until there is a reason to version the trace format.

**Code symbols bound to the above** — `routerVersions`, `RouterDocument`,
`RouterAssignment`, `CompiledRouter`, `compileAndMintRouter`,
`routerModelName`, `routerSlug`, `routerVersionForRequest`, and friends. A
symbol whose job is to name a column should keep the column's spelling;
renaming half of them would make the code lie about what it touches.

**History** — `STATE.md`, `ROADMAP.md` and dated `docs/` entries record what
was shipped and what it was called at the time. `docs/research/router-tax-2026-08-23.md`
is published under that URL. History is not rewritten.

**Vendors** — OpenRouter is a company.

One customer-visible value DID change with the rename: `/v1/models` entries for
the org's plan and `potion-auto` now carry `potion.role: "compiler"` instead of
`"router"` (pinned by `models-catalog.test.ts` and `router.test.ts`).

## If you are renaming the frozen list later

It is a real project, not a find-and-replace: a database migration with a
backfill, a deprecation window on `/api/router*` serving both spellings, and a
trace-format version bump. Do it deliberately or not at all.
