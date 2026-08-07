// Gate 6 cold-start walkthrough (SPEC §9 → Verification).
//
// Boots the API server (fresh in-memory PGlite → auto-seed) and the dashboard
// (`next start`, production build), then drives the new-user flow end-to-end
// through the dashboard's proxy route handlers:
//   0. magic-link LOGIN (M2 #14)          → dev link → session cookie
//   1. POST a provider key                → 201 + masked key + servingEnabled:true
//   2. POST samples/workload.jsonl        → cluster breakdown, ≥4 clusters
//   3. GET frontiers for code-gen         → points exist
//   4. POST a max_quality policy          → 201 + fresh pk_ key
//   5. POST /v1/chat/completions          → 200 + x-frontier-trace header
//   6. GET /frontiers page HTML           → SSR chart + SIMULATED badges (M1a)
//   7. GET / page HTML                    → custody note, connect form ON by default (M2)
//   8–11. M4: playground, share links, budget hard stop, audit trail
//   12. M4b: mock research scan → cycles → /recipes SIMULATED → public
//       /leaderboard awaiting live verification. The scan's registry write
//       targets a tmp prices copy (POTION_PRICES_PATH), never the repo file.
//   13. M5: trace ingest (idempotent) → session rollup with LOOP badge →
//       waterfall → traces:cluster job → agent-* frontier → X-Potion-Cluster
//       chat → retention 0 purge redacts attrs. Synthesized replay suites
//       write derived suites to DB storage (G1.3) — the repo dir is never touched.
// Each step prints PASS + elapsed; the run prints a total and must finish
// well under 5 minutes (expected ~1 min).
//
// AUTH (M2 #14): the dashboard is session-gated, so the walkthrough signs in
// FIRST via the real magic-link flow (step 0) — the API server runs in dev
// mode (POTION_DEV_AUTH unset + NODE_ENV≠production), so request-link returns
// a devLink and no email server is needed. The session cookie then rides
// every dashboard call, exactly like a browser.
//
// Usage: pnpm --filter @potion/dashboard walkthrough
//   (requires `pnpm build` first — the walkthrough runs dist/ + .next/)
// Env: WALK_API_PORT (default 3100), WALK_DASH_PORT (default 3101).
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DASH_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const REPO_ROOT = path.resolve(DASH_DIR, '../..');
const API_PORT = Number(process.env.WALK_API_PORT ?? 3100);
const DASH_PORT = Number(process.env.WALK_DASH_PORT ?? 3101);
const API = `http://localhost:${API_PORT}`;
const DASH = `http://localhost:${DASH_PORT}`;

const t0 = Date.now();
const children: ChildProcess[] = [];
let failures = 0;

/** M4b #37: the research scan EXTENDS prices.json with newly discovered
 * models — point the server at a throwaway copy so the walkthrough never
 * mutates the repo file. */
let tmpPricesPath = '';

/** M5 #36: the traces:cluster worker SYNTHESIZES agent replay suites into the
 * suites v2 dir — point the server at a throwaway copy so the walkthrough
 * never mutates the repo suites. */

/** Session cookie acquired in step 0 (M2 #14) — rides every dashboard call. */
let sessionCookie = '';

/** fetch() against the dashboard with the session cookie attached. */
function dashFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${DASH}${path}`, {
    ...init,
    headers: { ...(sessionCookie ? { cookie: sessionCookie } : {}), ...(init?.headers ?? {}) },
  });
}

function elapsed(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)}s`;
}

function pass(name: string, since: number, detail = ''): void {
  console.log(`PASS  ${name}  (${elapsed(since)})${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, since: number, err: unknown): void {
  failures += 1;
  console.error(`FAIL  ${name}  (${elapsed(since)}) — ${err instanceof Error ? err.message : err}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  const t = Date.now();
  try {
    const detail = await fn();
    pass(name, t, detail ?? '');
  } catch (err) {
    fail(name, t, err);
  }
}

function boot(cmd: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.error(`  [${path.basename(cwd)}] ${line.split('\n')[0]}`);
  });
  children.push(child);
  return child;
}

async function waitFor(url: string, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} not ready after ${timeoutMs / 1000}s (${lastErr})`);
}

async function main(): Promise<void> {
  console.log('── Potion Gate 6: dashboard cold-start walkthrough ──────────────');
  console.log(`repo: ${REPO_ROOT}`);
  console.log(`api : ${API}   dashboard: ${DASH}`);

  // ---- boot both processes ----
  await step('boot api server (fresh PGlite → auto-seed)', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'potion-walk-'));
    tmpPricesPath = path.join(tmp, 'prices.json');
    await copyFile(path.join(REPO_ROOT, 'prices.json'), tmpPricesPath);
    // G1.3: derived suites live in db storage — the worker writes no files,
    // so the suites/v2 tmp copy that protected the repo dir is gone.
    boot('node', ['apps/server/dist/index.js'], REPO_ROOT, {
      PORT: String(API_PORT),
      POTION_PRICES_PATH: tmpPricesPath,
    });
    await waitFor(`${API}/healthz`, 120_000, 'api');
    const health = (await (await fetch(`${API}/healthz`)).json()) as { seeded?: boolean };
    return `healthz ok, seeded=${health.seeded}`;
  });

  await step('boot dashboard (next start, production build)', async () => {
    const nextBin = path.join(DASH_DIR, 'node_modules', '.bin', 'next');
    boot(nextBin, ['start', '-p', String(DASH_PORT)], DASH_DIR, {
      POTION_API_URL: API,
      PORT: String(DASH_PORT),
    });
    await waitFor(DASH, 60_000, 'dashboard');
  });

  // ---- 0. magic-link login (M2 #14): request → dev link → session cookie ----
  await step('0. magic-link login (demo@potion.dev → session cookie)', async () => {
    const rl = await fetch(`${API}/auth/request-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'demo@potion.dev' }),
    });
    const rlBody = (await rl.json()) as { ok?: boolean; devLink?: string };
    assert(rl.ok && rlBody.devLink, `no devLink (server dev mode off?): ${JSON.stringify(rlBody)}`);
    const verify = await fetch(rlBody.devLink!);
    const verifyBody = (await verify.json()) as { token?: string; session?: { orgId?: string } };
    assert(verify.ok && verifyBody.token, `verify failed: ${JSON.stringify(verifyBody)}`);
    assert(verify.headers.get('set-cookie')?.includes('potion_session='), 'no session cookie set');
    sessionCookie = `potion_session=${verifyBody.token}`;
    // the session authenticates an /api/* call; an anonymous one would 401
    // when the dev bypass is off (covered by the server auth tests)
    const me = await fetch(`${API}/auth/me`, { headers: { cookie: sessionCookie } });
    const meBody = (await me.json()) as { user?: { email?: string }; org?: { id?: string }; role?: string };
    assert(me.ok && meBody.user?.email === 'demo@potion.dev', `auth/me failed: ${JSON.stringify(meBody)}`);
    return `signed in as ${meBody.user?.email}, org=${meBody.org?.id}, role=${meBody.role}`;
  });

  // ---- 1. connect a key (through the dashboard proxy) ----
  await step('1. POST /api/keys (connect provider key)', async () => {
    const res = await dashFetch('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        apiKey: 'sk-ant-walkthrough-demo-key-0001',
        name: 'walkthrough key',
      }),
    });
    const body = await res.json();
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(body)}`);
    assert(typeof body.maskedKey === 'string' && body.maskedKey.includes('…'), 'no maskedKey');
    // BYOK custody (M2): a stored encrypted key is wired into serving immediately.
    assert(body.servingEnabled === true, `servingEnabled must be true, got ${body.servingEnabled}`);
    const list = (await (await dashFetch('/api/keys')).json()) as { keys: unknown[] };
    assert(list.keys.length >= 1, 'masked list empty');
    return `stored as ${body.maskedKey}, servingEnabled=true, list shows ${list.keys.length} key(s)`;
  });

  // ---- 2. upload the sample workload ----
  const jsonl = await readFile(path.join(DASH_DIR, 'samples', 'workload.jsonl'), 'utf8');
  await step('2. POST /api/workloads (sample workload.jsonl)', async () => {
    const res = await dashFetch('/api/workloads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonl }),
    });
    const body = await res.json();
    assert(res.ok, `HTTP ${res.status}: ${JSON.stringify(body)}`);
    const clusters = Object.keys(body.breakdown as Record<string, number>);
    assert(body.total === 40, `expected 40 prompts, got ${body.total}`);
    assert(clusters.length >= 4, `expected ≥4 clusters, got ${clusters.length}`);
    return `${body.total} prompts → ${clusters.length} clusters: ${JSON.stringify(body.breakdown)}`;
  });

  // ---- 3. frontiers for code-gen ----
  await step('3. GET /api/frontiers/code-gen (points exist)', async () => {
    const listRes = await dashFetch('/api/frontiers');
    const list = await listRes.json();
    assert(listRes.ok && Array.isArray(list.clusters), 'frontier list failed');
    const ids = (list.clusters as Array<{ clusterId: string }>).map((c) => c.clusterId);
    assert(ids.includes('code-gen'), `code-gen missing from ${JSON.stringify(ids)}`);
    const res = await dashFetch('/api/frontiers/code-gen');
    const body = await res.json();
    assert(res.ok, `HTTP ${res.status}`);
    assert(body.frontier.points.length > 0, 'frontier has no points');
    return `v${body.frontier.version}, ${body.frontier.points.length} points, ` +
      `operatingPoint=${body.operatingPoint ? 'yes' : 'no'}; clusters: ${ids.join(', ')}`;
  });

  // ---- 4. create a max_quality policy (+ fresh key) ----
  let apiKey = '';
  await step('4. POST /api/policies (max_quality, $2 ceiling)', async () => {
    const res = await dashFetch('/api/policies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        policy: { type: 'max_quality', costCeilingPer1K: 2.0 },
        name: 'walkthrough-max-quality',
        createKey: true,
      }),
    });
    const body = await res.json();
    assert(res.status === 201, `expected 201, got ${res.status}: ${JSON.stringify(body)}`);
    assert(typeof body.apiKey === 'string' && body.apiKey.startsWith('pk_'), 'no apiKey');
    apiKey = body.apiKey;
    return `policy ${body.policy.id}, key ${apiKey.slice(0, 10)}…`;
  });

  // ---- 5. chat completions through the platform ----
  await step('5. POST /v1/chat/completions (200 + x-frontier-trace)', async () => {
    const res = await fetch(`${API}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'potion-auto',
        messages: [{ role: 'user', content: 'Write a python function that reverses a string' }],
      }),
    });
    const trace = res.headers.get('x-frontier-trace');
    const body = await res.json();
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert(trace, 'missing x-frontier-trace header');
    assert(body.choices?.[0]?.message?.content, 'no completion content');
    return `trace: ${trace}`;
  });

  // ---- 6. /frontiers page HTML — SSR chart evidence ----
  await step('6. GET /frontiers (page HTML renders chart)', async () => {
    const res = await dashFetch('/frontiers?cluster=code-gen');
    const html = await res.text();
    assert(res.ok, `HTTP ${res.status}`);
    assert(html.includes('Only points on the line are worth paying for'), 'caption missing');
    assert(html.includes('<svg'), 'no SSR <svg> chart found');
    assert(html.includes('You are here'), '"You are here" marker missing');
    assert(html.includes('excellent') && html.includes('poor'), 'quality ticks missing');
    // Provenance badges (M1a): the seed frontiers are mock-measured, so the
    // page must badge SIMULATED (cluster summary + per-point rows) and never
    // present the points as LIVE.
    assert(html.includes('SIMULATED'), 'SIMULATED provenance badge missing');
    assert(
      html.includes('provenance') || html.includes('measured on mock providers'),
      'cluster provenance summary missing',
    );
    const circles = (html.match(/<circle/g) ?? []).length;
    const badges = (html.match(/SIMULATED/g) ?? []).length;
    return `${(html.length / 1024).toFixed(0)}KB html, ${circles} <circle> nodes, caption + ticks + marker present, ${badges} SIMULATED badges`;
  });

  // ---- 7. BYOK custody (M2): custody note + self-serve form ON by default ----
  await step('7. GET / (custody note, connect form ON by default)', async () => {
    const res = await dashFetch('/');
    const html = await res.text();
    assert(res.ok, `HTTP ${res.status}`);
    assert(html.includes('encrypted at rest'), 'custody note missing');
    // The M1a honesty banner and flag gate are gone — custody shipped.
    assert(
      !html.includes('Keys are stored masked and used for validation only'),
      'M1a honesty banner should be gone',
    );
    // Flag default ON: self-serve form rendered, no contact-us fallback.
    assert(html.includes('Connect key</button>'), 'key form should be ON by default');
    assert(!html.includes('NEXT_PUBLIC_BYOK_ENABLED=false'), 'opt-out note should be absent');
    return 'custody note + form present, M1a banner gone (NEXT_PUBLIC_BYOK_ENABLED unset)';
  });

  // ---- 8. M4 #31: /playground renders the chat surface ----
  await step('8. GET /playground (M4: chat surface + point selector)', async () => {
    const res = await dashFetch('/playground?cluster=code-gen');
    const html = await res.text();
    assert(res.ok, `HTTP ${res.status}`);
    assert(html.includes('Playground'), 'page title missing');
    assert(html.includes('potion-auto'), 'potion-auto option missing');
    assert(html.includes('code-gen'), 'cluster pill missing');
    assert(html.includes('Compare two points'), 'compare toggle missing');
    assert(html.includes('SIMULATED'), 'SIMULATED point badge missing (mock seed)');
    return 'chat surface + potion-auto + compare toggle + SIMULATED badges present';
  });

  // ---- 9. M4 #31: share link mint → public page (session-free) → revoke ----
  await step('9. POST /api/share → public /share/f page (no session) → revoke', async () => {
    const mint = await dashFetch('/api/share', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'frontier', clusterId: 'code-gen' }),
    });
    const minted = await mint.json();
    assert(mint.status === 201, `mint → HTTP ${mint.status}: ${JSON.stringify(minted)}`);
    assert(minted.token?.startsWith('st_'), 'raw token missing at mint');
    // Public page WITHOUT the session cookie (fresh fetch — no jar).
    const pub = await fetch(`${DASH}${minted.url}`);
    const html = await pub.text();
    assert(pub.ok, `public page → HTTP ${pub.status}`);
    assert(html.includes('Shared read-only'), 'shared banner missing');
    assert(html.includes('<svg'), 'no SSR <svg> chart on public page');
    assert(html.includes('SIMULATED'), 'SIMULATED badge missing on public page');
    // Revoke → the same page 404s.
    const revoke = await dashFetch(`/api/share/${minted.id}/revoke`, { method: 'POST' });
    assert(revoke.ok, `revoke → HTTP ${revoke.status}`);
    const after = await fetch(`${DASH}${minted.url}`);
    assert(after.status === 404, `revoked link should 404, got ${after.status}`);
    return `minted ${minted.url}, public SSR verified session-free, revoke → 404`;
  });

  // ---- 10. M4 #35: budget hard stop 429s serving, then disarms ----
  await step('10. budget autopilot (PUT hard stop → chat 429 → disarm)', async () => {
    const put = await dashFetch('/api/budgets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monthlyCapUsd: 0.000001, hardStop: true }),
    });
    assert(put.ok, `PUT budget → HTTP ${put.status}`);
    const blocked = await fetch(`${API}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'potion-auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const blockedBody = await blocked.json();
    assert(blocked.status === 429, `expected 429, got ${blocked.status}: ${JSON.stringify(blockedBody)}`);
    assert(blockedBody.error?.type === 'budget_exceeded', 'budget_exceeded type missing');
    const state = await (await dashFetch('/api/budgets')).json();
    assert(state.state === 'exceeded', `expected state=exceeded, got ${state.state}`);
    // Disarm → serving resumes immediately (cache busted on write).
    const disarm = await dashFetch('/api/budgets', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monthlyCapUsd: 1000000, hardStop: false }),
    });
    assert(disarm.ok, `disarm → HTTP ${disarm.status}`);
    const open = await fetch(`${API}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'potion-auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert(open.status === 200, `expected 200 after disarm, got ${open.status}`);
    return 'hard stop 429 budget_exceeded → state=exceeded → disarm serves 200 immediately';
  });

  // ---- 11. M4 #34: /settings/audit renders the unified trail (admin) ----
  await step('11. GET /settings/audit (M4: unified trail renders)', async () => {
    const res = await dashFetch('/settings/audit');
    const html = await res.text();
    assert(res.ok, `HTTP ${res.status}`);
    assert(html.includes('Audit trail'), 'page title missing');
    assert(html.includes('Export JSONL'), 'export form missing');
    assert(html.includes('Recent events'), 'events section missing');
    // The walkthrough itself generated auth (login) + custody (key connect)
    // events — at least one must be visible.
    assert(html.includes('auth.login') || html.includes('custody.'), 'no audit events rendered');
    return 'trail renders with auth/custody events + export form';
  });

  // ---- 12. M4b #37/#32: scan → cycles → recipe library → public leaderboard ----
  await step('12. research scan → cycles complete → /recipes SIMULATED → /leaderboard awaiting', async () => {
    // Trigger a MOCK scan (deterministic — never touches live OpenRouter,
    // regardless of the ambient env). The server writes discovered models to
    // the TMP prices copy (POTION_PRICES_PATH), never the repo file.
    const scan = await dashFetch('/api/research/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'mock' }),
    });
    const scanBody = await scan.json();
    assert(scan.status === 202, `scan → HTTP ${scan.status}: ${JSON.stringify(scanBody)}`);
    // Scan job → completed (the in-process worker runs the real handler).
    const jobDeadline = Date.now() + 120_000;
    for (;;) {
      const job = await (
        await fetch(`${API}/api/jobs/${scanBody.jobId}`, {
          headers: { authorization: `Bearer ${apiKey}` },
        })
      ).json();
      if (job.state === 'completed') break;
      assert(job.state !== 'failed', `scan job failed: ${job.error ?? 'unknown'}`);
      assert(Date.now() < jobDeadline, 'scan job did not complete in 120s');
      await new Promise((r) => setTimeout(r, 1000));
    }
    // The scan enqueued research:cycle jobs per discovered alias — wait for
    // every scan-triggered cycle to complete (ledger rows).
    const cycleDeadline = Date.now() + 180_000;
    let cycles: Array<{ status: string; trigger: string }> = [];
    for (;;) {
      const body = await (
        await fetch(`${API}/api/research/cycles`, {
          headers: { authorization: `Bearer ${apiKey}` },
        })
      ).json();
      cycles = (body.cycles ?? []).filter((c: { trigger: string }) => c.trigger === 'scan');
      if (cycles.length >= 1 && cycles.every((c) => c.status === 'completed' || c.status === 'failed'))
        break;
      assert(Date.now() < cycleDeadline, 'research cycles did not settle in 180s');
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert(
      cycles.every((c) => c.status === 'completed'),
      `cycle(s) failed: ${JSON.stringify(cycles)}`,
    );
    // The tmp registry now carries the mock-discovered models (repo file untouched).
    const extended = await readFile(tmpPricesPath, 'utf8');
    assert(extended.includes('mock-nova-1'), 'tmp prices.json missing scanned model mock-nova-1');
    // /recipes: the library renders candidates badged SIMULATED with lineage.
    const recipes = await dashFetch('/recipes');
    const html = await recipes.text();
    assert(recipes.ok, `/recipes → HTTP ${recipes.status}`);
    assert(html.includes('Recipe library'), 'recipes page title missing');
    assert(html.includes('candidate'), 'candidate status badge missing');
    assert(html.includes('SIMULATED'), 'SIMULATED provenance badge missing');
    assert(html.includes('lineage'), 'lineage drawer missing');
    // /leaderboard: PUBLIC (no session cookie) and honest — mock evidence
    // never appears, so pre-M1b it awaits live verification.
    const lb = await fetch(`${DASH}/leaderboard`);
    const lbHtml = await lb.text();
    assert(lb.ok, `/leaderboard (no session) → HTTP ${lb.status}`);
    assert(lbHtml.includes('Awaiting live verification'), 'honest empty state missing');
    return `${cycles.length} scan cycle(s) completed, library renders SIMULATED candidates, public leaderboard awaits live evidence`;
  });

  // ---- 13. M5 #36: traces — ingest → rollup/loops → waterfall → cluster → hint → purge ----
  await step('13. traces e2e (ingest idempotent → LOOP rollup → cluster frontier → retention purge)', async () => {
    // Two sessions: one normal agent run, one stuck in a tool-call loop
    // (same signature ≥3×). Spans carry a priced model + token usage.
    const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
    const toolAttrs = {
      'gen_ai.operation.name': 'execute_tool',
      'tool.name': 'search',
      'tool.args': { q: 'invoice 4421' },
    };
    const batch = {
      spans: [
        {
          trace_id: 'wt-trace-normal',
          span_id: 'n_root',
          name: 'agent.run',
          attributes: { 'gen_ai.prompt': 'Check invoice 4421 status and email the customer' },
          ts: at(0),
        },
        {
          trace_id: 'wt-trace-normal',
          span_id: 'n_tool',
          parent_id: 'n_root',
          name: 'tool.search',
          attributes: toolAttrs,
          ts: at(1),
        },
        {
          trace_id: 'wt-trace-normal',
          span_id: 'n_chat',
          parent_id: 'n_root',
          name: 'chat',
          model: 'haiku-class',
          input_tokens: 1000,
          output_tokens: 1000,
          ts: at(2),
        },
        {
          trace_id: 'wt-trace-loop',
          span_id: 'l_root',
          name: 'agent.run',
          attributes: { 'gen_ai.prompt': 'Refund the duplicate charge on invoice 9982' },
          ts: at(3),
        },
        ...[0, 1, 2].map((i) => ({
          trace_id: 'wt-trace-loop',
          span_id: `l_tool_${i}`,
          parent_id: 'l_root',
          name: 'tool.search',
          attributes: toolAttrs,
          ts: at(4 + i),
        })),
      ],
    };
    const postBatch = () =>
      fetch(`${API}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(batch),
      });
    const ing = await postBatch();
    const ingBody = await ing.json();
    assert(ing.status === 202, `ingest → HTTP ${ing.status}: ${JSON.stringify(ingBody)}`);
    assert(ingBody.accepted === 7, `expected 7 accepted, got ${ingBody.accepted}`);
    assert(ingBody.costUsd > 0, 'ingest-time pricing missing');
    // Idempotent retry: the same batch is duplicates, never double-counted.
    const retry = await postBatch();
    const retryBody = await retry.json();
    assert(
      retry.status === 202 && retryBody.accepted === 0 && retryBody.duplicates === 7,
      `idempotent retry failed: ${JSON.stringify(retryBody)}`,
    );
    // Rollup: the loop trace is flagged; the normal one is priced.
    const roll = await (await dashFetch('/api/traces')).json();
    const sessions = roll.sessions as Array<{
      traceId: string;
      looping: boolean;
      loops: Array<{ signature: string; count: number }>;
      totalCostUsd: number;
    }>;
    const loopS = sessions.find((s) => s.traceId === 'wt-trace-loop');
    const normalS = sessions.find((s) => s.traceId === 'wt-trace-normal');
    assert(loopS?.looping === true && loopS.loops.length >= 1, 'loop signal missing from rollup');
    assert(normalS && !normalS.looping && normalS.totalCostUsd > 0, 'normal session rollup wrong');
    // Waterfall for the normal trace: 3 spans, parent linkage, per-span cost.
    const wfRes = await dashFetch('/api/traces/wt-trace-normal');
    const wf = await wfRes.json();
    assert(wfRes.ok && wf.spans.length === 3, `waterfall wrong: ${JSON.stringify(wf)}`);
    const chatSpan = (wf.spans as Array<{ name: string; costUsd: number }>).find(
      (s) => s.name === 'chat',
    );
    assert(chatSpan && chatSpan.costUsd > 0, 'chat span not priced');
    // The dashboard page renders the rollup with the LOOP badge.
    const page = await dashFetch('/traces');
    const pageHtml = await page.text();
    assert(page.ok && pageHtml.includes('Traces'), `/traces → HTTP ${page.status}`);
    assert(pageHtml.includes('LOOP'), 'LOOP badge missing from /traces');
    // Cluster (admin): redact → embed → agent clusters + replay suites + frontier.
    const cl = await dashFetch('/api/traces/cluster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const clBody = await cl.json();
    assert(cl.status === 202, `cluster → HTTP ${cl.status}: ${JSON.stringify(clBody)}`);
    const clDeadline = Date.now() + 240_000;
    let clResult: { sessionsSeen?: number; clustersCreated?: number } = {};
    for (;;) {
      const job = await (
        await fetch(`${API}/api/jobs/${clBody.jobId}`, {
          headers: { authorization: `Bearer ${apiKey}` },
        })
      ).json();
      if (job.state === 'completed') {
        clResult = job.result ?? {};
        break;
      }
      assert(job.state !== 'failed', `cluster job failed: ${job.error ?? 'unknown'}`);
      assert(Date.now() < clDeadline, 'cluster job did not complete in 240s');
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert(
      (clResult.sessionsSeen ?? 0) >= 2 && (clResult.clustersCreated ?? 0) >= 1,
      `cluster result wrong: ${JSON.stringify(clResult)}`,
    );
    // The agent cluster has a frontier and serves explicit traffic via the hint.
    const fl = await (await dashFetch('/api/frontiers')).json();
    const agentCluster = (fl.clusters as Array<{ clusterId: string }>).find((c) =>
      c.clusterId.startsWith('agent-'),
    );
    assert(agentCluster, `no agent-* cluster in /api/frontiers: ${JSON.stringify(fl.clusters)}`);
    const hinted = await fetch(`${API}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'x-potion-cluster': agentCluster.clusterId,
      },
      body: JSON.stringify({
        model: 'potion-auto',
        messages: [{ role: 'user', content: 'Check invoice 4421 status' }],
      }),
    });
    const hintedBody = await hinted.json();
    assert(hinted.status === 200, `hinted chat → HTTP ${hinted.status}: ${JSON.stringify(hintedBody)}`);
    assert(
      hinted.headers.get('x-frontier-trace')?.includes(`cluster=${agentCluster.clusterId}`),
      `hint not honored: ${hinted.headers.get('x-frontier-trace')}`,
    );
    // Retention 0 + purge: prompts/attrs redacted, metadata kept (idempotent).
    const put = await dashFetch('/api/traces/retention', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ days: 0 }),
    });
    assert(put.ok, `retention PUT → HTTP ${put.status}`);
    const purge = await dashFetch('/api/traces/purge', { method: 'POST' });
    const purgeBody = await purge.json();
    assert(purge.status === 202, `purge → HTTP ${purge.status}: ${JSON.stringify(purgeBody)}`);
    const purgeDeadline = Date.now() + 60_000;
    for (;;) {
      const job = await (
        await fetch(`${API}/api/jobs/${purgeBody.jobId}`, {
          headers: { authorization: `Bearer ${apiKey}` },
        })
      ).json();
      if (job.state === 'completed') break;
      assert(job.state !== 'failed', `purge job failed: ${job.error ?? 'unknown'}`);
      assert(Date.now() < purgeDeadline, 'purge job did not complete in 60s');
      await new Promise((r) => setTimeout(r, 1000));
    }
    const wf2 = await (await dashFetch('/api/traces/wt-trace-normal')).json();
    assert(
      (wf2.spans as Array<{ attrs: Record<string, unknown> }>).every(
        (s) => Object.keys(s.attrs).length === 0,
      ),
      'purge did not redact span attrs',
    );
    // Restore the default so re-runs start clean.
    await dashFetch('/api/traces/retention', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ days: 30 }),
    });
    return `7 spans ingested idempotently, loop flagged, ${clResult.clustersCreated} agent cluster(s) → frontier ${agentCluster.clusterId}, hint honored, purge redacted attrs`;
  });

  const total = elapsed(t0);
  console.log('────────────────────────────────────────────────────────────────');
  console.log(
    failures === 0
      ? `── Gate 6 walkthrough OK — total ${total} (budget 5 min) ──`
      : `── Gate 6 walkthrough: ${failures} step(s) FAILED — total ${total} ──`,
  );
}

main()
  .catch((e) => {
    failures += 1;
    console.error('walkthrough crashed:', e);
  })
  .finally(() => {
    for (const c of children) {
      try {
        c.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
    // give children a moment to exit, then force-quit
    setTimeout(() => process.exit(failures === 0 ? 0 : 1), 1000).unref();
  });
