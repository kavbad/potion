// KNOWN DEFECTS — filed, reproduced, not yet fixed.
//
// Each test's BODY asserts the CORRECT behavior and is marked `it.fails`, so
// it passes precisely because the body currently fails. Three properties:
//   1. the defect is PROVEN present on every CI run, not described in prose;
//   2. the suite stays green, so a real regression still stands out;
//   3. it SELF-INVALIDATES — the day someone fixes it the body starts
//      passing, `it.fails` starts FAILING, and the fixer is forced to flip it
//      to `it()`. A defect cannot be silently fixed-and-forgotten, and the
//      marker cannot rot into a lie. That is the phantom-decision failure
//      mode (a comment asserting a protection nothing enforces), closed by
//      construction.
// NEVER delete a marker to make CI green. Fix it and flip it.
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, createOrg, deleteOrgCascade, migrate, requestLogs, type DbHandle } from './index.js';

let h: DbHandle;
beforeEach(async () => {
  h = await createDb();
  await migrate(h.db);
});

describe('KNOWN DEFECT F17: chunked cascade delete reads rowCount, which PGlite does not return', () => {
  // WHY IT MATTERS: org:delete is the GDPR/contract erasure path. The loop
  // deletes ONE chunk, reads rowCount (undefined on PGlite) as 0, and breaks.
  //
  // SEVERITY CORRECTION (2026-08-10): this is a PGlite-PATH defect, and the
  // escalation below was measured on PGlite only. node-postgres DOES return
  // `rowCount`, so on the managed Postgres production runs, the loop
  // terminates correctly and cascade erasure works. What this actually
  // invalidates is the WALKTHROUGH's "nothing derived survives" proof, which
  // runs on PGlite and is therefore vacuous above the 500-row chunk size —
  // the diligence claim is UNPROVEN at scale, not false. Still a real defect
  // for any PGlite-backed deployment. To be settled empirically against real
  // Postgres during the deployment rehearsal.
  //
  // On PGlite the failure is not
  // "under-deletes and reports 0" — the surviving rows still reference the
  // org, so the final `DELETE FROM orgs` raises 23503 and the WHOLE
  // TRANSACTION ABORTS:
  //   Key (id)=(org_f17) is still referenced from table "request_logs".
  // So erasure does not silently under-delete; it FAILS OUTRIGHT for any org
  // with more than CHUNK (500) request_logs — which is every real org. The
  // existing cascade tests pass only because their fixtures stay under 500.
  it.fails(
    'erases an org with >CHUNK request_logs at all (today: 23503 — the cascade aborts)',
    async () => {
      await createOrg(h.db, { id: 'org_f17', name: 'F17' });
      const rows: (typeof requestLogs.$inferInsert)[] = Array.from({ length: 1200 }, (_, i) => ({
        orgId: 'org_f17',
        model: 'mock-cheap',
        provider: 'mock',
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 },
        latencyMs: 1,
        status: '200',
        ts: new Date(Date.now() - i * 1000),
      }));
      for (let i = 0; i < rows.length; i += 200) {
        await h.db.insert(requestLogs).values(rows.slice(i, i + 200));
      }
      const report = await deleteOrgCascade(h.db, 'org_f17');
      // The receipt must state what was actually erased.
      expect(report.deleted.request_logs).toBe(1200);
      // …and nothing may survive.
      const left = await h.db.select().from(requestLogs);
      expect(left.filter((r) => r.orgId === 'org_f17')).toHaveLength(0);
    },
    60_000,
  );
});
