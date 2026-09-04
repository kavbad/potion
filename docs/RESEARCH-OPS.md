# Potion Research — operations runbook (v1, 2026-09-02)

**Status: the F-ladder's operating manual (F0–F7 shipped).** The fleet doctrine is
`docs/RESEARCH-FLEET.md`; the writing standard is
`docs/RESEARCH-WRITING.md`; this is how the weekly loop actually runs.
Built F0–F2 (2026-09-01/02): Delta writes in a recorded run, Auditor
independently verifies, four deterministic guards screen every draft, and
publication passes the Action Gateway — born supervised, earned per the
grant ledger.

## The rig (org-research, on prod)

- Org `org-research` ("Potion Research"), user `user-research-ops` —
  created by `scripts/research-org-rig.ts` (re-run mints a fresh
  `POTION_LAB_SESSION`; needs `DATABASE_URL` from `.env.prod`).
- Gate key: `scripts/research-key-mint.ts` → `POTION_RESEARCH_KEY`
  (rotates on re-run).
- Workers (hire scripts re-create deterministically; DIAL each new hire):
  - Delta: `scripts/delta-hire.ts` → hash, then
    `POST /api/lab/harnesses/<hash>/dial {"slot":"brain","qualityIndex":2}`.
  - Auditor: `scripts/auditor-hire.ts` → hash, then the same dial.
  - Rung 2 is the proven spot; rung 3 was a slow reasoner that
    hollow-completed.
- Current generations (2026-09-02): Delta v6 dialed `8aec3d6c…`,
  Auditor v4 dialed `03ba2065…`.

## The weekly ceremony

**Monday — measurement (existing, still manual).** The observatory run
produces `/opt/potion/research/artifacts/runs/<WEEK>.json` on prod.

**Tuesday — draft, verify, gate.** From a repo checkout with a store copy
(`ssh root@178.105.98.174 'tar -C /opt/potion/research -czf - store-copy' | tar -C <dir> -xzf -`):

```bash
OBSERVATORY_DB=<dir>/store-copy OBSERVATORY_ARTIFACTS=<dir>/artifacts \
WEEK=<YYYY-Www> DELTA_HARNESS=<delta> AUDITOR_HARNESS=<auditor> \
POTION_LAB_SESSION=<ps_…> POTION_RESEARCH_KEY=<pk_…> \
POTION_LAB_URL=https://api.withpotion.com DELTA_TIMEOUT_MS=480000 \
npx tsx scripts/frontier-notes-week.ts
```

The chain: Delta run drafts from a REDACTED fact sheet (vague savings
removed) → count audit → style lint → vague-ratio guard → Auditor run
verifies (typed record; no verdict = fail for model prose) → publish
gate. Every failure falls back down the chain and the note still writes —
model prose never ships unverified, and the note is never blocked.

**The publish gate (F2).** While the `publish_frontier_notes` grant is
supervised the issue lands `held` with the supervisor question. Approve
the exact draft (fingerprint-bound), then release:

```bash
DATABASE_URL=<prod> NOTES_DIR=<dir>/artifacts/notes WEEK=<YYYY-Www> \
POTION_RESEARCH_KEY=<pk_…> DELTA_HARNESS=<delta> \
npx tsx scripts/frontier-notes-release.ts
```

Release re-checks the SAME content hash — an edited file voids the
approval. Approvals and clean outcomes accumulate on the grant ledger
(`GET /api/lab/harnesses/<delta>/grants`); when the graduation pass
proposes autonomy, **accepting it is the operator's click**
(`POST /api/lab/grants/<id>/accept`) — never an agent's.

**Publish to the site.** The dashboard serves
`/opt/potion/research/artifacts/notes` (read-only mount,
`deploy/docker-compose.prod.yml`). Copy the released files:

```bash
scp <dir>/artifacts/notes/<WEEK>.json <dir>/artifacts/notes/<WEEK>.md \
  root@178.105.98.174:/opt/potion/research/artifacts/notes/
```

Then verify `withpotion.com/research/<week>` renders the byline, the
run-record box, and the verification line.

## Surfaces (F3)

- Author pages: `/research/authors/<slug>` — identity from
  `apps/dashboard/lib/research-authors.ts`, every number derived from the
  published issues (run ids, verification records, counts).
- Glossary: `/research/glossary` — the canonical definitions (E6);
  articles link, never redefine. Held/drift carry the ONE-SIDED law
  (`observatory.ts` `driftVerdict`: collapse-only).
- CTAs: `apps/dashboard/lib/research-ctas.ts` — a CTA resolves to a LIVE
  surface or it does not exist (E7).

## The daily ledger (F6 — live)

`dailyLedgerTick` runs on the same 60s clock, once per UTC day: it
composes the day's facts from `research_cycles` and `recipe_status`
(24h window), starts ONE Delta framing run, and publishes
`<YYYY-MM-DD>.{json,md}` into the notes dir. The framing is an
improvement attempt, never a gate — a refused framing (THE NUMBER LAW,
or no `daily.json`) publishes the code-composed ledger instead, so the
day is never missed. A daily needs no gate ask: its content is
code-composed and the publish grant covers the class.

## The clock (F4 — live)

The Tuesday chain runs INSIDE the server: a 60-second tick
(`apps/server/src/research-clock.ts` wiring
`frontierNotesTick`/`clock.ts` in @potion/workers) that, from Tuesday
06:00 PT, watches for `artifacts/runs/<week>.json` and drives
draft → guards → verify → gate → land, one small durable step per tick
(state in `artifacts/fnotes-state/<week>.json`). Bounded draft attempts;
on exhaustion the deterministic draft ships through the same gate — the
note always lands, model prose never lands unverified. A gate-held issue
self-releases when the operator's recorded approval appears (or the
grant is autonomous). Armed by four env vars in `.env.prod`
(`POTION_RESEARCH_DIR=/research`, `POTION_RESEARCH_ORG=org-research`,
`POTION_RESEARCH_DELTA_HARNESS`, `POTION_RESEARCH_AUDITOR_HARNESS`) +
the `/opt/potion/research:/research` rw mount (compose). Manual trigger
and status: `POST/GET /api/research/frontier-notes` (admin; POST takes
`{week?, dir?}` — a `dir` under the mount runs a full REHEARSAL chain
without touching the public notes). The tick never blocks the queue (one
worker, concurrency 1 — a waiting job would deadlock it; the clock is an
in-process tick like the reaper). Update the harness env vars when a new
generation is promoted.

## The roadmap (operator-directed, 2026-09-03)

- **F5 — automate Monday — SHIPPED (55076e7)**: the Monday tick RUNS the
  proven `scripts/observatory-week.ts` inside the server container (the
  runtime image carries the tree and tsx), so the money path is never
  duplicated and its envelope belt is untouched. **DISARMED unless
  `POTION_OBSERVATORY_ARM=YYYY-MM-DD`** is set in `.env.prod` — the same
  dated risk-acceptance the script demands by hand, deliberately not
  defaulted in compose. One run per ISO week (exclusive `wx` marker +
  run-file guard; a non-zero exit clears the marker so a failed week
  retries). Never a queue job — a long measurement would starve the
  fleet's own `lab:run` legs at concurrency 1. `FRONTIER_NOTES_SKIP=1`
  stops the script publishing its own note: it used to write the week's
  issue via the OLD one-shot path, which would have preempted
  Delta/Auditor/the gate. Trigger:
  `POST /api/research/frontier-notes {"measure":"dry"|"run"}` (dry plans
  without spending); `GET` reports arm state and any running measurement.
  **ARMED on prod 2026-09-04 by operator order** (`POTION_OBSERVATORY_ARM=2026-09-04`
  appended to `.env.prod`, backup `.env.prod.bak-202609040447`). First
  automated measurement: **Monday 2026-09-07, 06:00 PT** (W37). Expected
  spend ≈ $8/week (10 canaries $2 + 3 auditions $6) inside the $50
  monthly envelope. Belts verified live at arm time: the week guard
  refused a real `run` for an already-measured week, and a `dry` spawn
  succeeded while creating no week lock. **To disarm: remove that line
  and recreate the server.**
- **F6 — the daily cadence — SHIPPED (05026b3)**: `dailyLedgerTick`
  runs beside the weekly on the same 60s clock. The daily UNIT is the
  ledger of what the instruments did in 24h (cycles, candidates swept,
  aliases measured, promotions, spend), composed BY CODE from the day's
  rows — true by construction, so a quiet day publishes a short quiet
  ledger and never a manufactured finding. The model writes only the
  framing; THE NUMBER LAW (`auditDailyNumbers`) refuses any figure not
  in the ledger and any derived ratio outright. Files land as
  `<YYYY-MM-DD>.json` beside the weeks. If the framing is refused the
  deterministic ledger ships — the day is never missed.
- **F7 — the reading experience — SHIPPED (05026b3)**: /research is an
  editorial magazine — featured issue, live DAILY LEDGER rail, a "why
  these numbers are different" band, archive grid with kind tags and
  linked bylines. Structure borrowed from review.firstround.com; the
  standing design law held (no serif, mono labels ≥12px, ledger
  masthead kept).
- **The done-verifier law — SHIPPED (05026b3)**: a task whose
  doneDefinition names a deliverable file the run does not hold cannot
  complete, even on a stop that names nothing (`doneFileRepair`, one
  round, replay-mirrored). Platform-wide, not fleet-only.

## The loop, closed

Monday measures (F5, when armed) → Tuesday drafts, verifies, gates and
publishes (F4) → every day files a ledger (F6) → the magazine renders it
(F7). No operator machine is in the loop for any of it; the operator's
remaining levers are the arm date, the standing grant, and the veto.

## Filed follow-ups
- **runx- sessions on the dashboard run route**: the gate session's
  recorded resolutions are read via `DATABASE_URL` by the release script
  because `GET /api/lab/runs/:id` rejects the id shape; serve them.
- Stray pre-fix W36 copies sit in the unused `/opt/potion/research/notes/`
  — remove at leisure.
