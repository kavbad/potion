// Step 10 — THE LIVE MCP LEG (operator-approved: connector=GitHub,
// read-only, minimum grant; GRANT_RISK_ACCEPTED=2026-08-13; cap $1 fuel /
// 5 tool calls, fail-closed). The first live third-party credential in the
// Lab.
//
// Preconditions, ALL BLOCKING (silence spends nothing / grants nothing):
//   · GRANT_RISK_ACCEPTED=<ISO date> — the operator's acceptance of a NEW
//     risk class: a live third-party OAuth credential in the platform store
//     (parallel to KEY_RISK_ACCEPTED, which covers model spend only).
//   · KEY_RISK_ACCEPTED=<ISO date> — model spend on OPENROUTER (the $1 fuel).
//   · OPENROUTER_API_KEY set; OPENAI/ANTHROPIC/GOOGLE/GEMINI peers UNSET.
//   · GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET — the operator's own GitHub
//     OAuth app (read-only; the zero-scope grant cannot write regardless).
//   · POTION_MASTER_KEY (64 hex) — so the sealed grant survives across the
//     server + worker boundary (the custody perimeter the leg exercises).
//
// The OAuth grant is INHERENTLY INTERACTIVE (spec §10): this script boots the
// real server, prints the authorization URL, and WAITS for the operator to
// approve it BY HAND in a browser and authenticate to GitHub — Claude never
// authenticates or clicks consent. Once the grant lands, the script runs a
// real MCP tool call under the caps, drives the call cap over 5 to prove it
// trips live, prints the ledger rows VERBATIM, then REVOKES the grant and
// records the revocation. Everything the operator pastes into the ledger.
//
// Usage (the operator runs this at a terminal, browser at hand):
//   env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GOOGLE_API_KEY -u GEMINI_API_KEY \
//     GRANT_RISK_ACCEPTED=2026-08-13 KEY_RISK_ACCEPTED=2026-08-13 \
//     GITHUB_CLIENT_ID=<id> GITHUB_CLIENT_SECRET=<secret> \
//     POTION_MASTER_KEY=<64hex> OPENROUTER_API_KEY=<key> \
//     pnpm exec tsx scripts/step10-live-mcp.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const FUEL_CAP_USD = 1.0;
const CALL_CAP = 5;
const ORG = 'org_step10_live';
const CONNECTOR = 'github';

function refuse(msg: string): never {
  console.error(`REFUSED: ${msg}`);
  process.exit(2);
}

function isoDate(v: string | undefined): boolean {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

async function main(): Promise<void> {
  // ---- blocking preconditions (BOTH risk gates) ----
  if (!isoDate(process.env.GRANT_RISK_ACCEPTED)) {
    refuse('GRANT_RISK_ACCEPTED=<ISO date> is required — a live third-party OAuth grant is a NEW risk class (silence grants nothing)');
  }
  if (!isoDate(process.env.KEY_RISK_ACCEPTED)) {
    refuse('KEY_RISK_ACCEPTED=<ISO date> is required for the $1 model fuel (silence spends nothing)');
  }
  if (!process.env.OPENROUTER_API_KEY) refuse('OPENROUTER_API_KEY is required (the ONLY accepted live model key)');
  for (const peer of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) {
    if (process.env[peer]) refuse(`${peer} is set — the risk acceptance covers OPENROUTER only; unset peers`);
  }
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    refuse('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required (the operator’s own read-only OAuth app)');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.POTION_MASTER_KEY ?? '')) {
    refuse('POTION_MASTER_KEY (64 hex) is required so the sealed grant survives the server↔worker boundary');
  }
  console.log(`── Step 10 live MCP leg ──`);
  console.log(`   GRANT_RISK_ACCEPTED=${process.env.GRANT_RISK_ACCEPTED}  KEY_RISK_ACCEPTED=${process.env.KEY_RISK_ACCEPTED}`);
  console.log(`   connector=${CONNECTOR} (read-only) caps: fuel $${FUEL_CAP_USD.toFixed(2)} / ${CALL_CAP} tool calls, fail-closed`);

  // Fresh throwaway db copy dir — nothing curated is opened in place.
  const tmp = mkdtempSync(path.join(tmpdir(), 'potion-step10-mcp-'));
  const dbDir = path.join(tmp, 'db');

  const {
    createDb, migrate, createOrg, insertPolicy, insertApiKey,
    getLabGrant, grantConnectionStatus, markLabGrantStatus, createLabRun,
    getLabRun, listLabSteps,
  } = await import('@potion/db');
  const { sha256 } = await import('@potion/core');
  const { buildServer } = await import('@potion/server/server');
  const { resumeRun, buildMcpLabTools, buildRunReport } = await import('@potion/lab-runtime');
  const { createMasterKeyProvider } = await import('@potion/custody');

  const h = await createDb(`pglite://${dbDir}`);
  await migrate(h.db);
  await createOrg(h.db, { id: ORG, name: 'Step 10 Live Org' });
  await insertPolicy(h.db, { id: `pol-${ORG}`, orgId: ORG, name: 'step10', config: { type: 'min_cost', qualityFloor: 0 } });
  const adminRaw = `pk_step10admin_${randomUUID().replace(/-/g, '')}`;
  await insertApiKey(h.db, {
    id: `key-step10-admin`, keyHash: sha256(adminRaw), name: 'step10-admin',
    orgId: ORG, policyId: `pol-${ORG}`, scopes: 'serve+admin', rateRps: 20, dailyCap: 1000,
  });

  const app = await buildServer({ db: h, seed: true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`\nserver up at ${baseUrl}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const master = await createMasterKeyProvider({ env: process.env }).getMasterKey();

  try {
    // ---- 1. Start the OAuth flow; the operator approves BY HAND ----
    const startRes = await app.inject({
      method: 'POST', url: `/api/lab/connectors/${CONNECTOR}/oauth/start`,
      headers: { authorization: `Bearer ${adminRaw}` }, payload: {},
    });
    if (startRes.statusCode !== 200) {
      refuse(`oauth/start returned ${startRes.statusCode}: ${startRes.body}`);
    }
    const { authorizationUrl } = startRes.json() as { authorizationUrl: string };
    // The state cookie must ride the operator's browser. The redirect_uri
    // points at THIS server (localhost:port); the operator's GitHub OAuth
    // app must list it as an allowed callback for the flow to complete.
    const flowCookie = String(startRes.headers['set-cookie']);
    console.log(`\n────────────────────────────────────────────────────────────`);
    console.log(`OPERATOR ACTION — approve the grant BY HAND (Claude does not authenticate):`);
    console.log(`\n  1. Open this URL in a browser signed in to GitHub as YOU:`);
    console.log(`\n     ${authorizationUrl}\n`);
    console.log(`  2. Authorize the read-only scopes. GitHub redirects to this server's`);
    console.log(`     /callback; the token is exchanged server-side and sealed. You will`);
    console.log(`     see "Connected. The filament is healed."`);
    console.log(`\n  (redirect_uri is this localhost server; the state cookie below rides your browser.)`);
    console.log(`  state cookie: ${flowCookie.split(';')[0]}`);
    console.log(`────────────────────────────────────────────────────────────\n`);
    await rl.question('Press ENTER once the browser shows "Connected"… ');

    // ---- 2. Confirm the grant landed (healed filament) ----
    const grant = await getLabGrant(h.db, ORG, CONNECTOR);
    if (grantConnectionStatus(grant) !== 'connected') {
      refuse(`grant not connected after the flow (status=${grantConnectionStatus(grant)}) — leg aborts, nothing spent`);
    }
    console.log(`✓ HEALED: grant status=connected, scopes=${JSON.stringify(grant!.scopesGranted)}, granted_by=${grant!.grantedBy}`);
    console.log(`  LEDGER (before): grant landed for ${CONNECTOR} on org ${ORG} at ${new Date().toISOString()}`);

    // ---- 3. A capped MCP run: model spend via OPENROUTER, tools via GitHub ----
    const spec = {
      specVersion: 1 as const,
      name: 'step10 live mcp harness',
      brain: { policy: { type: 'min_cost' as const, qualityFloor: 0 } },
      mission: { kind: 'task' as const, goal: 'Fetch my GitHub identity with the get_me tool and report my login.', doneDefinition: 'the login is reported' },
      superpowers: [{ id: CONNECTOR, scopes: grant!.scopesGranted, maxSpendUsdPerRun: FUEL_CAP_USD }],
      memory: { enabled: false },
      rules: [],
      fuel: { maxUsdPerRun: FUEL_CAP_USD, hardStop: true as const },
      checkIns: [{ trigger: 'before-external-action' as const }],
    };
    const { harnessSpecHash } = await import('@potion/lab-spec');
    const hash = harnessSpecHash(spec);
    const runId = `run-step10-${randomUUID().slice(0, 8)}`;
    await createLabRun(h.db, { id: runId, orgId: ORG, harnessHash: hash, harnessName: spec.name, spec });

    const { ServingClient } = await import('@potion/lab-runtime');
    const client = new ServingClient({ baseUrl, apiKey: adminRaw });
    const mcpLeg = () => buildMcpLabTools({ db: h.db, orgId: ORG, runId, masterKey: master, spec });

    console.log(`\n━━ capped MCP run ${runId} ━━`);
    let leg = await mcpLeg();
    console.log(`  tools discovered (scope-filtered): ${leg.tools.map((t) => t.name).join(', ') || '(none)'}`);
    let outcome = await resumeRun({ db: h.db, client, orgId: ORG, specText: JSON.stringify(spec), runId, tools: leg.tools, legNotes: leg.legNotes });
    await leg.close();

    // The pore fires BEFORE the first real MCP call — the operator approves.
    let hops = 0;
    while (outcome.status === 'awaiting-human' && hops < 12) {
      hops += 1;
      const run = await getLabRun(h.db, runId, ORG);
      console.log(`\n  ⏸ CHECK-IN (pore fired before external action): ${run!.pendingQuestion}`);
      const ans = await rl.question('  approve this ONE call? (yes/no) → ');
      const answer = /^y/i.test(ans) ? 'yes, proceed' : 'no';
      leg = await mcpLeg();
      outcome = await resumeRun({ db: h.db, client, orgId: ORG, specText: JSON.stringify(spec), runId, answer, tools: leg.tools, legNotes: leg.legNotes });
      await leg.close();
      if (answer === 'no') break;
    }
    while (outcome.status === 'leg-cap') {
      leg = await mcpLeg();
      outcome = await resumeRun({ db: h.db, client, orgId: ORG, specText: JSON.stringify(spec), runId, tools: leg.tools, legNotes: leg.legNotes });
      await leg.close();
    }
    console.log(`\n  run outcome: ${outcome.status}`);

    // ---- 4. Ledger the run: metered model spend, steps, redaction proof ----
    const steps = await listLabSteps(h.db, runId, ORG);
    const report = await buildRunReport(h.db, runId, ORG);
    const dump = JSON.stringify(steps);
    console.log(`\n  LEDGER (run):`);
    console.log(`    model steps: ${steps.filter((s) => s.kind === 'model').length}, tool steps: ${steps.filter((s) => s.kind === 'tool').length}`);
    console.log(`    metered model spend: $${report!.meteredTotalUsd.toFixed(4)} (est unmetered $${report!.estimatedUnmeteredUsd.toFixed(4)}) of $${FUEL_CAP_USD.toFixed(2)} cap`);
    console.log(`    redaction proof: [REDACTED:grant] present=${dump.includes('[REDACTED:grant]')}, raw-token-absent=${!dump.includes('gho_')}`);
    console.log(`    struggles: ${JSON.stringify(report!.struggles.map((s) => s.code))}`);
    // Print the model's final answer VERBATIM (the login it fetched).
    const lastModel = [...steps].reverse().find((s) => s.kind === 'model');
    if (lastModel) {
      const text = (lastModel.payload as { responseText?: string }).responseText ?? '';
      console.log(`    final answer (verbatim):\n${text.split('\n').map((l) => `    | ${l}`).join('\n')}`);
    }

    // ---- 5. Prove the CALL cap trips live: drive the tool past 5 calls ----
    console.log(`\n━━ cap proof: driving the tool past ${CALL_CAP} calls ━━`);
    const capLeg = await mcpLeg();
    const capTool = capLeg.tools.find((t) => t.name === `${CONNECTOR}.get_me`);
    if (capTool) {
      for (let i = 1; i <= CALL_CAP + 2; i++) {
        const out = (await capTool.run({})) as { capExceeded?: string; toolError?: unknown };
        const label = out.capExceeded ? `CAP TRIPPED (${out.capExceeded})` : out.toolError ? 'toolError' : 'ok';
        console.log(`    call ${i}: ${label}`);
      }
    } else {
      console.log(`    get_me not available (scope) — cap proof skipped, reported not hidden`);
    }
    await capLeg.close();

    // ---- 6. REVOKE the grant (operator's end-of-leg discipline) + ledger ----
    console.log(`\n━━ revoke ━━`);
    const revRes = await app.inject({
      method: 'POST', url: `/api/lab/connectors/${CONNECTOR}/revoke`,
      headers: { authorization: `Bearer ${adminRaw}` }, payload: {},
    });
    console.log(`  POST /revoke → ${revRes.statusCode}: ${revRes.body}`);
    await markLabGrantStatus(h.db, ORG, CONNECTOR, 'revoked').catch(() => {});
    const after = await getLabGrant(h.db, ORG, CONNECTOR);
    console.log(`  ✓ CUT: grant status=${grantConnectionStatus(after)} (the filament shows the cut)`);
    console.log(`  LEDGER (after): grant revoked for ${CONNECTOR} on org ${ORG} at ${new Date().toISOString()}`);
    console.log(`\n  ⚠ The db copy is a THROWAWAY (${dbDir}) — but the operator should ALSO revoke the`);
    console.log(`    GitHub OAuth app authorization at https://github.com/settings/applications to be certain.`);
  } finally {
    rl.close();
    await app.close();
    await h.close();
  }
  console.log(`\n── Step 10 live leg complete — the ledger evidence is above, VERBATIM ──`);
}

main().catch((e) => {
  console.error('step10 live leg crashed:', e);
  process.exit(1);
});
