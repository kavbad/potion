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
import { claimKey, money, ratio, type AgendaCandidate } from './agenda.js';
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

/** A NAME IS NOT A CLAIM (found live 2026-09-04, run-0a9de197).
 *
 * Model names carry version numbers — `grok-4.6`, `gpt-5`, `llama-3.3-70b`
 * — and the law read those digits as figures the piece had invented. Since
 * every piece worth publishing names the models it compares, the law was
 * refusing essentially every draft and the composed fallback published in
 * its place, every day. Names are removed before the figures are read: the
 * candidate's own names first, then anything shaped like a versioned slug. */
const VERSIONED_SLUG = /[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*[.-]v?\d+(?:\.\d+)*[A-Za-z]*/g;

function stripNames(text: string, c: AgendaCandidate): string {
  let out = text;
  for (const v of Object.values(c.evidence)) {
    if (typeof v !== 'string' || v.length < 2) continue;
    out = out.split(v).join(' ');
  }
  return out.replace(VERSIONED_SLUG, ' ');
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

  const text = stripNames([draft.title, draft.summary, draft.plain, draft.lede, draft.frontierNote, draft.auditionNote, draft.takeaway].join(' '), c);
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

/** A number is a figure a reader can act on; `topCostPer1K: 6.8463` is a
 * field name. The fallback used to print the evidence object as a
 * semicolon-separated dict, which read like a stack trace in the middle of
 * a paragraph (found live 2026-09-04). Each kind now gets sentences. */
const num = (v: unknown, f: (x: number) => string): string => (typeof v === 'number' ? f(v) : String(v ?? ''));
const usd = (v: unknown) => num(v, money);

/** The reading: how to hold the finding, in the writer's absence. */
function reading(c: AgendaCandidate): string {
  const e = c.evidence;
  switch (c.kind) {
    case 'quality-premium':
      return `The premium buys ${num(e.qualityPoints, (x) => x.toFixed(1))} quality points on this suite. Whether that is worth ${num(e.factor, ratio)} the price depends on what a failure costs you: at high volume with a cheap retry, it usually is not; on work that ships unreviewed, it can be.`;
    case 'cheapest-at-floor':
      return `${num(e.clearingCount, String)} models clear the bar, so the choice is not between quality and price — it is between ${usd(e.cheapestCostPer1K)} and ${usd(e.dearestCostPer1K)} for the same measured outcome. Paying the top of that range buys nothing this suite can detect.`;
    case 'head-to-head':
      return `Both were run against the same held-out items on the same day, so the gap is a property of the models rather than of the test. A ${num(e.factor, ratio)} price difference at this quality distance is the whole decision.`;
    case 'price-outlier':
      return `Price is set by what a provider can charge, not by what a model scores. ${num(e.factor, ratio)} is what that gap costs a buyer who picks on reputation.`;
    case 'category-explainer':
      return `New listings are priced against the field they enter, not against what they cost to serve. The direction of that gap is the clearest signal available about where the market thinks it is heading.`;
    default:
      return `The comparison holds only for the workload measured here; a different quality requirement moves the answer.`;
  }
}

/** The deterministic piece: the agenda's own headline and dek, the evidence
 * read plainly, the footer. Always publishable, always worth reading —
 * unlike the chore log it replaces, it answers a real question. */
export function deterministicPiece(c: AgendaCandidate, footer: string): Draft {
  const n = typeof c.evidence.n === 'number' ? c.evidence.n : 0;
  const basis =
    n > 0 && ['quality-premium', 'cheapest-at-floor', 'head-to-head', 'price-outlier'].includes(c.kind) && c.clusterId !== 'catalogue'
      ? `Both figures come from the same held-out ${c.clusterId.replace(/-/g, ' ')} suite, ${n} scored items, measured the same way — so the comparison is like for like.`
      : `The figures come from Potion's model catalogue as listed, covering ${n} models.`;
  return {
    title: `${c.headline}.`,
    summary: c.dek,
    plain: `${c.dek} ${basis}`,
    lede: reading(c),
    frontierNote: '',
    auditionNote: footer,
    mixingNote: '',
    takeaway: `Someone is paying the difference. If that is you, the question worth asking is which of these two numbers your workload actually needs — and this is the measurement that answers it.`,
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
    // The body IS the article, in reading order: the finding, how to read
    // it, what to do about it, then the provenance line. Rendering `plain`
    // separately printed the opening sentence twice on every surface.
    body: [draft.plain, draft.lede, draft.takeaway, draft.auditionNote].filter(Boolean).join('\n\n'),
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
