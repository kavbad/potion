# Potion Research — operations runbook (v1, 2026-09-02)

**Status: the F-ladder's operating manual.** The fleet doctrine is
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

## Filed follow-ups

- **Monday observatory automation** — the clock starts only when the
  measurement half has landed `runs/<week>.json`; that half is still
  hand-run.
- **runx- sessions on the dashboard run route**: the gate session's
  recorded resolutions are read via `DATABASE_URL` by the release script
  because `GET /api/lab/runs/:id` rejects the id shape; serve them.
- **PASS WITH REQUIRED CHANGES**: the fleet doc's middle verdict state;
  the v1 record collapses to pass/fail.
- **Done-verifier hollow class**: run-8a3ec460 completed on a mid-thought
  message with its doneDefinition unmet — a runtime bug the client-side
  laws cannot reach.
- Stray pre-fix W36 copies sit in the unused `/opt/potion/research/notes/`
  — remove at leisure.
