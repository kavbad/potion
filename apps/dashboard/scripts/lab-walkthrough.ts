// Step 8 — THE TEN-MINUTE CLOCK (docs/specs/step-08-novice-loop.md).
//
// A SCRIPTED novice-shaped session, the Gate 6 harness pattern with its own
// budget: boots server+dashboard on a fresh db, then performs ONLY what the
// UI affords, in order —
//   sign in → open /lab → type the four interview answers → submit → read
//   the generated summary → start the trial → poll the narration until the
//   check-in appears → answer it → poll to a terminal state → open the
//   report and assert all FOUR sections render (including the single
//   evidence-chosen upgrade).
// WALL CLOCK from interview submit to report rendered; asserts < 600s.
//
// Zero-knowledge rule: the DRIVING path uses no ids the UI didn't hand back
// and reads no db. The ARRANGEMENT (before the novice arrives) seeds what a
// real deployment would already have: the taxonomy cluster row and a
// live-evidenced platform frontier for it (Step 5's product — without live
// evidence the generator honestly drafts with frontier-not-live, which is a
// different walkthrough). Mock providers, $0.
//
// The novice builds a STANDING mission: standing specs carry the half-fuel
// check-in (Step 8, lab-gen assemble), so the session hits every surface —
// narration, the check-in pause, the answer resume, the fuel hard stop, and
// a report whose upgrade is evidence-sourced (budget-killed → raise worth).
//
// Usage: pnpm --filter @potion/dashboard lab-walkthrough
//   (requires `pnpm build` first — runs apps/server dist/ + .next/)
// Env: LAB_WALK_API_PORT (default 3110), LAB_WALK_DASH_PORT (default 3111).
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DASH_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const REPO_ROOT = path.resolve(DASH_DIR, '../..');
const API_PORT = Number(process.env.LAB_WALK_API_PORT ?? 3110);
const DASH_PORT = Number(process.env.LAB_WALK_DASH_PORT ?? 3111);
const API = `http://localhost:${API_PORT}`;
const DASH = `http://localhost:${DASH_PORT}`;

const t0 = Date.now();
const children: ChildProcess[] = [];
let failures = 0;
let sessionCookie = '';

/** The DoD clock: interview submit → report rendered, in ms. */
let clockStart = 0;
let clockStop = 0;

function dashFetch(p: string, init?: RequestInit): Promise<Response> {
  return fetch(`${DASH}${p}`, {
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
  console.log('── Potion Lab: the ten-minute novice walkthrough (Step 8) ──────');
  console.log(`repo: ${REPO_ROOT}`);
  console.log(`api : ${API}   dashboard: ${DASH}`);

  // ---- ARRANGEMENT (not the novice's path): a persisted fresh db carrying
  // what a real deployment has before any user arrives — the taxonomy
  // cluster row + a live-evidenced platform frontier (Step 5's product).
  let dbDir = '';
  await step('arrange: fresh db with a live-evidenced summarization frontier', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'potion-lab-walk-'));
    dbDir = path.join(tmp, 'db');
    // The arrangement runs against built dists (scripts/lab-walk-arrange.mjs)
    // so this package keeps zero workspace dependencies.
    await new Promise<void>((resolve, reject) => {
      const child = spawn('node', ['scripts/lab-walk-arrange.mjs', dbDir], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`arrange exited ${code}`)),
      );
    });
    return `pglite dir ${dbDir}`;
  });

  await step('boot api server (persisted PGlite, worker in-process)', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'potion-lab-prices-'));
    const tmpPrices = path.join(tmp, 'prices.json');
    await copyFile(path.join(REPO_ROOT, 'prices.json'), tmpPrices);
    boot('node', ['apps/server/dist/index.js'], REPO_ROOT, {
      PORT: String(API_PORT),
      DATABASE_URL: `pglite://${dbDir}`,
      POTION_PRICES_PATH: tmpPrices,
      POTION_SEED_DEMO: '1',
      // The lab:run worker serves through the REAL route of this same
      // process — the ephemeral run-scoped key rides real HTTP.
      POTION_SERVING_URL: API,
    });
    await waitFor(`${API}/healthz`, 120_000, 'api');
  });

  await step('boot dashboard (next start, production build)', async () => {
    const nextBin = path.join(DASH_DIR, 'node_modules', '.bin', 'next');
    boot(nextBin, ['start', '-p', String(DASH_PORT)], DASH_DIR, {
      POTION_API_URL: API,
      PORT: String(DASH_PORT),
    });
    await waitFor(DASH, 60_000, 'dashboard');
  });

  // ---- the novice's session begins ----
  await step('sign in (magic link → session cookie)', async () => {
    const rl = await fetch(`${API}/auth/request-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'demo@potion.dev' }),
    });
    const rlBody = (await rl.json()) as { devLink?: string };
    assert(rl.ok && rlBody.devLink, `no devLink (dev mode off?): ${JSON.stringify(rlBody)}`);
    const verify = await fetch(rlBody.devLink!);
    const verifyBody = (await verify.json()) as { token?: string };
    assert(verify.ok && verifyBody.token, 'magic-link verify failed');
    sessionCookie = `potion_session=${verifyBody.token}`;
  });

  await step('open /lab — the interview form renders', async () => {
    const res = await dashFetch('/lab');
    const html = await res.text();
    assert(res.ok, `/lab returned ${res.status}`);
    assert(html.includes('What should it do'), 'interview Q1 not on the page');
    assert(html.includes('worth'), 'worth question not on the page');
  });

  // ---- THE CLOCK STARTS: interview submit ----
  let harnessHash = '';
  await step('submit the four answers → complete harness', async () => {
    clockStart = Date.now();
    const res = await dashFetch('/api/lab/harnesses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        answers: {
          goal: 'Watch my weekly meeting notes and summarize the highlights into a short digest',
          kind: 'standing',
          // Two declared accounts → two SEVERED filaments (the 4th posture
          // place) — the trial still runs brain-only, honestly.
          accounts: ['calendar', 'email'],
          worthUsd: 0.05,
        },
      }),
    });
    const body = (await res.json()) as {
      kind?: string;
      harnessHash?: string;
      clusterId?: string;
      reason?: string;
      detail?: string;
      gaps?: unknown[];
    };
    assert(
      res.status === 201 && body.kind === 'complete' && body.harnessHash,
      `expected a complete harness, got ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
    );
    harnessHash = body.harnessHash!;
    return `harness ${harnessHash.slice(0, 12)}… on cluster ${body.clusterId}`;
  });

  await step('read the harness — THE FORM is the page (Step 9: no template UI)', async () => {
    const res = await dashFetch(`/lab/harness/${harnessHash}`);
    const html = await res.text();
    assert(res.ok, `harness page ${res.status}`);
    // The derived form is the primary surface; its SSR data attributes are
    // derived from the same DTOs the canvas draws (the walkthrough's proof
    // surface). Two declared superpowers → two severed filaments; standing
    // mission; zero rules → zero laminations, honestly.
    assert(html.includes('data-testid="lab-form"'), 'the derived form is not the page');
    assert(html.includes(`data-harness-hash="${harnessHash}"`), 'form not derived from THIS harness');
    assert(html.includes('data-mission-kind="standing"'), 'silhouette parameter missing');
    assert(html.includes('data-severed="2"'), 'severed filament count wrong');
    assert(html.includes('data-laminations="0"'), 'lamination count wrong (expected 0 rules)');
  });

  let runId = '';
  await step('start the trial', async () => {
    const res = await dashFetch('/api/lab/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ harnessHash }),
    });
    const body = (await res.json()) as { runId?: string };
    assert(res.status === 202 && body.runId, `run start failed (${res.status})`);
    runId = body.runId!;
    return runId;
  });

  interface RunDto {
    state: string;
    pendingQuestion: string | null;
    steps: Array<{ kind: string; costLabel?: string }>;
    cost: { meteredUsd: number; estPendingUsd: number };
  }
  const pollRun = async (): Promise<RunDto> => {
    const res = await dashFetch(`/api/lab/runs/${runId}`);
    assert(res.ok, `run poll ${res.status}`);
    return (await res.json()) as RunDto;
  };
  const pollUntil = async (pred: (r: RunDto) => boolean, what: string, timeoutMs: number): Promise<RunDto> => {
    const deadline = Date.now() + timeoutMs;
    let last: RunDto | null = null;
    while (Date.now() < deadline) {
      last = await pollRun();
      if (pred(last)) return last;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`${what} not reached (last state: ${last?.state}, steps: ${last?.steps.length})`);
  };

  await step('poll the narration until the check-in appears', async () => {
    const r = await pollUntil((x) => x.state === 'awaiting-human', 'check-in', 240_000);
    assert(r.pendingQuestion !== null && r.pendingQuestion.length > 0, 'no pending question');
    assert(r.steps.length > 0, 'no narration steps');
    // The ticker never blends: every model step is labeled metered or est.
    for (const s of r.steps) {
      if (s.kind === 'model') assert(s.costLabel === 'metered' || s.costLabel === 'est.', 'unlabeled model cost');
    }
    return `question: "${r.pendingQuestion!.slice(0, 80)}" after ${r.steps.length} steps`;
  });

  await step('answer the check-in', async () => {
    const res = await dashFetch(`/api/lab/runs/${runId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'Yes — keep going, this is still worth it.' }),
    });
    assert(res.status === 202, `answer failed (${res.status})`);
  });

  await step('poll to a terminal state', async () => {
    const TERMINAL = new Set(['completed', 'failed', 'killed-budget', 'killed-operator']);
    const r = await pollUntil((x) => TERMINAL.has(x.state), 'terminal state', 240_000);
    return `state=${r.state}, ${r.steps.length} steps, metered $${r.cost.meteredUsd.toFixed(4)}`;
  });

  await step('open the report — all four sections render', async () => {
    const page = await dashFetch(`/lab/run/${runId}/report`);
    const html = await page.text();
    assert(page.ok, `report page ${page.status}`);
    assert(html.includes('1. What happened'), 'section 1 missing');
    assert(html.includes('2. What it cost'), 'section 2 missing');
    assert(html.includes('3. Where it struggled'), 'section 3 missing');
    assert(html.includes('4. The one upgrade'), 'section 4 missing');
    const rep = await dashFetch(`/api/lab/runs/${runId}/report`);
    const body = (await rep.json()) as {
      suggestedUpgrade?: { reason: string; text: string };
      meteredTotalUsd?: number;
      estimatedUnmeteredUsd?: number;
    };
    assert(rep.ok && body.suggestedUpgrade, 'no suggested upgrade in the report');
    clockStop = Date.now();
    return `upgrade[${body.suggestedUpgrade!.reason}], metered $${body.meteredTotalUsd?.toFixed(4)}, est-pending $${body.estimatedUnmeteredUsd?.toFixed(4)}`;
  });

  // ---- Step 9 leg: live re-render through the REAL edit path ----
  await step('Step 9: /edit lands a NEW content hash; the form re-derives from it', async () => {
    const res = await dashFetch(`/api/lab/harnesses/${harnessHash}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'add-rule', rule: 'never invent numbers' }] }),
    });
    const body = (await res.json()) as { ok?: boolean; harnessHash?: string; unchanged?: boolean };
    assert(res.ok && body.ok === true && body.unchanged === false && body.harnessHash, `edit failed (${res.status})`);
    assert(body.harnessHash !== harnessHash, 'edit did not move the content hash');
    const page = await dashFetch(`/lab/harness/${body.harnessHash}`);
    const html = await page.text();
    assert(page.ok, `edited harness page ${page.status}`);
    // The form derived from the EDITED spec: one rule → one lamination.
    assert(html.includes(`data-harness-hash="${body.harnessHash}"`), 'form not on the new hash');
    assert(html.includes('data-laminations="1"'), 'the added rule did not reach the membrane');
    // And the PRIOR page still renders its own frozen identity.
    const prior = await dashFetch(`/lab/harness/${harnessHash}`);
    assert((await prior.text()).includes('data-laminations="0"'), 'the prior row moved — catalog invariance broken');
    return `edit: ${harnessHash.slice(0, 8)}… → ${body.harnessHash.slice(0, 8)}… (laminations 0→1, both pages truthful)`;
  });

  await step('THE CLOCK: interview submit → report rendered < 600s', async () => {
    assert(clockStart > 0 && clockStop > clockStart, 'clock did not run');
    const seconds = (clockStop - clockStart) / 1000;
    assert(seconds < 600, `novice loop took ${seconds.toFixed(1)}s (budget 600s)`);
    return `${seconds.toFixed(1)}s of 600s`;
  });

  const total = elapsed(t0);
  console.log('────────────────────────────────────────────────────────────────');
  console.log(
    failures === 0
      ? `── Lab ten-minute walkthrough OK — total ${total} ──`
      : `── Lab walkthrough: ${failures} step(s) FAILED — total ${total} ──`,
  );
}

main()
  .catch((e) => {
    failures += 1;
    console.error('lab walkthrough crashed:', e);
  })
  .finally(() => {
    for (const c of children) {
      try {
        c.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
    setTimeout(() => process.exit(failures === 0 ? 0 : 1), 1000).unref();
  });
