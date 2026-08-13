// Step 8 — THE FIRST LIVE FELT LEG (carried DoD item 2; operator-approved
// under the KEY_RISK_ACCEPTED standing rule, review outcomes 0 and 3).
//
// Preconditions, ALL BLOCKING (silence spends nothing):
//   · KEY_RISK_ACCEPTED=<ISO date> in env — the operator's risk-acceptance
//     gate for live spend on the chat-transited OPENROUTER key (provider-side
//     cap is the backstop; a future rotation supersedes). Refuse without it.
//   · OPENROUTER_API_KEY set; OPENAI/ANTHROPIC/GOOGLE/GEMINI peers UNSET —
//     the Step 5 leg-script guard: the acceptance covers OPENROUTER only.
//   · Hard cap $1.00, fail-closed via the Step 7 felt sweep cap machinery
//     (unknown metered cost consumes the remainder; cache hits are free).
//
// Vehicle: a COPY of the Step 5 campaign db (.pglite/platform-sweep-step5 —
// ten LIVE platform frontiers; the curated dir is never opened in place),
// the real server booted against it, felt at 2 dial positions on each of 2
// clusters through the real route. Samples print VERBATIM — they are pasted
// into the ledger and the operator's reading completes at countersign.
//
// Usage:
//   env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GOOGLE_API_KEY \
//     KEY_RISK_ACCEPTED=<date> pnpm exec tsx scripts/step8-live-felt.ts
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FeltPositionRequest } from '@potion/lab-dial';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CAMPAIGN_DB = path.join(REPO_ROOT, '.pglite', 'platform-sweep-step5');
const CAP_USD = 1.0;
const CLUSTERS = ['summarization', 'code-gen'] as const;
const ORG = 'org_platform_ops';

function refuse(msg: string): never {
  console.error(`REFUSED: ${msg}`);
  process.exit(2);
}

async function main(): Promise<void> {
  // ---- blocking preconditions ----
  const accepted = process.env.KEY_RISK_ACCEPTED;
  if (!accepted || !/^\d{4}-\d{2}-\d{2}$/.test(accepted)) {
    refuse('KEY_RISK_ACCEPTED=<ISO date> is required for any live-spend script (standing rule; silence spends nothing)');
  }
  if (!process.env.OPENROUTER_API_KEY) refuse('OPENROUTER_API_KEY is required (the ONLY accepted live key)');
  for (const peer of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) {
    if (process.env[peer]) refuse(`${peer} is set — the risk acceptance covers OPENROUTER only; unset peers`);
  }
  console.log(`── Step 8 live felt leg ── KEY_RISK_ACCEPTED=${accepted}, cap $${CAP_USD.toFixed(2)}`);

  // ---- copy the campaign db (never open the curated dir in place) ----
  const tmp = mkdtempSync(path.join(tmpdir(), 'potion-step8-felt-'));
  const dbCopy = path.join(tmp, 'db');
  cpSync(CAMPAIGN_DB, dbCopy, { recursive: true });
  console.log(`campaign db copied → ${dbCopy}`);

  const { createDb, insertApiKey, insertPolicy, getPolicyById } = await import('@potion/db');
  const { sha256 } = await import('@potion/core');
  const { buildServer } = await import('@potion/server/server');
  const {
    loadDialContext, domainFromContext, viewPosition, materializeDialPolicy,
    feltSweep, feltSampleCache, missionProbe, requestLogCostLookup,
  } = await import('@potion/lab-dial');
  const { ServingClient } = await import('@potion/lab-runtime');

  const h = await createDb(`pglite://${dbCopy}`);
  const app = await buildServer({ db: h, seed: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`server up at ${baseUrl} (live mode: OPENROUTER key present)`);

  // Serve credential for the leg: policy-bound key on the campaign org,
  // raw held only in this process, db copy discarded after.
  const polId = 'pol-step8-felt';
  if ((await getPolicyById(h.db, ORG, polId)) === null) {
    await insertPolicy(h.db, { id: polId, orgId: ORG, name: 'step8-felt', config: { type: 'min_cost', qualityFloor: 0 } });
  }
  const rawKey = `pk_step8felt_${randomUUID().replace(/-/g, '')}`;
  await insertApiKey(h.db, {
    id: `key-step8-felt-${randomUUID().slice(0, 8)}`,
    keyHash: sha256(rawKey),
    name: 'step8-felt-leg',
    orgId: ORG,
    policyId: polId,
    rateRps: 10,
    dailyCap: 1000,
  });

  let spentTotal = 0;
  try {
    for (const clusterId of CLUSTERS) {
      console.log(`\n━━ cluster ${clusterId} ━━`);
      const loaded = await loadDialContext(h.db, { orgId: ORG, clusterId });
      if (!loaded.ok) {
        console.log(`  context gap: ${JSON.stringify(loaded.gap)} — skipping cluster`);
        continue;
      }
      const d = domainFromContext(loaded.context, { slot: 'brain', toolBearing: false });
      if (!d.ok) {
        console.log(`  domain gap: ${JSON.stringify(d.gap)} — skipping cluster`);
        continue;
      }
      const probe = missionProbe({
        goal:
          clusterId === 'summarization'
            ? 'Summarize the tradeoffs of caching aggressively at the CDN edge for a news site'
            : 'Write a Python function that merges two sorted lists into one sorted list',
        doneDefinition: 'A single clear response exists',
      });
      // Two positions: the bottom rung and the top rung of the ladder
      // (deduped — a one-rung ladder is one position, not a cache echo).
      const requests: FeltPositionRequest[] = [];
      for (const k of [...new Set([0, d.domain.ladder.length - 1])]) {
        const view = viewPosition(d.domain, { qualityIndex: k });
        if (!view.feasible) {
          console.log(`  rung ${k}: infeasible (${view.gap.code}) — reported, not silently skipped`);
          continue;
        }
        // One policy row PER RUNG: the row name embeds only the FIRST 12
        // chars of the harness hash, so the rung discriminator must lead —
        // a trailing suffix truncates away, rungs then share one row, the
        // last materialization wins, and every ref serves the wrong policy
        // (the first run of this leg did exactly that; the divergence
        // detector caught it typed).
        const row = await materializeDialPolicy(h.db, {
          orgId: ORG, harnessHash: `s8r${k}${clusterId}`.replace(/[^a-z0-9]/g, '').padEnd(16, '0'),
          slot: 'brain', policy: view.policy,
        });
        requests.push({
          orgId: ORG, probe, policy: view.policy, policyRef: row.name,
          frontierId: view.frontierId, expectedStrategyHash: view.strategyHash,
        });
        console.log(`  rung ${k}: q=${view.quality} $${view.costPer1K}/1K p95=${view.latencyP95}ms → ${row.name}`);
      }
      if (requests.length === 0) continue;
      const remaining = CAP_USD - spentTotal;
      if (remaining <= 0) {
        console.log('  cap consumed — no further positions felt');
        break;
      }
      const sweep = await feltSweep(requests, {
        clientFor: (policyRef) => new ServingClient({ baseUrl, apiKey: rawKey, policyRef, clusterHint: clusterId }),
        cache: feltSampleCache(h.db),
        costLookup: requestLogCostLookup(h.db),
      }, remaining);
      for (const s of sweep.samples) {
        if (s.outcome.ok) {
          const x = s.outcome.sample;
          // costUsd is null when the request_logs join has not resolved —
          // FAIL CLOSED like the sweep's own cap: an unresolved cost
          // consumes the cluster's remaining budget (review finding: never
          // fail open, and never crash after live money moved).
          if (!x.cached) spentTotal += x.costUsd ?? remaining;
          console.log(`\n  ── SAMPLE (${s.policyRef}) ──`);
          console.log(`  strategy=${x.strategyHash8} provenance=${x.provenance} cached=${x.cached}`);
          console.log(`  costUsd=${x.costUsd !== null ? `$${x.costUsd.toFixed(4)}` : 'UNRESOLVED (consumes remaining cap)'} latencyMs=${x.latencyMs}`);
          if (s.outcome.divergent) console.log(`  DIVERGENT: ${JSON.stringify(s.outcome.divergent)}`);
          console.log(`  output (verbatim):\n${x.output.split('\n').map((l) => `  | ${l}`).join('\n')}`);
        } else {
          console.log(`  ── SAMPLE (${s.policyRef}) FAILED: ${s.outcome.error}`);
        }
      }
      if (sweep.gap) console.log(`  cap gap: ${JSON.stringify(sweep.gap)}`);
    }
  } finally {
    await app.close();
    await h.close();
  }
  console.log(`\n── leg complete — metered total $${spentTotal.toFixed(4)} of $${CAP_USD.toFixed(2)} cap ──`);
  console.log('Samples above are the ledger evidence VERBATIM; the operator’s reading completes at countersign.');
}

main().catch((e) => {
  console.error('felt leg crashed:', e);
  process.exit(1);
});
