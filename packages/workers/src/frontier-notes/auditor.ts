// Frontier Notes — Auditor, the independent verifier (F1 of the fleet,
// docs/RESEARCH-FLEET.md R2 + docs/RESEARCH-WRITING.md).
//
// The count audit (delta.ts) is deterministic law and catches stated count
// contradictions; F0's night proved the rest of the failure surface is
// SEMANTIC — a transposed interval, a "moved to a different model" story, a
// causal claim the facts don't contain. That layer is Auditor: a second
// Worker, deliberately separate from the one that wrote the draft, which
// recomputes the draft's claims against the fact sheet in its sandbox and
// files a TYPED verification record (verdict.json): per-claim
// recomputed / accepted-on-evidence / not-recomputable, ok or not, and the
// required changes in plain words.
//
// The law this client enforces (fleet R2): Delta's prose ships ONLY with
// pass evidence on record. No verdict — because the run failed, parked,
// timed out, or the record didn't parse — is a FAIL for the model-written
// draft (the caller reverts to the deterministic draft, which is composed
// from the facts by code and needs no verifier). The weekly note is never
// blocked; the byline just falls back to the writer that cannot lie.
import type { FactSheet } from './types.js';
import type { Draft } from './write.js';
import { redactFactsForWriter, type DeltaWriterOptions } from './delta.js';

export interface AuditorCheck {
  claim: string;
  method: 'recomputed' | 'accepted-on-evidence' | 'not-recomputable';
  ok: boolean;
  note?: string;
}

export interface AuditorVerdict {
  /** 'pass-with-changes' (fleet doc's PASS WITH REQUIRED CHANGES): the
   * facts hold but the record asks for edits — the draft does not ship as
   * written, and the caller redrafts with the changes in hand rather than
   * discarding a factually sound draft over one sentence. */
  verdict: 'pass' | 'pass-with-changes' | 'fail';
  checks: AuditorCheck[];
  requiredChanges: string[];
  /** The run that produced this verdict — the "Verified by Auditor" line's evidence. */
  runId: string;
  meteredUsd: number;
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

const METHODS = new Set(['recomputed', 'accepted-on-evidence', 'not-recomputable']);

/** Parse verdict.json tolerantly (case-insensitive verdict, near-miss check
 * rows dropped rather than fatal) but never invent: no parseable verdict
 * field means no verdict. */
export function parseVerdict(text: string): Omit<AuditorVerdict, 'runId' | 'meteredUsd' | 'judgeScore'> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const v = typeof o.verdict === 'string' ? o.verdict.toLowerCase().trim() : '';
    if (v !== 'pass' && v !== 'fail') return null;
    const checks: AuditorCheck[] = Array.isArray(o.checks)
      ? o.checks.flatMap((c): AuditorCheck[] => {
          if (!c || typeof c !== 'object') return [];
          const r = c as Record<string, unknown>;
          const claim = typeof r.claim === 'string' ? r.claim : null;
          const method = typeof r.method === 'string' && METHODS.has(r.method) ? (r.method as AuditorCheck['method']) : null;
          const ok = typeof r.ok === 'boolean' ? r.ok : null;
          if (claim === null || method === null || ok === null) return [];
          return [{ claim, method, ok, ...(typeof r.note === 'string' && r.note ? { note: r.note } : {}) }];
        })
      : [];
    const requiredChanges = Array.isArray(o.requiredChanges)
      ? o.requiredChanges.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : [];
    // A pass with failed material checks is not a pass — the typed record
    // outranks the one-word verdict. A pass whose ONLY defect is a list of
    // required changes is the fleet doc's middle state: the facts hold,
    // the prose needs edits (2026-09-03 — the v1 record collapsed this to
    // 'fail' and discarded factually sound drafts over one sentence).
    const failedChecks = checks.filter((c) => !c.ok).length;
    const verdict: AuditorVerdict['verdict'] =
      v === 'pass' && failedChecks === 0
        ? requiredChanges.length === 0
          ? 'pass'
          : 'pass-with-changes'
        : 'fail';
    return { verdict, checks, requiredChanges };
  } catch {
    return null;
  }
}

/**
 * Run the draft through an Auditor worker run. Returns the typed verdict
 * (pass or fail), or null with a typed fallback note when no verification
 * record could be obtained — which the caller must treat as fail for the
 * model-written draft.
 */
export async function auditorVerify(
  facts: FactSheet,
  draft: Draft,
  o: DeltaWriterOptions,
): Promise<{ verdict: AuditorVerdict | null; fallback: string | null }> {
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
        // The auditor receives the SAME redacted sheet the writer saw
        // (vague costSaving removed) — it verifies against what the
        // writer was allowed to say; the vague-ratio guard runs with the
        // real facts before this call.
        attachments: [
          { name: 'facts.json', contentBase64: Buffer.from(JSON.stringify(redactFactsForWriter(facts), null, 1)).toString('base64') },
          { name: 'draft.json', contentBase64: Buffer.from(JSON.stringify(draft, null, 1)).toString('base64') },
        ],
      }),
    });
    if (!res.ok) return { verdict: null, fallback: `auditor HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const body = (await res.json()) as { runId?: string };
    if (typeof body.runId !== 'string') return { verdict: null, fallback: 'auditor run creation returned no runId' };
    runId = body.runId;
  } catch (e) {
    return { verdict: null, fallback: `auditor: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }

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
      return { verdict: null, fallback: `auditor run ${runId} parked with a question — answer it on the run page` };
    }
    if (TERMINAL.has(state)) {
      return { verdict: null, fallback: `auditor run ${runId} ended ${state}${dto.stateReason ? `: ${dto.stateReason.slice(0, 120)}` : ''}` };
    }
    if (Date.now() >= deadline) {
      return { verdict: null, fallback: `auditor run ${runId} still ${state} after ${Math.round(timeoutMs / 1000)}s — left to finish on its own` };
    }
    if (pollMs > 0) await sleep(pollMs);
  }

  let text: string;
  try {
    const res = await fetchFn(`${base}/api/lab/runs/${runId}/files/verdict.json`, { headers });
    if (!res.ok) return { verdict: null, fallback: `auditor run ${runId} completed but verdict.json is not in the run files (HTTP ${res.status})` };
    text = await res.text();
  } catch (e) {
    return { verdict: null, fallback: `auditor verdict.json read failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }

  const parsed = parseVerdict(text);
  if (!parsed) return { verdict: null, fallback: `auditor run ${runId} wrote verdict.json but it did not parse as a verification record` };
  return {
    verdict: {
      ...parsed,
      runId,
      meteredUsd: dto.cost?.meteredUsd ?? 0,
      judgeScore: typeof dto.judge?.score === 'number' ? dto.judge.score : null,
    },
    fallback: null,
  };
}
