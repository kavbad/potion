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
//   7b. GET / page HTML                   → S1 connect surface: endpoint, the
//       policy in plain language, and the routing proof reporting a NON-ZERO
//       routed count for the request step 5 actually sent
//   7c. POST /api/plan                    → S2 from-scratch door: an idea
//       classified to a workload type, alternatives visible, and three policy
//       shapes each either resolving to a MEASURED point or stating why not
//   8–11. M4: try-a-request, share links, budget hard stop, audit trail
//   12. M4b: mock research scan → cycles → registry in db. The scan's registry write
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
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
const OPERATOR_TOKEN = 'op_walkthrough_token';

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
      // G2.7: the operator credential for step 14 (fail-closed — without it
      // the operator surface does not exist).
      POTION_OPERATOR_TOKEN: OPERATOR_TOKEN,
      // G2.4: the demo credential is gated OFF by default (operator-only
      // posture); the walkthrough opts in EXPLICITLY, like every other
      // dev-scoped affordance.
      POTION_SEED_DEMO: '1',
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
  // ---- 7. (retired) the BYOK provider-key page ----
  // BYOK is no longer offered (operator, 2026-08-17), so /settings/provider-keys
  // is gone and this leg with it. Step 1 still registers a provider key over the
  // API: the custody machinery stays and stays tested, because the Lab's MCP
  // OAuth grants depend on it. It is simply not a customer-facing surface.


  // ---- 7b. SERVING-ROADMAP S1: the connect surface is now the front door ----
  // The DoD of S1 in one step: a signed-in org lands on `/` and finds where
  // to point traffic, what rule applies, and whether routing actually
  // happened — WITHOUT being told any of it. Step 5 already sent a chat
  // request through this org's key, so the proof half has something real to
  // report; asserting the routed count here is what stops the panel from
  // being decoration that renders the same either way.
  await step('7b. GET / (connect: endpoint, policy in words, routing proof)', async () => {
    const res = await dashFetch('/');
    const html = await res.text();
    assert(res.ok, `HTTP ${res.status}`);
    // S2: the routing state's hero is the kept counter (TodayPulse); the
    // connect state keeps its onboarding heading. Either is a healthy '/'.
    assert(
      /(Get routed in a minute|kept so far|kept this month)/.test(html),
      'front-door hero missing (neither connect heading nor the kept counter)',
    );
    assert(html.includes(`${API}/v1`), `base url ${API}/v1 not offered`);
    assert(html.includes('Base URL'), 'base url block missing');

    // And the routing evidence, read through the same API the panel uses.
    const activity = await dashFetch('/api/routing-activity?limit=25');
    assert(activity.ok, `routing-activity HTTP ${activity.status}`);
    const body = (await activity.json()) as {
      summary: { routed: number; withRoutingDecision: number; defaulted: number };
    };
    assert(
      body.summary.withRoutingDecision > 0,
      'no request carried a routing decision — step 5 should have produced one',
    );
    assert(
      body.summary.routed > 0,
      `every request DEFAULTED (routed=0 of ${body.summary.withRoutingDecision}) — the auto-switch did nothing`,
    );
    return (
      `endpoint + plain-language policy rendered; ` +
      `${body.summary.routed}/${body.summary.withRoutingDecision} recent requests routed, ` +
      `${body.summary.defaulted} defaulted`
    );
  });

  // ---- 7c. SERVING-ROADMAP S2: the from-scratch door ----
  // Someone with an idea and no workload. The whole point is that this
  // answers with MEASURED evidence rather than a guess, so the leg asserts
  // the classification, the basis field, that the alternatives are visible,
  // and that at least one option resolves to a real strategy. A plan that
  // came back with three empty options would pass a mere 200-check.
  await step('7c. POST /api/plan (S2: idea → workload type → measured options)', async () => {
    const res = await dashFetch('/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'Write and repair Python functions from plain english instructions',
      }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const plan = (await res.json()) as {
      intent: {
        cluster: { clusterId: string; name: string };
        margin: number;
        alternatives: Array<{ clusterId: string }>;
      };
      evidence: { measured: boolean; pointCount: number; provenance: string };
      options: Array<{ priority: string; point: { strategy: string; quality: number } | null; infeasible: string | null }>;
      basis: string;
    };
    assert(plan.intent.cluster.clusterId === 'code-gen', `classified as ${plan.intent.cluster.clusterId}`);
    // The basis must be NAMED — these are platform numbers, not the caller's.
    assert(plan.basis === 'platform-measured', `basis=${plan.basis}`);
    assert(plan.evidence.measured && plan.evidence.pointCount > 0, 'no measured evidence behind the plan');
    // Alternatives visible, and never containing the pick itself.
    assert(plan.intent.alternatives.length > 0, 'no alternatives surfaced');
    assert(
      !plan.intent.alternatives.some((a) => a.clusterId === plan.intent.cluster.clusterId),
      'the chosen cluster appears in its own alternatives',
    );
    // All three shapes present; each is either a real point or a stated reason.
    assert(plan.options.length === 3, `${plan.options.length} options, expected 3`);
    for (const o of plan.options) {
      assert(
        (o.point === null) !== (o.infeasible === null),
        `option ${o.priority} is neither feasible nor explained`,
      );
    }
    const feasible = plan.options.filter((o) => o.point !== null);
    assert(feasible.length > 0, 'every option came back infeasible');
    return (
      `${plan.intent.cluster.name} (margin ${plan.intent.margin.toFixed(3)}, ` +
      `${plan.intent.alternatives.length} alternatives shown); ` +
      `${feasible.length}/3 options feasible on ${plan.evidence.pointCount} ${plan.evidence.provenance} points; ` +
      `best-quality → ${feasible[0]!.point!.strategy}`
    );
  });

  // ---- 7d. the shell: collapsed nav, API keys with SCOPES, docs ----
  // The nav used to be 13 flat links shown to signed-out visitors too. And
  // `serve+admin` existed in the API with no supported way to obtain one, so
  // nothing programmatic could get past a 403 — this asserts the affordance
  // that closes it, not just that a page renders.
  await step('7d. shell: /settings/keys mints serve+admin, /docs renders', async () => {
    const keysPage = await dashFetch('/settings/keys');
    assert(keysPage.ok, `keys page HTTP ${keysPage.status}`);
    const keysHtml = await keysPage.text();
    assert(keysHtml.includes('Admin token'), 'no admin-scope affordance on the keys page');

    const made = await dashFetch('/api/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'walkthrough-admin', scopes: 'serve+admin' }),
    });
    assert(made.status === 201, `mint serve+admin HTTP ${made.status}`);
    const listed = (await (await dashFetch('/api/api-keys')).json()) as {
      keys: Array<{ name: string; scopes: string | null }>;
    };
    const admin = listed.keys.find((k) => k.name === 'walkthrough-admin');
    assert(admin?.scopes === 'serve+admin', `scope not honoured: ${String(admin?.scopes)}`);

    const docs = await dashFetch('/docs');
    const docsHtml = await docs.text();
    assert(docs.ok, `docs HTTP ${docs.status}`);
    // A quickstart missing its examples is the one hole docs must not have —
    // and a brand-new reader has no bound policy to personalise them from.
    assert(docsHtml.includes('Quickstart'), 'docs missing quickstart');
    assert(docsHtml.includes('chat/completions'), 'docs quickstart has no curl example');
    assert(docsHtml.includes('openai'), 'docs quickstart has no SDK example');
    return 'keys page mints serve+admin; docs render quickstart + curl + SDK';
  });

  // ---- 8. /try renders the ad-hoc request surface (replaced /playground,
  // surface review 2026-08-24) ----
  await step('8. GET /try (ad-hoc request through the real routing path)', async () => {
    const res = await dashFetch('/try');
    const html = await res.text();
    assert(res.ok, `HTTP ${res.status}`);
    assert(html.toLowerCase().includes('try'), 'page title missing');
    return 'try-a-request surface renders';
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
  await step('10. budget autopilot (PUT hard stop → EVERY serving route 429s → disarm)', async () => {
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
    // F6: the hard stop must bind on EVERY serving route. This leg used to
    // assert chat only — and would have passed with /v1/completions and
    // /v1/embeddings wide open, which is exactly how they shipped unguarded.
    const legacyBlocked = await fetch(`${API}/v1/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'potion-auto', prompt: 'hi' }),
    });
    const legacyBody = await legacyBlocked.json();
    assert(
      legacyBlocked.status === 429 && legacyBody.error?.type === 'budget_exceeded',
      `/v1/completions must refuse under a hard cap, got ${legacyBlocked.status}: ${JSON.stringify(legacyBody)}`,
    );
    const embedBlocked = await fetch(`${API}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: 'hi' }),
    });
    assert(
      embedBlocked.status === 429,
      `/v1/embeddings must refuse under a hard cap, got ${embedBlocked.status}`,
    );
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
    return 'hard stop 429 budget_exceeded on chat + /v1/completions + /v1/embeddings → state=exceeded → disarm serves 200 immediately';
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
    // The registry now carries the mock-discovered models — and the FILE does
    // not, which is the point. S5 moved the catalog into the database: a scan
    // used to writeFileSync into prices.json, so every discovery died on the
    // next redeploy (the file ships inside the container image) and never
    // reached the running process anyway (loadPrices runs once at boot).
    const listed = await fetch(`${API}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const catalogue = ((await listed.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
    assert(
      catalogue.some((id) => id.includes('mock-nova-1')),
      `registry missing scanned model mock-nova-1 (catalogue: ${catalogue.join(', ')})`,
    );
    const onDisk = await readFile(tmpPricesPath, 'utf8');
    assert(
      !onDisk.includes('mock-nova-1'),
      'prices.json was written — the catalog must live in the db, or it dies on redeploy',
    );
    // The /recipes and /leaderboard pages were retired in the 2026-08-24
    // surface review; the scan → cycles → db-registry chain above is the
    // durable claim and keeps its teeth at the API level.
    return `${cycles.length} scan cycle(s) completed, registry in db, prices.json untouched`;
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
      'tool.result': 'invoice 4421: pending, due Friday',
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
        // Converter-v2 layout (post-capstone item 2): one llm.call span per
        // text-producing model call, per-call usage + step index. Step-level
        // synthesis pairs each completion with the context that call saw.
        {
          trace_id: 'wt-trace-normal',
          span_id: 'n_s1',
          parent_id: 'n_root',
          name: 'llm.call',
          model: 'haiku-class',
          input_tokens: 400,
          output_tokens: 300,
          attributes: {
            'gen_ai.operation.name': 'llm_call',
            'gen_ai.completion': 'Looking up invoice 4421 before emailing.',
            'potion.step_index': 1,
          },
          ts: at(1),
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
          span_id: 'n_s2',
          parent_id: 'n_root',
          name: 'llm.call',
          model: 'haiku-class',
          input_tokens: 600,
          output_tokens: 700,
          attributes: {
            'gen_ai.operation.name': 'llm_call',
            'gen_ai.completion': 'Invoice 4421 is pending; emailed the customer.',
            'potion.step_index': 2,
          },
          ts: at(2),
        },
        {
          trace_id: 'wt-trace-normal',
          span_id: 'n_chat',
          parent_id: 'n_root',
          name: 'chat',
          model: 'haiku-class',
          input_tokens: 1000,
          output_tokens: 1000,
          // G1.4: the session's final answer — becomes the replay reference.
          attributes: { 'gen_ai.completion': 'Invoice 4421 is pending; emailed the customer.' },
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
    assert(ingBody.accepted === 9, `expected 9 accepted, got ${ingBody.accepted}`);
    assert(ingBody.costUsd > 0, 'ingest-time pricing missing');
    // Idempotent retry: the same batch is duplicates, never double-counted.
    const retry = await postBatch();
    const retryBody = await retry.json();
    assert(
      retry.status === 202 && retryBody.accepted === 0 && retryBody.duplicates === 9,
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
    // Waterfall for the normal trace: 5 spans (root + 2 llm.call + tool +
    // chat, converter-v2 layout), parent linkage, per-span cost.
    const wfRes = await dashFetch('/api/traces/wt-trace-normal');
    const wf = await wfRes.json();
    assert(wfRes.ok && wf.spans.length === 5, `waterfall wrong: ${JSON.stringify(wf)}`);
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
    let clResult: {
      sessionsSeen?: number;
      clustersCreated?: number;
      clusters?: Array<{ clusterId: string; suiteId: string; itemsAdded: number }>;
    } = {};
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
    // Post-capstone item 2: the converter-v2 session (llm.call spans) must
    // synthesize a STEP-LEVEL suite (-replays-v2, one item per model call),
    // while the loop trace (no llm.call spans) stays session-level.
    const stepSuite = (clResult.clusters ?? []).find((c) => c.suiteId.endsWith('-replays-v2'));
    assert(
      stepSuite !== undefined && stepSuite.itemsAdded >= 2,
      `step-level suite missing from cluster outcomes: ${JSON.stringify(clResult.clusters)}`,
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
    // G1.5: rubric generation (mock, capped, metered) → customer-visible
    // DRAFT with calibration evidence → approve puts it IN FORCE and
    // restamps the suite's items.
    const rubGen = await fetch(`${API}/api/rubrics/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ clusterId: agentCluster.clusterId }),
    });
    const rubGenBody = await rubGen.json();
    assert(rubGen.status === 202, `rubric generate → HTTP ${rubGen.status}: ${JSON.stringify(rubGenBody)}`);
    const rubDeadline = Date.now() + 120_000;
    let rubResult: { rubricId?: string; providerMode?: string } = {};
    for (;;) {
      const job = await (
        await fetch(`${API}/api/jobs/${rubGenBody.jobId}`, {
          headers: { authorization: `Bearer ${apiKey}` },
        })
      ).json();
      if (job.state === 'completed') {
        rubResult = job.result ?? {};
        break;
      }
      assert(job.state !== 'failed', `rubric job failed: ${job.error ?? 'unknown'}`);
      assert(Date.now() < rubDeadline, 'rubric job did not complete in 120s');
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert(rubResult.rubricId !== undefined, `rubric result missing id: ${JSON.stringify(rubResult)}`);
    assert(rubResult.providerMode === 'mock', 'rubric provenance must say mock in the mock world');
    const rubList = await (await fetch(`${API}/api/rubrics`, { headers: { cookie: sessionCookie } })).json();
    const draft = (rubList.rubrics as Array<{ id: string; status: string; inForce: boolean; rubricText: string }>).find(
      (r) => r.id === rubResult.rubricId,
    );
    assert(draft !== undefined && draft.status === 'pending' && draft.inForce === false, 'draft must list as NOT in force');
    const approve = await fetch(`${API}/api/rubrics/${rubResult.rubricId}/approve`, { method: 'POST', headers: { cookie: sessionCookie } });
    const approveBody = await approve.json();
    assert(approve.ok && approveBody.restampedItems >= 1, `approve → HTTP ${approve.status}: ${JSON.stringify(approveBody)}`);
    // (The /rubrics review page retired in the 2026-08-24 surface review;
    // the in-force state is asserted through the API above.)
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
    return `9 spans ingested idempotently, loop flagged, ${clResult.clustersCreated} agent cluster(s) incl. step-level suite ${stepSuite.suiteId} → frontier ${agentCluster.clusterId}, hint honored, purge redacted attrs`;
  });

  // ---- 14. G2.7: operator create → full pipeline → TRUE-CASCADE delete →
  // NOTHING DERIVED SURVIVES (the owner's done criterion) ----
  await step('14. operator org lifecycle (create → pipeline → delete → nothing derived survives AT FIXTURE SCALE)', async () => {
    const OP = { authorization: `Bearer ${OPERATOR_TOKEN}` };
    const OPJ = { ...OP, 'content-type': 'application/json' };
    const savedCookie = sessionCookie; // demo org cookie — restored at the end
    try {
      // operator creates the org; the magic link comes back unconditionally
      const create = await fetch(`${API}/operator/orgs`, {
        method: 'POST',
        headers: OPJ,
        body: JSON.stringify({ id: 'org-walk14', name: 'Walkthrough Partner', adminEmail: 'partner@walk14.dev' }),
      });
      const created = await create.json();
      assert(create.status === 201, `operator create → HTTP ${create.status}: ${JSON.stringify(created)}`);
      assert(typeof created.magicLink === 'string', 'no magic link in operator create response');
      // hand-delivered link → new-org admin session
      const linkUrl = new URL(created.magicLink);
      const verify = await fetch(`${API}${linkUrl.pathname}${linkUrl.search}`, { redirect: 'manual' });
      const setCookie = verify.headers.get('set-cookie') ?? '';
      const tok = /potion_session=([^;]+)/.exec(setCookie)?.[1];
      assert(tok !== undefined, 'magic link did not mint a session');
      const partnerCookie = `potion_session=${tok}`;
      // policy + serving key in ONE call (the runbook's step 2)
      const pol = await fetch(`${API}/api/policies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: partnerCookie },
        body: JSON.stringify({ policy: { type: 'max_quality', costCeilingPer1K: 5 }, createKey: true }),
      });
      const polBody = await pol.json();
      assert(pol.ok && typeof polBody.apiKey === 'string', `policy+key → HTTP ${pol.status}: ${JSON.stringify(polBody)}`);
      const partnerKey = polBody.apiKey as string;
      // pipeline: ingest 3 sessions → cluster → rubric generate + approve
      for (const [t, p] of [
        ['wt14_a', 'Escalate the refund case for account 60001001'],
        ['wt14_b', 'Escalate the refund case for account 60001002'],
        ['wt14_c', 'Escalate the refund case for account 60001003'],
      ] as const) {
        const ing = await fetch(`${API}/v1/traces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${partnerKey}` },
          body: JSON.stringify({
            spans: [
              { trace_id: t, span_id: `${t}_r`, name: 'agent.root', model: 'mock-cheap', attributes: { 'gen_ai.prompt': p } },
              { trace_id: t, span_id: `${t}_t`, name: 'tool.crm', model: 'mock-cheap', attributes: { 'gen_ai.operation.name': 'execute_tool' } },
              { trace_id: t, span_id: `${t}_a`, name: 'chat', model: 'mock-cheap', attributes: { 'gen_ai.completion': `Refunded and closed ${t}.` } },
            ],
          }),
        });
        assert(ing.status === 202, `partner ingest → HTTP ${ing.status}`);
      }
      const clus = await fetch(`${API}/api/traces/cluster`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: partnerCookie },
        body: JSON.stringify({ sinceDays: 30 }),
      });
      const clusBody = await clus.json();
      assert(clus.status === 202, `partner cluster → HTTP ${clus.status}`);
      let clusResult: { clusters?: Array<{ clusterId: string }> } = {};
      for (let i = 0; i < 120; i++) {
        const job = await (await fetch(`${API}/api/jobs/${clusBody.jobId}`, { headers: { cookie: partnerCookie } })).json();
        if (job.state === 'completed') { clusResult = job.result ?? {}; break; }
        assert(job.state !== 'failed', `partner cluster job failed: ${job.error}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      const partnerCluster = clusResult.clusters?.[0]?.clusterId;
      assert(partnerCluster !== undefined, 'no partner cluster synthesized');
      const rub = await fetch(`${API}/api/rubrics/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: partnerCookie },
        body: JSON.stringify({ clusterId: partnerCluster }),
      });
      const rubBody = await rub.json();
      assert(rub.status === 202, `partner rubric → HTTP ${rub.status}`);
      let rubricId: string | undefined;
      for (let i = 0; i < 120; i++) {
        const job = await (await fetch(`${API}/api/jobs/${rubBody.jobId}`, { headers: { cookie: partnerCookie } })).json();
        if (job.state === 'completed') { rubricId = (job.result ?? {}).rubricId; break; }
        assert(job.state !== 'failed', `partner rubric job failed: ${job.error}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert(rubricId !== undefined, 'no rubric generated');
      const approve = await fetch(`${API}/api/rubrics/${rubricId}/approve`, {
        method: 'POST',
        headers: { cookie: partnerCookie },
      });
      assert(approve.ok, `rubric approve → HTTP ${approve.status}`);
      // artifacts EXIST before deletion
      const rubList = await (await fetch(`${API}/api/rubrics`, { headers: { cookie: partnerCookie } })).json();
      assert((rubList.rubrics ?? []).length >= 1, 'partner rubrics missing pre-delete');
      const traceList = await (await fetch(`${API}/api/traces`, { headers: { cookie: partnerCookie } })).json();
      assert((traceList.sessions ?? []).length === 3, 'partner traces missing pre-delete');

      // TRUE-CASCADE delete
      const del = await fetch(`${API}/operator/orgs/org-walk14`, { method: 'DELETE', headers: OP });
      const delBody = await del.json();
      assert(del.status === 202, `operator delete → HTTP ${del.status}: ${JSON.stringify(delBody)}`);
      let report: { deleted?: Record<string, number> } = {};
      for (let i = 0; i < 120; i++) {
        const job = await (await fetch(`${API}/operator/jobs/${delBody.jobId}`, { headers: OP })).json();
        if (job.state === 'completed') { report = job.result ?? {}; break; }
        assert(job.state !== 'failed', `org:delete failed: ${job.error}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert(report.deleted?.orgs === 1, `cascade report wrong: ${JSON.stringify(report)}`);

      // NOTHING DERIVED SURVIVES (HTTP surface)
      const deadSession = await fetch(`${API}/auth/me`, { headers: { cookie: partnerCookie } });
      assert(deadSession.status === 401, `deleted org session should 401, got ${deadSession.status}`);
      const deadKey = await fetch(`${API}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${partnerKey}` },
        body: JSON.stringify({ model: 'potion-auto', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert(deadKey.status === 401, `deleted org key should 401, got ${deadKey.status}`);
      const delAgain = await fetch(`${API}/operator/orgs/org-walk14`, { method: 'DELETE', headers: OP });
      assert(delAgain.status === 404, `repeat delete should 404, got ${delAgain.status}`);
      const opList = await (await fetch(`${API}/operator/orgs`, { headers: OP })).json();
      assert(!(opList.orgs ?? []).some((o: { id: string }) => o.id === 'org-walk14'), 'deleted org still listed');

      // platform intact (demo org unaffected)
      const platFrontier = await dashFetch('/api/frontiers/code-gen');
      assert(platFrontier.ok, `platform frontier → HTTP ${platFrontier.status}`);
      const lb = await fetch(`${API}/api/leaderboard`);
      assert(lb.ok, `leaderboard → HTTP ${lb.status}`);
      const demoTraces = await (await dashFetch('/api/traces')).json();
      assert((demoTraces.sessions ?? []).length >= 1, 'demo traces disturbed by cascade');

      const tables = Object.entries(report.deleted ?? {}).filter(([, n]) => (n as number) > 0).length;
      // CLAIM LANGUAGE, corrected 2026-08-10 (F17). This step runs on PGlite,
      // whose db.execute() returns no `rowCount`, so deleteOrgCascade's chunked
      // loop breaks after ONE chunk. The fixture is far under the 500-row chunk
      // size, so the deletion completes and the step passes — but it therefore
      // proves erasure only AT FIXTURE SCALE. It does NOT exercise the chunked
      // path, and must not be cited as proof that a real org's data is erased.
      // node-postgres does return rowCount, so production is expected to be
      // correct; "expected" is not "shown", and showing it needs a >500-row
      // offboarding drill against real Postgres.
      return `org created via operator → 3 traces → cluster → rubric approved → TRUE-CASCADE deleted (${tables} tables touched) → session+key dead, platform intact — FIXTURE SCALE ONLY (<1 chunk; the >500-row chunked path is unproven here, see F17)`;
    } finally {
      sessionCookie = savedCookie;
    }
  });


  await step('15. guarantee retention (designate incumbent → sampled traffic → suite-verify → report)', async () => {
    // G2.1 trust hierarchy, end to end on a fresh partner org: the incumbent
    // designation is the baseline of every verdict; the suite-verify verdict
    // is mock-LABELED (providerMode stamped — mock deployments never render
    // unlabeled trust evidence); the report headlines RETENTION with raw
    // scores demoted to drill-down.
    const OP = { authorization: `Bearer ${OPERATOR_TOKEN}` };
    const OPJ = { ...OP, 'content-type': 'application/json' };
    const savedCookie = sessionCookie;
    try {
      const create = await fetch(`${API}/operator/orgs`, {
        method: 'POST',
        headers: OPJ,
        body: JSON.stringify({ id: 'org-walk15', name: 'Retention Partner', adminEmail: 'partner@walk15.dev' }),
      });
      const created = await create.json();
      assert(create.status === 201, `operator create → HTTP ${create.status}`);
      const linkUrl = new URL(created.magicLink);
      const verify = await fetch(`${API}${linkUrl.pathname}${linkUrl.search}`, { redirect: 'manual' });
      const tok = /potion_session=([^;]+)/.exec(verify.headers.get('set-cookie') ?? '')?.[1];
      assert(tok !== undefined, 'magic link did not mint a session');
      const cookie = `potion_session=${tok}`;
      // Guarantee-carrying policy + serving key (retentionFloor 0.9 default;
      // sampleRate 1 so every request judge-scores).
      const pol = await fetch(`${API}/api/policies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          policy: {
            type: 'max_quality',
            costCeilingPer1K: 5,
            guarantee: { minQuality: 0.5, windowMin: 60, sampleRate: 1, action: 'alert' },
          },
          createKey: true,
        }),
      });
      const polBody = await pol.json();
      assert(pol.ok && typeof polBody.apiKey === 'string', `policy+key → HTTP ${pol.status}`);
      const policyId = polBody.policy.id as string;
      const key = polBody.apiKey as string;
      // 6 near-identical sessions → one agent cluster with a 6-item suite.
      for (let i = 1; i <= 6; i++) {
        const t = `wt15_${i}`;
        const ing = await fetch(`${API}/v1/traces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            spans: [
              { trace_id: t, span_id: `${t}_r`, name: 'agent.root', model: 'mock-cheap', attributes: { 'gen_ai.prompt': `Reconcile the ledger entry for invoice 7000100${i}` } },
              { trace_id: t, span_id: `${t}_t`, name: 'tool.ledger', model: 'mock-cheap', attributes: { 'gen_ai.operation.name': 'execute_tool' } },
              { trace_id: t, span_id: `${t}_a`, name: 'chat', model: 'mock-cheap', attributes: { 'gen_ai.completion': `Reconciled ${t}.` } },
            ],
          }),
        });
        assert(ing.status === 202, `ingest → HTTP ${ing.status}`);
      }
      const clus = await fetch(`${API}/api/traces/cluster`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ sinceDays: 30 }),
      });
      const clusBody = await clus.json();
      assert(clus.status === 202, `cluster → HTTP ${clus.status}`);
      let clusResult: { clusters?: Array<{ clusterId: string }> } = {};
      for (let i = 0; i < 120; i++) {
        const job = await (await fetch(`${API}/api/jobs/${clusBody.jobId}`, { headers: { cookie } })).json();
        if (job.state === 'completed') { clusResult = job.result ?? {}; break; }
        assert(job.state !== 'failed', `cluster job failed: ${job.error}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      const clusterId = clusResult.clusters?.[0]?.clusterId;
      assert(clusterId !== undefined, 'no agent cluster synthesized');
      // The cluster job's mock eval saved an org frontier — its points carry
      // registered strategy hashes: incumbent = first, serving = last.
      const frontierBody = await (await fetch(`${API}/api/frontiers/${clusterId}`, { headers: { cookie } })).json();
      const points: Array<{ strategyHash: string }> = frontierBody.frontier?.points ?? [];
      // TWO, not one. incumbent = points[0] and serving = points[last], so a
      // ONE-point frontier designates the serving strategy as its own
      // incumbent, the verdict comes back 'self-incumbent', there is no
      // retention headline to gate, and this leg silently stops exercising
      // the certification gate it is named for. `>= 1` let that pass.
      //
      // Found by ingesting the OpenRouter catalogue: different class
      // representatives collapsed the mock org frontier to a single
      // non-dominated point, and leg 15 reported a confusing reason instead
      // of "I can no longer test this".
      assert(
        points.length >= 2,
        `org frontier has ${points.length} point(s) — cannot designate an incumbent DISTINCT ` +
          `from the serving strategy, so the certification gate would not be exercised`,
      );
      const incumbentHash = points[0]!.strategyHash;
      const servingHash = points[points.length - 1]!.strategyHash;
      // DESIGNATE (admin; the baseline of every later verdict).
      const des = await fetch(`${API}/api/guarantee/clusters/${clusterId}/incumbent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ strategyHash: incumbentHash }),
      });
      assert(des.ok, `designate → HTTP ${des.status}: ${await des.text()}`);
      // Sampled serving traffic (X-Potion-Cluster pins the agent cluster);
      // every response id is a completion id the quality row joins on.
      for (let i = 0; i < 3; i++) {
        const chat = await fetch(`${API}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'X-Potion-Cluster': clusterId },
          body: JSON.stringify({ model: 'potion-auto', messages: [{ role: 'user', content: `Reconcile the ledger entry for invoice 7000200${i}` }] }),
        });
        assert(chat.ok, `chat → HTTP ${chat.status}`);
        const chatBody = await chat.json();
        assert(typeof chatBody.id === 'string' && chatBody.id.startsWith('chatcmpl-'), 'no completion id');
      }
      // Judge sampling is fire-and-forget — wait for the samples to land.
      let sampled = 0;
      for (let i = 0; i < 60; i++) {
        const status = await (await fetch(`${API}/api/guarantee/status`, { headers: { cookie } })).json();
        sampled = status.policies?.find((p: { policyId: string }) => p.policyId === policyId)?.samples ?? 0;
        if (sampled >= 3) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert(sampled >= 3, `only ${sampled}/3 quality samples landed`);
      // CONTRACTUAL leg: manual suite-verify (the advisory path enqueues the
      // same job; mock mode renders a mock-labeled verdict).
      const ver = await fetch(`${API}/api/guarantee/clusters/${clusterId}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ policyId, servingStrategyHash: servingHash }),
      });
      const verBody = await ver.json();
      assert(ver.status === 202, `verify → HTTP ${ver.status}: ${JSON.stringify(verBody)}`);
      let verdict: { outcome?: string; providerMode?: string; retention?: { pairs: number } | null } = {};
      for (let i = 0; i < 120; i++) {
        const job = await (await fetch(`${API}/api/jobs/${verBody.jobId}`, { headers: { cookie } })).json();
        if (job.state === 'completed') { verdict = job.result ?? {}; break; }
        assert(job.state !== 'failed', `suite-verify failed: ${job.error}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      const okOutcomes = ['all-clear', 'contractual-breach', 'self-incumbent'];
      assert(okOutcomes.includes(verdict.outcome ?? ''), `unexpected verify outcome: ${JSON.stringify(verdict)}`);
      assert(verdict.providerMode === 'mock', `verdict must be mock-labeled, got '${verdict.providerMode}'`);
      if (verdict.outcome !== 'self-incumbent') {
        assert((verdict.retention?.pairs ?? 0) >= 5, `retention pairs < 5: ${JSON.stringify(verdict.retention)}`);
      }
      // CERTIFICATION GATE (post-capstone item 3, Decision 2): run the REAL
      // certification job and let it land WHEREVER the measurement honestly
      // falls — the mock judge is not discriminative on this fixture's
      // content, so the incumbent's self-retention will genuinely miss the
      // 0.9 floor and the suite stays UNCERTIFIED. The gate working is the
      // assertion: the report must OBEY the certification state, never
      // render a number from an unvouched instrument.
      const certRun = await fetch(`${API}/api/certifications/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ clusterId }),
      });
      const certRunBody = await certRun.json();
      assert(certRun.status === 202, `certify → HTTP ${certRun.status}: ${JSON.stringify(certRunBody)}`);
      let cert: { status?: string; selfRetentionMean?: number | null } = {};
      for (let i = 0; i < 120; i++) {
        const job = await (await fetch(`${API}/api/jobs/${certRunBody.jobId}`, { headers: { cookie } })).json();
        if (job.state === 'completed') { cert = job.result ?? {}; break; }
        assert(job.state !== 'failed', `certify job failed: ${job.error}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert(cert.status === 'certified' || cert.status === 'failed', `certification did not measure: ${JSON.stringify(cert)}`);
      const certList = await (await fetch(`${API}/api/certifications`, { headers: { cookie } })).json();
      assert((certList.certifications ?? []).length >= 1, 'certification row missing from the review surface');
      // REPORT: retention surface OBEYS the certification state.
      const today = new Date().toISOString().slice(0, 10);
      const rep = await (await fetch(`${API}/api/reports/guarantee?from=${today}&to=${today}`, { headers: { cookie } })).json();
      const entry = (rep.entries ?? []).find(
        (e: { policyId: string; clusterId: string }) => e.policyId === policyId && e.clusterId === clusterId,
      );
      assert(entry !== undefined, `report entry missing: ${JSON.stringify(rep.entries?.map((e: { clusterId: string }) => e.clusterId))}`);
      assert(entry.incumbent?.strategyHash === incumbentHash, 'report incumbent mismatch');
      assert(rep.legacyPath === false, 'org with a designation must not read legacyPath');
      assert(entry.qualitySeries.some((d: { samples: number }) => d.samples >= 3), 'series missing samples');
      if (cert.status === 'certified') {
        assert(entry.certification?.certified === true, 'certified cluster must report certification');
        assert(verdict.outcome === 'self-incumbent' || entry.retention !== null, 'certified cluster with a verdict must render the headline');
      } else {
        assert(entry.certification?.certified === false, 'uncertified cluster must report the gate state');
        assert(entry.retention === null, 'UNCERTIFIED cluster rendered a retention number — the gate leaked');
        assert(
          String(entry.retentionUnavailableReason ?? '').includes('not certified'),
          `gate reason missing (verify outcome was '${verdict.outcome}'): ${entry.retentionUnavailableReason}`,
        );
      }
      const html = await fetch(`${API}/api/reports/guarantee?from=${today}&to=${today}&format=html`, { headers: { cookie } });
      assert(html.ok && (html.headers.get('content-type') ?? '').includes('text/html'), 'html report failed');
      const htmlText = await html.text();
      assert(htmlText.includes('Baseline retention'), 'html report missing retention section');
      return `designated ${incumbentHash.slice(0, 8)} → 3 sampled requests → suite-verify ${verdict.outcome} (mock-labeled, ${verdict.retention?.pairs ?? 0} pairs) → certification ${cert.status} (self-retention ${typeof cert.selfRetentionMean === 'number' ? cert.selfRetentionMean.toFixed(3) : '—'}) → report obeys the gate`;
    } finally {
      sessionCookie = savedCookie;
    }
  });


  await step('16. incident SLAs (alert rule → legacy breach → measured notification latency + verification states)', async () => {
    // G2.2: the breach→notification chain end to end against a REAL local
    // capture endpoint — the delivery audit row must carry the incident
    // linkage, the emitter-bound SLA clock, and a measured latency. Legacy
    // path (demo org, no incumbent on code-gen): clock = the breach
    // incident's createdAt. The hierarchy clock (advisory creation) is
    // pinned in the keyless suite; the report's verification field ships on
    // every entry.
    const received: Array<Record<string, unknown>> = [];
    const capture = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try { received.push(JSON.parse(body) as Record<string, unknown>); } catch { /* raw */ }
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => capture.listen(0, '127.0.0.1', r));
    try {
      const captureUrl = `http://127.0.0.1:${(capture.address() as AddressInfo).port}/hook`;
      // Alert rule on the WIDENED vocabulary (guarantee_unverifiable is a
      // G2.2 event — creation must accept it).
      const rule = await fetch(`${API}/api/alerts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(sessionCookie ? { cookie: sessionCookie } : {}) },
        body: JSON.stringify({ kind: 'webhook', targetUrl: captureUrl, events: ['quality_breach', 'rollback', 'guarantee_unverifiable'] }),
      });
      assert(rule.status === 201 || rule.ok, `alert rule → HTTP ${rule.status}: ${await rule.text()}`);
      // A guarantee policy that MUST breach on mock scores (minQuality .99,
      // alert action, every request sampled).
      const pol = await fetch(`${API}/api/policies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(sessionCookie ? { cookie: sessionCookie } : {}) },
        body: JSON.stringify({
          policy: {
            type: 'max_quality',
            costCeilingPer1K: 100,
            guarantee: { minQuality: 0.99, windowMin: 60, sampleRate: 1, action: 'alert' },
          },
          createKey: true,
        }),
      });
      const polBody = await pol.json();
      assert(pol.ok && typeof polBody.apiKey === 'string', `policy+key → HTTP ${pol.status}`);
      for (let i = 0; i < 6; i++) {
        const chat = await fetch(`${API}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${polBody.apiKey}` },
          body: JSON.stringify({ model: 'potion-auto', messages: [{ role: 'user', content: `Write a function that parses row ${i}` }] }),
        });
        assert(chat.ok, `chat ${i} → HTTP ${chat.status}`);
      }
      // Sampling + evaluation + dispatch are async worker jobs — poll the
      // delivery audit for the breach notification.
      let delivery: Record<string, unknown> | undefined;
      for (let i = 0; i < 60 && delivery === undefined; i++) {
        const res = await fetch(`${API}/api/alerts/deliveries?limit=100`, {
          headers: sessionCookie ? { cookie: sessionCookie } : {},
        });
        if (res.ok) {
          const rows = (await res.json()).deliveries as Array<Record<string, unknown>>;
          delivery = rows.find((d) => d.event === 'quality_breach' && d.status === 'delivered');
        }
        if (delivery === undefined) await new Promise((r) => setTimeout(r, 500));
      }
      assert(delivery !== undefined, 'no delivered quality_breach notification within 30s');
      assert(typeof delivery.incidentId === 'string', 'delivery row missing incident linkage');
      assert(typeof delivery.clockStartAt === 'string', 'delivery row missing the SLA clock');
      assert(typeof delivery.latencyMs === 'number' && (delivery.latencyMs as number) >= 0, `latency not measured: ${JSON.stringify(delivery.latencyMs)}`);
      assert(received.some((p) => p.event === 'quality_breach'), 'capture endpoint never received the webhook POST');
      // Report entries now carry the G2.2 verification state; status carries
      // the unverifiable count + honest autoRestore posture.
      const today = new Date().toISOString().slice(0, 10);
      const report = await (
        await fetch(`${API}/api/reports/guarantee?from=${today}&to=${today}`, {
          headers: sessionCookie ? { cookie: sessionCookie } : {},
        })
      ).json();
      assert(Array.isArray(report.entries) && report.entries.length >= 1, 'no report entries');
      assert(
        report.entries.every((e: { verification?: { state?: string } }) => typeof e.verification?.state === 'string'),
        'report entries missing verification state',
      );
      const status = await (
        await fetch(`${API}/api/guarantee/status`, { headers: sessionCookie ? { cookie: sessionCookie } : {} })
      ).json();
      assert(typeof status.unverifiableAdvisories === 'number', 'status missing unverifiableAdvisories');
      assert(status.policies.every((p: { autoRestore?: unknown }) => p.autoRestore !== undefined), 'status missing autoRestore posture');
      // G2.3 KEY ROLE SPLIT, proven live on the incident just minted: the
      // SERVING key (default 'serve' scope) must NOT resolve incidents; an
      // explicitly minted 'serve+admin' key may.
      const denied = await fetch(`${API}/api/incidents/${delivery.incidentId}/resolve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${polBody.apiKey}` },
      });
      assert(denied.status === 403, `serve key must 403 on incident resolve, got ${denied.status}`);
      const deniedBody = await denied.json();
      assert(
        ['insufficient_role', 'insufficient_scope'].includes(deniedBody.error?.code),
        `wrong refusal code: ${JSON.stringify(deniedBody)}`,
      );
      const adminMint = await fetch(`${API}/api/api-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(sessionCookie ? { cookie: sessionCookie } : {}) },
        body: JSON.stringify({ name: 'walkthrough-admin', scopes: 'serve+admin' }),
      });
      const adminMintBody = await adminMint.json();
      assert(adminMint.ok && typeof adminMintBody.apiKey === 'string', `admin key mint → HTTP ${adminMint.status}`);
      const resolved = await fetch(`${API}/api/incidents/${delivery.incidentId}/resolve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminMintBody.apiKey}` },
      });
      assert(resolved.status === 200, `serve+admin resolve → HTTP ${resolved.status}`);
      return `rule → 6 sampled chats → breach notification delivered (latency ${(delivery.latencyMs as number).toFixed(0)}ms, clock+incident linked) → verification states on report → serve key 403 on resolve, serve+admin key 200 (G2.3)`;
    } finally {
      await new Promise<void>((r) => void capture.close(() => r()));
    }
  });

  await step('17. compound policy (quality floor + hard latency bound → premium, then a labeled violation)', async () => {
    // G2.6. The bound is DERIVED from the live frontier rather than
    // hard-coded, so this leg cannot go stale when the mock frontier's
    // latencies change — a hard-coded 1500ms would silently stop pruning
    // anything and the step would keep passing while proving nothing.
    const fr = await (
      await fetch(`${API}/api/frontiers/code-gen`, {
        headers: sessionCookie ? { cookie: sessionCookie } : {},
      })
    ).json();
    const points = (fr.frontier?.points ?? []) as Array<{
      strategyHash: string;
      quality: number;
      costPer1K: number;
      latencyP95: number;
    }>;
    assert(points.length >= 2, `need >= 2 frontier points, got ${points.length}`);

    // Floor = the median quality, so at least one point clears it and at
    // least one does not. Bound = tight enough to exclude the slowest
    // qualifying point but admit the fastest one.
    const qualities = [...points.map((p) => p.quality)].sort((a, b) => a - b);
    const floor = qualities[Math.floor(qualities.length / 2)]!;
    const qualifying = points.filter((p) => p.quality >= floor).sort((a, b) => a.latencyP95 - b.latencyP95);
    assert(qualifying.length >= 1, 'no qualifying point at the derived floor');
    const fastest = qualifying[0]!;
    const bound = Math.ceil(fastest.latencyP95) + 1;

    const mk = async (policy: Record<string, unknown>): Promise<string> => {
      const res = await fetch(`${API}/api/policies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(sessionCookie ? { cookie: sessionCookie } : {}) },
        body: JSON.stringify({ policy, createKey: true }),
      });
      const body = await res.json();
      assert(res.ok && typeof body.apiKey === 'string', `policy+key → HTTP ${res.status}: ${JSON.stringify(body)}`);
      return body.apiKey as string;
    };
    const traceOf = async (key: string): Promise<Record<string, string>> => {
      const res = await fetch(`${API}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'potion-auto', messages: [{ role: 'user', content: 'Write a python function that reverses a string' }] }),
      });
      assert(res.ok, `compound chat → HTTP ${res.status}: ${await res.text()}`);
      const raw = res.headers.get('x-frontier-trace') ?? '';
      return Object.fromEntries(
        raw.split(';').filter(Boolean).map((kv) => {
          const i = kv.indexOf('=');
          return [kv.slice(0, i), kv.slice(i + 1)];
        }),
      );
    };

    // (a) FEASIBLE: the bound admits the fastest qualifying point.
    const feasibleKey = await mk({ type: 'compound', qualityFloor: floor, p95Ms: bound });
    const t = await traceOf(feasibleKey);
    assert(t.policy === 'compound', `policy type not on the trace: ${JSON.stringify(t)}`);
    assert(t.fallback === '0', `feasible compound should not fall back: ${JSON.stringify(t)}`);
    // The latency SOURCE is declared on every latency-dimensioned policy —
    // a bound evaluated against benchmark numbers must say so.
    assert(
      t.latency_src === 'serving' || t.latency_src === 'harness',
      `missing latency_src on the trace: ${JSON.stringify(t)}`,
    );
    // The served point must actually respect the bound.
    const served = points.find((p) => p.strategyHash.startsWith(t.strategy ?? '~'));
    assert(served !== undefined, `served strategy ${t.strategy} is not a frontier point`);
    assert(served.latencyP95 <= bound, `served p95 ${served.latencyP95} exceeds the bound ${bound}`);

    // The DTO carries the provenance a latency-driven selection needs.
    const dto = await (
      await fetch(`${API}/api/frontiers/code-gen`, { headers: { authorization: `Bearer ${feasibleKey}` } })
    ).json();
    const ev = dto.operatingPoint?.latencyEvidence;
    assert(ev && typeof ev.n === 'number' && typeof ev.provisional === 'boolean' && typeof ev.span === 'string',
      `operating point missing latency evidence: ${JSON.stringify(dto.operatingPoint)}`);

    // (b) INFEASIBLE: tighten below EVERY qualifying p95. The owner's rule —
    // violate the customer-observable dimension, never the invisible one.
    const tooTight = Math.max(1, Math.floor(Math.min(...qualifying.map((p) => p.latencyP95))) - 1);
    const violKey = await mk({ type: 'compound', qualityFloor: floor, p95Ms: tooTight });
    const vt = await traceOf(violKey);
    assert(vt.latency_violated === '1', `violation not labeled on the trace: ${JSON.stringify(vt)}`);
    const violServed = points.find((p) => p.strategyHash.startsWith(vt.strategy ?? '~'));
    assert(violServed !== undefined, `violating served strategy ${vt.strategy} is not a frontier point`);
    // Quality was NOT sacrificed to meet the clock.
    assert(violServed.quality >= floor, `served ${violServed.quality} below the floor ${floor} — quality was traded for latency`);

    // …and the standing policy-level condition is on the guarantee status,
    // deduped, carrying BOTH relaxation directions.
    await traceOf(violKey);
    await traceOf(violKey);
    const status = await (
      await fetch(`${API}/api/guarantee/status`, { headers: sessionCookie ? { cookie: sessionCookie } : {} })
    ).json();
    const conds = (status.infeasiblePolicies ?? []) as Array<Record<string, unknown>>;
    assert(conds.length === 1, `expected exactly ONE standing condition after 3 violating requests, got ${conds.length}`);
    const c = conds[0]!;
    assert(c.condition === 'latency_bound_infeasible', `wrong condition: ${JSON.stringify(c)}`);
    assert(c.relaxLatencyToMs !== null, 'condition missing the latency relaxation');
    assert(typeof c.latencySource === 'string', 'condition missing the latency source');

    return (
      `floor ${floor.toFixed(2)} derived from the live frontier; bound ${bound}ms serves ` +
      `${t.strategy} (latency_src=${t.latency_src}${t.latency_premium ? `, premium ${t.latency_premium}, relax ${t.relax_ms}ms` : ''}) → ` +
      `tightened to ${tooTight}ms: violation labeled, quality floor held, ONE standing condition`
    );
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
