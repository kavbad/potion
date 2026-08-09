# G2.8 — parameters under test, measured against a real workload

The owner's instruction for the capstone: *"Treat the retention floor and
derived floors as parameters under test: report what the workload suggests they
should be, don't just assert the defaults."*

**The workload:** 48 Claude Code subagent sessions from one project, converted to
SPEC §14.1 traces. 1,941 spans, 48/48 carrying a `gen_ai.completion` (so every
replay item is reference-anchored — the only judging configuration this project
has ever measured above the 0.8 trust bar). One tenant, one project, one kind of
work. Every number below inherits that narrowness and is labelled accordingly.

**Standing rule for this document:** each recommendation names *which copy* of a
duplicated constant it applies to, because 0.9 and 0.62 each live in more than
one place and a partial change diverges silently. And no parameter is moved to
make this run's result look better — where the evidence is thin, the
recommendation is "insufficient evidence", not a nudge.

---

## 1. Cluster formation is bounded by the corpus, not by our constants

Measured, real embedder (`text-embedding-3-small`, 384-dim) at
`POTION_CLUSTER_THRESHOLD=0.2`:

| cluster | sessions | suite items |
|---|---|---|
| `agent-2dfbfb-d8898a` (Bash>Read) | 23 | 23 |
| `agent-2dfbfb-f620ca` (Bash) | 15 | 15 |
| `agent-2dfbfb-dd184b` (Bash>Write) | 5 | 5 |
| `agent-2dfbfb-20ff80` (Bash>Read>ToolSearch) | 2 | 2 |
| three singletons | 1 each | 1 each |

**Finding — the real pipeline recovers the workload's true structure.** The same
corpus under the toy word-hash embedder at the mock-tuned 0.62 produced **30
clusters, 28 of them unverifiable**. Under the real embedder at the recorded 0.2
it produces **7, exactly matching the tool-signature buckets**. The
fragmentation was an artifact of the test double, not a property of the
workload. This is worth stating positively: when configured as documented, the
clustering stage reproduces the structure a human would draw by hand.

**Finding — 4 of 7 clusters can never render a verdict.** `SUITE_VERIFY_MIN_PAIRS`
is 5; four clusters have 1–2 items. There is **no minimum-cluster-size constant
anywhere in the code** — `tracesClusterHandler` will happily create a group from
a single member. Those clusters get a cluster row, a derived suite, a rubric and
a frontier, and can never produce the retention verdict the product sells.

**Recommendation:** introduce `AGENT_CLUSTER_MIN_SESSIONS`, set to
`SUITE_VERIFY_MIN_PAIRS` (5), applied at synthesis time — a cluster below it is
recorded but marked `insufficient-corpus` rather than given a suite and a
frontier. Confidence: **high** on the need (it is an arithmetic certainty, not a
statistical one), **medium** on the exact value (5 is the downstream
requirement; whether a *useful* cluster needs more is a separate question this
corpus cannot answer).

---

## 2. `AGENT_SUITE_ITEM_CAP` vs `confidenceFor` — the two constants disagreed

**They contradicted each other.** `AGENT_SUITE_ITEM_CAP` was 25;
`confidenceFor` draws its low/medium line at 30 (`apps/server/src/routes/reports.ts:57`).
A derived-suite retention verdict could therefore *never* report better than
`low` confidence — the cap sat below the confidence boundary, so the cap always
won and the confidence tier was decorative.

**Changed in this run (owner's call): 25 → 48.** That was the right change and it
did real work — the target cluster's suite went from 8 items to 23, and the
retention CI narrowed accordingly.

**But the cap is no longer what binds.** A cluster cannot span tool-signature
buckets, and one replay item is derived per session, so a cluster's item count
is bounded by its bucket's session count *first*. The largest bucket here holds
23 sessions. **Max pairs = 23 < 30, whatever the cap is.** Raising the cap
removed an artificial ceiling; the corpus imposes a real one.

**The band-placement question, left open deliberately.** Is 30 the right
low/medium line? The honest answer from this run is: *we cannot tell, and it
would be improper to decide it here.* Two reasons —

1. `confidenceFor` was written for **shadow-sample counts** in the savings
   report, where n is per-request and grows into the thousands. It is being
   reused for **retention pairs**, where n is per-suite-item and structurally
   bounded by the customer's tool-graph diversity. Those are different
   populations with different growth; one threshold serving both is an
   assumption nobody has tested.
2. Moving the line to 20 or 25 would let this run's verdict read `medium`. That
   is precisely the reasoning to refuse. The tier should be set from the width
   of the interval it is meant to summarise, not from what makes the current
   run look better.

**Recommendation:** keep `confidenceFor` at 30 for now; **split the function**
so retention pairs and shadow samples get separate, separately-justified tiers,
and derive the retention tiers from observed CI half-width across several real
workloads. Confidence: **high** that the shared function is wrong, **none** on
where a retention-specific line belongs — one workload cannot site it.

---

## 3. `SUITE_VERIFY_EPSILON` = 0.05 — untested until now, and untriggered

The epsilon excludes pairs whose *incumbent* score is below 0.05, on the
grounds that a ratio against ~0 is noise. A companion guard refuses the verdict
if more than half the pairs are excluded.

**Measured: 0 of 23 pairs excluded.** The mechanism did not fire on real data.

**Recommendation: leave at 0.05.** A parameter that never triggered has produced
no evidence for or against its value; changing it would be superstition.
Confidence: **n/a — no evidence either way.** Worth re-checking on a workload
where the incumbent genuinely fails some items (this corpus's incumbent scores
were uniformly non-trivial).

---

## 4. The cosine threshold lives in two places, and one of them was deaf

`AGENT_CLUSTER_COSINE_THRESHOLD` (`packages/workers/src/handlers.ts:1788`) and
`DEFAULT_THRESHOLD` (`packages/cluster/src/assigner.ts:37`) are both 0.62.

G0.5 measured the real-embedder cliff on a held-out set — **96.00% across
0.05–0.2, 92.50% @0.30, 82.50% @0.40, 45.50% @0.50, 6.00% @0.62** — recommended
`POTION_CLUSTER_THRESHOLD=0.2` for live deployments, and wired that override
into the **serving assigner only**. The agent-clustering path, added later in
G1.2, declared its own constant and read no environment at all. **Setting the
documented fix had zero effect on agent clustering**, and would have reproduced
the 6% cliff while appearing correctly configured.

Fixed in G2.8: the agent path honours the override, and
`resolveAgentClusterThreshold` **refuses** a live embedder above 0.4, citing the
measurement.

**Recommendation:** the default should stay 0.62 (it is correct for the mock
embedder, 89.00% measured) and the guard should carry the risk — which is what
now happens. The deeper fix is to stop having two constants: the threshold
belongs with the embedder that determines it, resolved together. Confidence:
**high** — this is a live measurement from G0.5, not an inference from this run.

---

## 5. The judge trust gate reads Pearson; should it read Spearman?

**The measurement.** Live probe calibration, `judge-class` against constructed
truth from the workload's own references, n=69:

| statistic | estimate | bootstrap CI95 | verdict against the 0.8 bar |
|---|---|---|---|
| Pearson | 0.6049 | **[0.5239, 0.7964]** | **fails** — the whole interval is below the bar |
| Spearman | 0.8107 | **[0.6975, 0.8932]** | **STRADDLES the bar** |
| mAE | 0.3728 | — | advisory |

**The recorded three positions were: (a) gate on Spearman; (b) gate on Spearman
for the retention leg and Pearson where absolute level matters; (c) keep
Pearson. The evidence supports (c) — and it is worth being precise about why,
because the point estimates argue the opposite.**

Read as point estimates, this run looks like the textbook case for switching:
r=0.605 fails, ρ=0.811 clears, monotone distortion, the judge ranks correctly
on a compressed scale. That is the argument the previous session recorded, and
it is wrong.

**The intervals say the Spearman "pass" is not a pass.** ρ's CI95 spans 0.8.
The run is **not powered to conclude that this judge clears a Spearman bar** —
it is powered only to conclude it fails a Pearson one, since Pearson's entire
interval sits below 0.8. Switching the gate would convert a defensible
*rejection* into an undefensible *acceptance*: exactly the direction a trust
gate must never move on thin evidence.

This is the failure mode the bootstrap CIs were added for. The recorded
follow-up said "single-run correlations carry ±0.1-scale error"; here the
half-widths are ±0.136 (Pearson) and ±0.098 (Spearman), so a point estimate
0.011 above the bar means nothing.

**Recommendations, in order of confidence:**

1. **Gate on the INTERVAL, not the point estimate** — confidence **high**.
   `flagged = pearsonVsTruth < 0.8` should become `flagged = pearsonCi95[0] <
   0.8` (clears only when the whole interval clears), with a distinct
   `trustIndeterminateAtN` state when the interval straddles. The field already
   exists (G2.8); nothing reads it yet. This is a strictly better gate under
   either statistic and does not require settling the Pearson/Spearman question.
2. **Do NOT switch the gate to Spearman on this evidence** — confidence
   **high**. The argument for switching is real in principle (retention is
   scale-free, so ranking is what the contract needs) but this run cannot
   support it, and it is the run that would benefit.
3. **The scale-free argument deserves a properly powered test** — confidence
   **medium** that it will hold. Design: a calibration corpus large enough that
   ρ's CI half-width is under ~0.05 (n in the low hundreds, versus 69 here),
   then ask whether ρ's lower bound clears 0.8 while r's does not. If it does,
   position (b) becomes defensible: Spearman for the retention leg where only
   ordering matters, Pearson wherever an absolute level is asserted.

**Note the mAE, 0.3728.** Even granting correct ranking, this judge's scores sit
a third of the scale away from truth. Any surface that reports a raw quality
LEVEL from this judge (the report's `qualitySeries`, the frontier's `quality`
coordinate) inherits that error. Ranking-only trust would need those surfaces
relabelled, not just the gate changed — an argument for (b) being more invasive
than it first appears.

---

## 6. The retention floor, 0.9 — enforceable here by 0.5%

**The measurement.** Live suite-verify, incumbent `1a9bac73` (mean 0.2000) vs
serving candidate `8fe33bc4` (mean 0.0491), on the 23-item derived suite:

```
outcome    contractual-breach
retention  mean 0.2707   ci95 [0.1754, 0.3743]   half-width 0.0995
pairs      23 usable, 0 excluded (SUITE_VERIFY_EPSILON never fired)
floor      0.9
```

The breach itself is unambiguous: the CI *upper* bound (0.3743) is far below
0.9, so the verdict is correct and confidently so.

**But the number that matters for the parameter is the half-width: 0.0995
against a slack of 0.1000** (slack = 1 − floor, the distance a retention can
fall before crossing). The floor is enforceable at n=23 **by half a percent of
the available margin.**

**What that implies, stated carefully.** A breach is only *detectable* when the
CI upper bound falls below the floor. With half-width ≈0.10:

| true retention | CI upper ≈ | detectable at n=23? |
|---|---|---|
| 0.27 (this run) | 0.37 | yes, decisively |
| 0.70 | 0.80 | yes |
| 0.85 | 0.95 | **no** — reported `not-significant` |
| 0.89 (a marginal breach) | 0.99 | **no** |

So the guarantee as configured catches *catastrophic* regressions and is blind
to *marginal* ones — the 0.85–0.90 band, which is exactly where a real quality
drift would first appear. That is the honest reading of "enforceable by 0.5%".

**Recommendations:**

1. **Do not move the floor.** Confidence **high**. 0.9 is a contract term; the
   evidence says the *evidence* is too thin at n=23, not that the floor is
   wrong. Lowering it to make this workload comfortable would trade a
   meaningful promise for a measurable one.
2. **Report the detectable-drop threshold alongside the verdict.** Confidence
   **high**. The report should say "at 23 pairs this guarantee detects drops
   below ~0.80" rather than only "all-clear" — an all-clear at n=23 means
   considerably less than an all-clear at n=200, and the customer cannot tell.
   The half-width is already computed; it just is not surfaced.
3. **The n needed for a marginal breach.** Confidence **medium** (extrapolated,
   not measured). CI width scales roughly as 1/√n, so detecting a drop to 0.89
   needs a half-width near 0.01 — on the order of **100× the pairs**, i.e.
   thousands. That is not reachable from replay suites bounded by tool-signature
   buckets. It IS reachable on the serve path, where n grows per request. This
   argues the two legs of the trust hierarchy have different natural
   sensitivities, and the contractual leg should state its own.
4. **`retentionFloor` appears in two code copies** —
   `PLATFORM_RETENTION_FLOOR` (`apps/server/src/routes/guarantee.ts:139`) and
   `DEFAULT_RETENTION_FLOOR` (`packages/workers/src/handlers.ts:2979`), plus the
   optional schema field. Any change must touch both; they cannot be allowed to
   drift, since one drives the verdict and the other drives what the customer is
   told the verdict was measured against.

---

## 7. What this workload could NOT tell us

Recorded so the report is not read as more than it is.

- **One tenant, one project, one kind of work.** Every number above is a single
  observation. Nothing here establishes a distribution across customers.
- **The derived suite is a hard eval by construction.** Replay items ask a
  single model call to reproduce the final report of a 40-tool-call agent
  session, with the tool transcript in the prompt. Measured live means: 0.2000 /
  0.0491 / 0.0000 across three strategies. Those are *low* absolute scores, and
  the frontier collapsed to **1 non-dominated point of 3 evaluated** because two
  strategies were dominated everywhere. **Open question this run raises but
  cannot answer: is a replay suite derived from long agentic sessions a fair
  eval for single-call strategies at all?** If not, the retention denominator is
  measuring the wrong thing for this class of workload.
- **The serve leg did not run**, so there are no `quality_samples`, no derived
  serve floor, and no report entries. `deriveServeFloor` remains unmeasured
  against real data.
- **`SUITE_VERIFY_EPSILON` never fired** (0 of 23 excluded), so its value
  remains untested.

