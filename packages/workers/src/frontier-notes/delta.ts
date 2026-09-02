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
import { lintDraft } from './lint.js';
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

const WORD_NUMS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
// Digit counts are guarded against decimals/percents/ratios on both sides:
// "0.886" must never read as a count of 0, "8×" never as a count of 8.
const NUM_RE = '(?<![.\\d])(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|every|all|each|none|no|\\d{1,2})(?![.\\d%×x])';

/** THE COUNT AUDIT (found live, night one: run-f1164fc6 headlined "One
 * cluster drifted" against facts saying two; run-099975b9 miscounted the
 * mixing tally) — a draft that contradicts the fact sheet's held/moved
 * counts is REFUSED, deterministically. Both directions are scanned
 * ("two clusters moved" / "moved two clusters"); an unparseable or
 * unmentioned count is not a violation — this audit only catches stated
 * contradictions. Returns the violation, or null. */
export function auditDraftCounts(draft: Draft, facts: FactSheet): string | null {
  const text = [draft.title, draft.summary, draft.plain, draft.lede, draft.frontierNote, draft.auditionNote].join(' ');
  const clusterNoun = '(?:clusters?|routes?|frontiers?|picks?)';
  const expected: Array<{ verb: string; noun: string; count: number }> = [
    { verb: '(?:moved|drifted)', noun: clusterNoun, count: facts.frontier.filter((c) => c.verdict === 'drift').length },
    { verb: 'held', noun: clusterNoun, count: facts.frontier.filter((c) => c.verdict === 'ok').length },
    // run-d4d73505's plain said "One new small model was auditioned" while
    // its own auditions section correctly said three. 'screened' stays out:
    // "322 listings screened" is a DIFFERENT true count.
    { verb: '(?:auditioned|measured|tested)', noun: '(?:models?|candidates?)', count: facts.auditions.length },
  ];
  // A TEMPERED gap: free text that can never cross another counted verb, a
  // conjunction, or ANOTHER NUMBER — so "Two clusters drifted while eight
  // picks held" cannot read as "two … held", and "Of 10 canaries across 10
  // clusters, 8 held" (run-721941f5, a TRUE sentence) cannot bind 10 to
  // "held" across the intervening 8.
  const gap = '(?:(?!\\b(?:held|moved|drift\\w*|audition\\w*|measured|tested|screened|while|and|but|though|\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|every|all|none)\\b)[^.;,])';
  const roster = facts.frontier.length;
  const resolve = (raw: string): number =>
    ['every', 'all', 'each'].includes(raw) ? roster : ['none', 'no'].includes(raw) ? 0 : (WORD_NUMS[raw] ?? Number(raw));
  for (const { verb, noun, count } of expected) {
    const claims: number[] = [];
    // Partitive claims FIRST — "eight of ten routes held" (run-0eb4bca7, a
    // TRUE sentence): the first number is the claim, the second must be the
    // roster size, and the whole span is consumed so the generic patterns
    // below never read the inner "ten routes held" as a ten-claim.
    let scan = text;
    // "(?<!every )(?<!each )": "every one of the ten clusters returned a
    // clear held or drift verdict" (run-25d69a3c, TRUE) is a statement
    // about verdicts returned, not a one-held claim. And "(?!\\s+or\\b)"
    // on the verb: "held or drift verdict" names the vocabulary, it does
    // not count anything.
    // The denominator→noun segment is TEMPERED too: "8 of 10 clusters
    // while 2 clusters drifted" (run-8f414c4e, TRUE) must bind the first
    // "clusters", never lazily skip across "while 2" to the second.
    scan = scan.replace(
      new RegExp(`(?<!\\bevery\\s)(?<!\\beach\\s)\\b${NUM_RE}\\s+of\\s+(?:(?:the|those|these|its|our)\\s+)?${NUM_RE}\\b${gap}{0,30}?\\b${noun}\\b${gap}{0,20}?\\b${verb}\\b(?!\\s+or\\b)`, 'gi'),
      (m, g1: string, g2: string) => {
        claims.push(resolve(g1.toLowerCase()));
        // A wrong denominator ("eight of nine routes held" on a ten-cluster
        // roster) is a count error too.
        const denom = resolve(g2.toLowerCase());
        if (!Number.isNaN(denom) && denom !== roster) claims.push(denom);
        return ' ';
      },
    );
    for (const re of [
      // "two clusters ... moved" — the count precedes the noun and verb.
      // The verb is boundary-anchored on BOTH sides: "name withheld" must
      // never match "held" (run-d4d73505's false refusal). "(?!\\s+or\\b)":
      // "held or drift verdict" names the vocabulary, it counts nothing.
      new RegExp(`\\b${NUM_RE}\\b${gap}{0,60}?\\b${noun}\\b${gap}{0,60}?\\b${verb}\\b(?!\\s+or\\b)`, 'gi'),
      // "moved two clusters".
      new RegExp(`\\b${verb}\\b(?!\\s+or\\b)${gap}{0,30}?\\b${NUM_RE}\\b${gap}{0,40}?\\b${noun}`, 'gi'),
    ]) {
      // Universal quantifiers are count claims too (run-b5a5d340 headlined
      // "Every frontier held" over an 8-of-10 week): every/all/each asserts
      // the full roster; none/no asserts zero.
      for (const m of scan.matchAll(re)) {
        claims.push(resolve(m[1]!.toLowerCase()));
      }
    }
    for (const c of claims) {
      if (!Number.isNaN(c) && c !== count) {
        return `draft claims ${c} ${verb.replaceAll(/[()?:|]/g, '')} but the fact sheet counts ${count}`;
      }
    }
  }
  return null;
}

/** THE ATTACHMENT REDACTION (run-5fcbdd44 + run-c472bbf4: models WILL
 * quote a number that sits in their input — three drafts leaked 0.911
 * despite an explicit band-words-only rule). A vague mixing entry's exact
 * costSaving is simply removed from the fact sheet the WORKERS receive;
 * the band string carries everything they are allowed to say. The real
 * FactSheet — and the deterministic guards that read it — are untouched. */
export function redactFactsForWriter(f: FactSheet): unknown {
  return {
    ...f,
    mixing: f.mixing.map((m) => {
      if (!m.vague) return m;
      const { costSaving: _hidden, ...rest } = m;
      return rest;
    }),
  };
}

/** THE VAGUE-RATIO GUARD (run-ff6edfc4: the draft printed cost savings
 * 0.911/0.813/0.599 verbatim for VAGUE mixing entries — the disclosure
 * rule is band words only, never the exact ratio, and neither Auditor
 * roll flagged it). Deterministic: for every vague mixing fact, its exact
 * costSaving — as a bare fraction ("0.911") or a percentage ("91%",
 * "91.1%") — must not appear anywhere in the draft. meanQuality stays
 * publishable; only the ratio is protected. */
export function auditVagueRatios(draft: Draft, facts: FactSheet): string | null {
  const text = [draft.title, draft.summary, draft.plain, draft.lede, draft.frontierNote, draft.auditionNote, draft.mixingNote, draft.takeaway, ...draft.faq.flatMap((f) => [f.q, f.a])].join(' ');
  for (const m of facts.mixing) {
    if (!m.vague) continue;
    const pct = Math.round(m.costSaving * 100);
    const forbidden = [m.costSaving.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''), String(m.costSaving), `${pct}%`, `${(m.costSaving * 100).toFixed(1).replace(/\.0$/, '')}%`];
    for (const f of new Set(forbidden)) {
      if (f.length >= 3 && text.includes(f)) {
        return `vague ${m.family} mixing entry's exact cost saving ("${f}") appears in the draft — band words only`;
      }
    }
  }
  return null;
}

/** Delta's first live run (run-099975b9) wrote sentence ARRAYS for the prose
 * fields and {question, answer} FAQ keys — near-miss shapes a rule cannot
 * prevent. Coerce them deterministically before parsing; parseDraft stays
 * the backstop for everything else. */
export function normalizeDraftText(text: string): string {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    for (const k of ['title', 'summary', 'plain', 'lede', 'frontierNote', 'auditionNote', 'mixingNote', 'takeaway']) {
      const v = o[k];
      if (Array.isArray(v) && v.every((x): x is string => typeof x === 'string')) o[k] = v.join(' ');
    }
    if (Array.isArray(o.faq)) {
      o.faq = o.faq.map((f) => {
        if (f && typeof f === 'object') {
          const r = f as Record<string, unknown>;
          const q = r.q ?? r.question;
          const a = r.a ?? r.answer;
          if (typeof q === 'string' && typeof a === 'string') return { q, a };
        }
        return f;
      });
    }
    return JSON.stringify(o);
  } catch {
    return text;
  }
}

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
        attachments: [{ name: 'facts.json', contentBase64: Buffer.from(JSON.stringify(redactFactsForWriter(f), null, 1)).toString('base64') }],
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

  const parsed = parseDraft(normalizeDraftText(text), fallback);
  if (!parsed) {
    return { draft: fallback, receipt: receiptOf(dto), fallback: `delta run ${runId} wrote draft.json but it did not parse as a draft` };
  }
  const violation = auditDraftCounts(parsed, f);
  if (violation !== null) {
    return { draft: fallback, receipt: receiptOf(dto), fallback: `delta run ${runId} refused by the count audit: ${violation}` };
  }
  const styleViolation = lintDraft(parsed);
  if (styleViolation !== null) {
    return { draft: fallback, receipt: receiptOf(dto), fallback: `delta run ${runId} refused by the style lint: ${styleViolation}` };
  }
  const ratioLeak = auditVagueRatios(parsed, f);
  if (ratioLeak !== null) {
    return { draft: fallback, receipt: receiptOf(dto), fallback: `delta run ${runId} refused by the disclosure audit: ${ratioLeak}` };
  }
  return { draft: parsed, receipt: receiptOf(dto), fallback: null };
}
