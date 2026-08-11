# Test-driver semantics: where the harness differs from production

Potion's tests are hermetic. Every external dependency is swapped for an
in-process stand-in. That is what makes `pnpm test` runnable with no
containers, no keys, and no network — and it is also, structurally, the set
of places where a green suite proves less than it appears to.

This document is the audit of those swaps. For each one: **where its
behavior differs from production**, and **whether that difference hides a
failure class the suite therefore cannot see**.

It was written because of F10. Production retries every job three times
(SPEC §12.2). `MemoryQueue` — the driver every hermetic test uses — caught a
handler's throw, marked the job failed, and never retried. So a handler that
spent a customer's money and *then* threw would re-spend in production, and
no test could observe it: the failure was not merely untested, it was
**inexpressible in the harness**. The fix needed a change to the test driver
before the bug could even be written down.

The assumption behind the audit was that F10 would not be the only one. It
wasn't. There are **nine** swaps, and three findings outrank the one that
started the search.

---

## The table

| # | Swap | How the stand-in differs from production | Failure class it hides | Filed |
|---|---|---|---|---|
| 1 | **`MemoryQueue` ↔ BullMQ** | Globally serial (one job at a time, in-process); a throw marked the job `failed` with **no retry** where production retries 3×; `close()` drains the whole backlog where BullMQ drains only in-flight work; job ids are `mem-N` and **restart at 1** each process | Retry double-execution of spend and contractual effects; stalled-job redelivery; head-of-line behavior; job-id collision across restarts. **This is F10** | **F10 — fixed here** |
| 2 | **`ioredis-mock` ↔ Redis** | The BullMQ "control group" is itself a stub: blocking pops are a polling polyfill, `XTRIM` is a no-op, Lua is shimmed, and **one data context is shared per host:port across every instance in the process** | Nothing *claimed* falsely — both the test name and the mock's header disclose the sharing. But **no test crosses a real process boundary**, so BullMQ persistence is *unverified*, not falsely proven | F20 (**corrected**, see below) |
| 3 | **Mock ↔ live providers** | The mock never throws, never rate-limits, never times out, always returns logprobs, and bills `chars/4` tokens instead of a real tokenizer | Every 429 / 5xx / timeout / auth / content-refusal path; cost drift between estimated and billed tokens | partly F19 |
| 4 | **`resilient(p)` as production builds it** | **Not a test swap — a production gap.** `factory.ts` wraps every provider with no policy, and `breaker`/`hedgeAfterMs` default to *absent*, so the circuit breaker and hedging are **dead in production**. `docs/HA.md` shows `/readyz` reporting an open breaker — a state the running system cannot reach | An upstream outage becomes a latency outage: every request pays the full retry ladder instead of failing fast | **F19** |
| 5 | **PGlite ↔ node-postgres** | Single in-process connection: no lock waits, no deadlocks, no serialization failures, no concurrent writer. Separately, `db.execute()` returns **no `rowCount`** | Lost updates under concurrent writes; cascade aborts under load. And a **live defect**: the chunked cascade delete reads `rowCount` | **F17** (severity raised — see below) |
| 6 | **In-memory rate limiter** | **Not a test swap at all.** `InMemoryRateLimiterStore` is the only implementation and it is what production runs. The `opts.store` seam exists and nothing fills it | With N replicas: N× the contracted rate and N× the daily cap; a rollout resets every bucket, so a client can lift its own limit by inducing one | **F18** |
| 7 | **Cache invalidation bus** | `REDIS_URL` unset → memory-only mode, where `invalidate()` is a no-op that never throws. Tests run in that mode | A BYOK key rotation that fails to fan out to sibling replicas — stale provider credentials serving live traffic | — |
| 8 | **Deterministic ↔ real embedder** | The mock embedder is a seeded synthetic vector generator; clustering fixtures are built to separate cleanly | Real-embedding degeneracy: clusters that do not separate, dimension drift, provider changes to the embedding model | — |
| 9 | **Local ↔ S3 artifacts; stubbed ↔ real alert transports** | Local filesystem writes never partially fail, never 503, never need credentials; alert webhooks are `fetch` stubs | Artifact write failures mid-run; webhook delivery semantics under a slow or flapping receiver | — |

---

## The cross-cutting finding

Reading the nine together, one pattern accounts for most of them:

> **The test default is always the option that cannot fail.**

`MemoryQueue` cannot run a handler twice. The mock provider cannot throw.
PGlite cannot have a concurrent writer. The in-memory limiter cannot be
inconsistent. The invalidation bus cannot fail to deliver, because it does
not deliver.

Each choice is individually defensible — that is exactly why the pattern
survived. But the aggregate effect is that **the error branches built for
production are reachable almost nowhere in the suite**: only from
`tests/chaos/` (4 files) and the stubbed-`fetch` provider tests. Every other
test runs the happy path of a stand-in that has no unhappy path.

The practical rule this suggests, for any future stand-in:

> A stand-in must be able to express the failures the real thing has, even
> if no test uses that ability yet. If it cannot, say so at the swap point,
> and treat the corresponding production behavior as unverified.

`MemoryQueue` now takes `{ attempts }` for exactly this reason. It is not
used by most tests; it exists so the failure is *expressible*.

---

## Two corrections to my own filings

Both were caught by applying the swarm's "fails for the right reason"
standard to my own findings. Recording them because a finding that survives
scrutiny unchanged is rarer than the filings suggest.

**F17 was filed too low.** Filed as "under-deletes and reports 0". Actually
reproducing it showed worse: the rows that survive the truncated loop still
reference the org, so the final `DELETE FROM orgs` raises `23503` and **the
entire erasure transaction aborts**:

```
Key (id)=(org_f17) is still referenced from table "request_logs".
```

So org deletion does not quietly under-delete — it **fails outright for any
org with more than 500 request logs**, which is every real org. The existing
cascade tests pass only because their fixtures stay under the chunk size.
Raised to CRITICAL and pre-traffic.

**F20 was filed wrong and is withdrawn as a defect.** It claimed the BullMQ
durability test was a phantom proof. It is not: the test is named `jobs
survive a driver restart (new driver, same data context)` and
`testing/mock-redis.ts` carries an explicit DATA-SHARING NOTE. Nothing
asserts a protection that does not exist, so this is not the
phantom-decision pattern and gets no `it.fails` marker. What survives is
row 2's narrower claim: real-Redis persistence is **unverified**. The
premise is now pinned by a passing test so that if `ioredis-mock` ever
isolates instances, it surfaces in one line instead of silently changing the
meaning of the restart test.

---

## How the filed items are recorded

Each hidden class is filed with a **reproducing test**, held as an
`it.fails()` marker (`known-defects.test.ts` in the owning package). The
body asserts the *correct* behavior, so the marker passes precisely because
the body currently fails. Three properties:

1. the defect is **proven present on every CI run**, not described in prose;
2. the suite stays **green**, so a real regression still stands out;
3. it **self-invalidates** — the day someone fixes it, the body starts
   passing, `it.fails` starts failing, and the fixer is forced to flip it to
   `it()`.

That third property is the point. A defect cannot be silently
fixed-and-forgotten, and the marker cannot rot into a lie — which is the
phantom-decision failure mode, closed by construction.

Every marker was verified two ways: it passes as `it.fails`, and when
flipped to `it()` it fails **with the stated assertion** rather than a setup
error or a timeout. The first F19 draft failed by timing out; that is an
ambiguous reason and was rewritten until it failed on the assertion
(`expected [] to include 'openai:gpt-frontier-class'`).
