// THE PIECE (F8, operator-directed 2026-09-04: "kill the ledger, wire the
// agenda into the daily").
//
// The daily post is no longer a report of what the instruments did. It is
// the top item on Atlas's agenda: a question somebody is asking, answered
// with numbers we measured. The ledger survives only as a closing line —
// provenance, never the headline.
//
// The evidence discipline is the same one that has held all week, tightened:
// the writer receives the candidate's evidence and NOTHING else, and THE
// PIECE NUMBER LAW refuses any figure in the prose that is not one of those
// values (in any reasonable spelling). A piece cannot carry an invented
// number, and it cannot reach past its own claim.
import { claimKey, type AgendaCandidate } from './agenda.js';
import { assertPublishable } from './redact.js';
import { publishableText } from './publish.js';
import type { Issue } from './types.js';
import { METHOD_NOTE, type Draft } from './write.js';

/** Every spelling of a permitted figure: the raw value, its rounded and
 * fixed forms, and its percentage form for a 0–1 quality. */
function spellings(v: number): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    if (s === '' || s === '-') return;
    out.add(s);
    if (s.includes('.')) out.add(s.replace(/0+$/, '').replace(/\.$/, ''));
  };
  add(String(v));
  for (const d of [0, 1, 2, 3, 4]) add(v.toFixed(d));
  add(String(Math.round(v)));
  if (v > 0 && v <= 1) {
    const pct = v * 100;
    for (const d of [0, 1, 2]) add(pct.toFixed(d));
  }
  // Large factors are commonly written with a thousands separator.
  if (v >= 1000) add(Math.round(v).toLocaleString('en-US'));
  return [...out];
}

/** THE PIECE NUMBER LAW: the writer may state the candidate's figures and
 * nothing else. (Years, sample sizes and the current date are permitted
 * because they are provenance, not claims.) */
export function auditPieceNumbers(draft: Draft, c: AgendaCandidate, now: Date): string | null {
  const allowed = new Set<string>();
  for (const v of Object.values(c.evidence)) {
    if (typeof v === 'number') for (const s of spellings(v)) allowed.add(s);
  }
  // Structural numbers a writer legitimately uses.
  for (const s of ['0', '1', '2', '3', '4', '5', '10', '100', '1000', '95']) allowed.add(s);
  for (const s of [String(now.getUTCFullYear()), now.toISOString().slice(0, 10), String(now.getUTCMonth() + 1), String(now.getUTCDate())]) allowed.add(s);
  // The deterministic headline and dek are code-composed from the evidence,
  // so every figure they contain is permitted by construction.
  for (const m of `${c.headline} ${c.dek}`.matchAll(/(?<![\w.])(\d+(?:[.,]\d+)?)(?![\w])/g)) allowed.add(m[1]!.replace(/,/g, ''));

  const text = [draft.title, draft.summary, draft.plain, draft.lede, draft.frontierNote, draft.auditionNote, draft.takeaway].join(' ');
  for (const m of text.matchAll(/(?<![\w.$])(\d+(?:[.,]\d+)?)(?![\w])/g)) {
    const raw = m[1]!.replace(/,/g, '');
    if (allowed.has(raw)) continue;
    const trimmed = raw.includes('.') ? raw.replace(/0+$/, '').replace(/\.$/, '') : raw;
    if (allowed.has(trimmed)) continue;
    return `the piece states "${m[1]}", which is not in its evidence`;
  }
  return null;
}

/** The measurement footer: the ledger, demoted to provenance. One line. */
export function measurementFooter(f: { cycles: unknown[]; measured: string[]; promoted: number }): string {
  if (f.cycles.length === 0) return 'No new measurement cycle ran in the last 24 hours; the figures above are from the standing corpus.';
  const bits = [`${f.cycles.length} measurement ${f.cycles.length === 1 ? 'cycle' : 'cycles'} ran in the last 24 hours`];
  if (f.measured.length > 0) bits.push(`${f.measured.length} newly listed ${f.measured.length === 1 ? 'model was' : 'models were'} measured`);
  bits.push(f.promoted === 0 ? 'no recipe reached a frontier' : `${f.promoted} reached a frontier`);
  return `${bits.join(', ')}.`;
}

/** The deterministic piece: the agenda's own headline and dek, the evidence
 * stated plainly, the footer. Always publishable, always worth reading —
 * unlike the chore log it replaces, it answers a real question. */
export function deterministicPiece(c: AgendaCandidate, footer: string): Draft {
  const ev = Object.entries(c.evidence)
    .filter(([k]) => k !== 'n')
    .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${typeof v === 'number' ? (Number.isInteger(v) ? v : Number(v.toFixed(4))) : v}`)
    .join('; ');
  return {
    title: `${c.headline}.`,
    summary: c.dek,
    plain: `${c.dek} Both numbers come from the same held-out suite, measured the same way, so the comparison is like for like.`,
    lede: `${c.dek} The measurement covers ${c.evidence.n ?? 0} scored items.`,
    frontierNote: `Measured evidence — ${ev}.`,
    auditionNote: footer,
    mixingNote: '',
    takeaway: `If you pay for inference by the request, this is the number that decides whether the expensive option is worth buying for this kind of work. It is only a verdict for your workload if your quality requirement matches the one measured here.`,
    faq: [],
  };
}

/** Assemble the day's piece. Same redaction gate as everything else; the
 * agenda metadata rides the issue so the corpus itself remembers what has
 * been claimed (the cooldown reads it back). */
export function assemblePieceIssue(
  c: AgendaCandidate,
  draft: Draft,
  day: string,
  opts: { publishedAt: string; byline?: string; writer: Issue['writer']; extraNeverName?: readonly string[] },
): Issue {
  const base: Omit<Issue, 'status' | 'heldReason'> = {
    slug: day,
    week: day,
    kind: 'daily',
    body: [draft.lede, draft.frontierNote, draft.takeaway, draft.auditionNote].filter(Boolean).join('\n\n'),
    agenda: { id: c.id, kind: c.kind, clusterId: c.clusterId, demandQuery: c.demandQuery, score: c.score, claimKey: claimKey(c.clusterId, c.evidence) },
    title: draft.title,
    summary: draft.summary,
    publishedAt: opts.publishedAt,
    byline: opts.byline ?? 'Potion Research',
    plain: draft.plain,
    lede: draft.lede,
    frontierNote: draft.frontierNote,
    auditionNote: draft.auditionNote,
    mixingNote: '',
    takeaway: draft.takeaway,
    method: METHOD_NOTE,
    faq: [],
    facts: null,
    writer: opts.writer,
  };
  try {
    assertPublishable(publishableText(base), opts.extraNeverName);
  } catch (e) {
    return { ...base, status: 'held', heldReason: e instanceof Error ? e.message : String(e) };
  }
  return { ...base, status: 'published' };
}

/** The claims the published corpus already carries — the cooldown's memory.
 * Reads the issues themselves, so the record is the only state. */
export function publishedClaims(issues: readonly Issue[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of issues) {
    if (!i.agenda) continue;
    const at = i.publishedAt;
    const prev = out.get(i.agenda.id);
    if (prev === undefined || Date.parse(at) > Date.parse(prev)) out.set(i.agenda.id, at);
    if (i.agenda.claimKey !== undefined) {
      const p2 = out.get(i.agenda.claimKey);
      if (p2 === undefined || Date.parse(at) > Date.parse(p2)) out.set(i.agenda.claimKey, at);
    }
  }
  return out;
}
