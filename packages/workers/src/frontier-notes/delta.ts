// Frontier Notes — Delta, the persistent Worker writer (F0 of the fleet,
// docs/RESEARCH-FLEET.md R5 + docs/RESEARCH-WRITING.md).
//
// The one-shot serving call (write.ts potionDraft) drafted the issue but
// left no run: no record, no memory, no judge, no byline that derives from
// anything. Delta is a hired Worker on the Lab: this client starts a
// recorded run on Delta's harness with the fact sheet attached, waits for
// completion, and reads the draft the run wrote to its workspace
// (draft.json). The byline "Delta" is then a provenance claim the record
// backs — Issue.writer carries the runId (fleet R2: credits derive from
// records, never captions).
//
// The fact-sheet-only discipline survives unchanged: the attachment IS the
// fact sheet, the harness goal says it is the only source of facts, and
// redact.ts remains the backstop over every string that reaches the page.
//
// Failure NEVER blocks the note: any error, park, or timeout returns a
// typed fallback note and the caller walks the existing chain
// (potion → model → deterministic). A parked or still-running run is left
// alone — the operator answers it or the reaper reaps it — and the receipt
// still points at it so the issue records what happened.
import type { FactSheet } from './types.js';
import { deterministicDraft, parseDraft, type Draft } from './write.js';

export interface DeltaWriterOptions {
  /** Server origin, e.g. https://api.withpotion.com */
  url: string;
  /** potion_session cookie value for the research org (member role or above). */
  session: string;
  /** Delta's harness hash (64 hex chars). */
  harnessHash: string;
  /** Total wait budget for the run. Default 15 minutes. */
  timeoutMs?: number;
  /** Poll interval. Default 5s. */
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

/** What the run record says about the draft — the byline's evidence. */
export interface DeltaReceipt {
  runId: string;
  harnessHash: string;
  /** Terminal (or last observed) run state. */
  state: string;
  /** Metered spend from the run DTO (est-pending excluded — honest-cap law). */
  meteredUsd: number;
  /** The advisory judge score when present on the DTO. */
  judgeScore: number | null;
}

interface RunDto {
  state?: string;
  stateReason?: string | null;
  pendingQuestion?: string | null;
  cost?: { meteredUsd?: number };
  judge?: { score?: number } | null;
}

const TERMINAL = new Set(['completed', 'failed', 'killed-budget', 'killed-operator']);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Draft this week's issue through a recorded Delta run. On success the
 * draft came from the run's draft.json; on any failure the deterministic
 * draft returns with a note saying exactly why, and the receipt (when a
 * run was created at all) still names the run.
 */
export async function deltaDraft(
  f: FactSheet,
  o: DeltaWriterOptions,
): Promise<{ draft: Draft; receipt: DeltaReceipt | null; fallback: string | null }> {
  const fallback = deterministicDraft(f);
  const fetchFn = o.fetchImpl ?? fetch;
  const base = o.url.replace(/\/$/, '');
  const headers = { cookie: `potion_session=${o.session}`, 'content-type': 'application/json' };
  const timeoutMs = o.timeoutMs ?? 15 * 60_000;
  const pollMs = o.pollMs ?? 5_000;

  let runId: string;
  try {
    const res = await fetchFn(`${base}/api/lab/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        harnessHash: o.harnessHash,
        attachments: [{ name: 'facts.json', contentBase64: Buffer.from(JSON.stringify(f, null, 1)).toString('base64') }],
      }),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 160);
      return { draft: fallback, receipt: null, fallback: `delta HTTP ${res.status}: ${text}` };
    }
    const body = (await res.json()) as { runId?: string };
    if (typeof body.runId !== 'string') {
      return { draft: fallback, receipt: null, fallback: 'delta run creation returned no runId' };
    }
    runId = body.runId;
  } catch (e) {
    return { draft: fallback, receipt: null, fallback: `delta: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }

  const receiptOf = (dto: RunDto): DeltaReceipt => ({
    runId,
    harnessHash: o.harnessHash,
    state: dto.state ?? 'unknown',
    meteredUsd: dto.cost?.meteredUsd ?? 0,
    judgeScore: typeof dto.judge?.score === 'number' ? dto.judge.score : null,
  });

  const deadline = Date.now() + timeoutMs;
  let dto: RunDto = {};
  for (;;) {
    try {
      const res = await fetchFn(`${base}/api/lab/runs/${runId}`, { headers });
      if (res.ok) dto = (await res.json()) as RunDto;
    } catch {
      // transient poll errors are just another wait
    }
    const state = dto.state ?? 'pending';
    if (state === 'completed') break;
    if (state === 'awaiting-human') {
      // Parked with a question — left parked for the operator; the note
      // publishes via the fallback chain rather than waiting on a human.
      const q = (dto.pendingQuestion ?? '').slice(0, 120);
      return { draft: fallback, receipt: receiptOf(dto), fallback: `delta run ${runId} parked with a question${q ? ` ("${q}")` : ''} — answer it on the run page` };
    }
    if (TERMINAL.has(state)) {
      return { draft: fallback, receipt: receiptOf(dto), fallback: `delta run ${runId} ended ${state}${dto.stateReason ? `: ${dto.stateReason.slice(0, 120)}` : ''}` };
    }
    if (Date.now() >= deadline) {
      return { draft: fallback, receipt: receiptOf(dto), fallback: `delta run ${runId} still ${state} after ${Math.round(timeoutMs / 1000)}s — left to finish on its own` };
    }
    if (pollMs > 0) await sleep(pollMs);
  }

  let text: string;
  try {
    const res = await fetchFn(`${base}/api/lab/runs/${runId}/files/draft.json`, { headers });
    if (!res.ok) {
      return { draft: fallback, receipt: receiptOf(dto), fallback: `delta run ${runId} completed but draft.json is not in the run files (HTTP ${res.status})` };
    }
    text = await res.text();
  } catch (e) {
    return { draft: fallback, receipt: receiptOf(dto), fallback: `delta draft.json read failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }

  const parsed = parseDraft(text, fallback);
  if (!parsed) {
    return { draft: fallback, receipt: receiptOf(dto), fallback: `delta run ${runId} wrote draft.json but it did not parse as a draft` };
  }
  return { draft: parsed, receipt: receiptOf(dto), fallback: null };
}
