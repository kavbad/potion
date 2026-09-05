// Frontier Notes — THE DAILY LEDGER (F6, operator-directed 2026-09-03:
// "new content posted every single day").
//
// The doctrine problem this solves: the calendar never outranks the
// evidence (docs/RESEARCH-WRITING.md R4/E-rules), so a daily cadence must
// not manufacture daily findings. But the instruments DO something every
// day — the nightly scan screens listings, cycles measure candidates,
// recipes reach frontiers, the registry and prices move. So the daily
// UNIT is a ledger of what the instruments actually did, which is always
// true, and findings ride it only when they are real. A quiet day
// publishes a short, honest, quiet ledger.
//
// The factual surface is composed BY CODE from the day's rows: the model
// writes only the plain-words framing, and THE NUMBER LAW below refuses
// any figure in that framing which is not in the facts. So a daily note
// cannot carry an invented number even before Auditor sees it.
import { assertPublishable } from './redact.js';
import { publishableText } from './publish.js';
import type { Issue } from './types.js';
import { METHOD_NOTE, type Draft } from './write.js';

export interface DailyCycle {
  /** The new-model alias a scan-triggered cycle focused on, when it had one. */
  focusAlias: string | null;
  status: string;
  provenance: string;
  candidates: number;
  spendUsd: number;
}

export interface DailyFacts {
  /** UTC day id, '2026-09-03'. */
  day: string;
  at: string;
  /** Cycles that ran in the window (the measurement instrument's work). */
  cycles: DailyCycle[];
  /** Aliases measured today (focus aliases of the window's cycles). */
  measured: string[];
  /** Recipes that reached a frontier in the window — the promotions. */
  promoted: number;
  /** Models on the registry at the close of the day. */
  registrySize: number;
  pricesVersion: string;
  /** Live USD the instruments spent in the window. */
  spendUsd: number;
  /** True when nothing measurable happened — reported AS a quiet day. */
  quiet: boolean;
  caveats: string[];
}

/** THE PRICES LABEL (2026-09-04, found on the first live daily): the prices
 * version is an APPEND LOG — a 6,000-character concatenation of every alias
 * ever added ("2026-08-04-or2+tranche-…+or-solar-pro4+…"). Printed whole it
 * is unreadable AND it carries withheld model names, so the redaction pass
 * correctly HELD the day's first ledger. A version is provenance, not prose:
 * print its base and count the revisions. */
export function shortPricesLabel(version: string): string {
  const [base, ...rest] = version.split('+');
  const b = (base ?? version).slice(0, 40);
  return rest.length === 0 ? b : `${b} plus ${rest.length} revisions`;
}

/** Every number a daily draft is ALLOWED to state: the facts' own values,
 * in the spellings a writer would naturally use. */
export function permittedNumbers(f: DailyFacts): Set<string> {
  const vals: Array<number | string> = [
    f.cycles.length,
    f.measured.length,
    f.promoted,
    f.registrySize,
    ...f.cycles.map((c) => c.candidates),
    f.cycles.reduce((a, c) => a + c.candidates, 0),
    // The day itself and its parts are not claims.
    ...f.day.split('-'),
  ];
  const out = new Set<string>();
  for (const v of vals) {
    const s = String(v);
    out.add(s);
    if (/^\d+\.\d+$/.test(s)) out.add(s.replace(/0+$/, '').replace(/\.$/, ''));
    if (/^\d+$/.test(s)) { out.add(`${s}.0`); out.add(`${s}.00`); }
  }
  // 0 and 1 are structural in prose ("no cycles", "one alias"); the words
  // are checked by the count law upstream, the digits are always safe.
  out.add('0');
  out.add('1');
  // Every figure the CODE-COMPOSED ledger itself states is permitted — it
  // is true by construction, and a writer must be free to restate it
  // ("the last 24 hours", the prices version's digits).
  for (const m of dailyLedgerBody(f).join(' ').matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?![\w])/g)) out.add(m[1]!);
  return out;
}

/** THE NUMBER LAW (daily): a figure in the model's framing that is not in
 * the facts is a fabrication — refused deterministically, before Auditor.
 * Percentages and ×-ratios are refused outright: the daily ledger states
 * counts and dollars, never derived statistics. */
export function auditDailyNumbers(draft: Draft, facts: DailyFacts): string | null {
  const text = [draft.title, draft.summary, draft.plain, draft.lede, draft.takeaway].join(' ');
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(%|×|x\b)/gi)) {
    return `daily prose states a derived ratio ("${m[0].trim()}") — the ledger reports counts and dollars only`;
  }
  const allowed = permittedNumbers(facts);
  for (const m of text.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?![\w])/g)) {
    const raw = m[1]!;
    if (!allowed.has(raw) && !allowed.has(raw.replace(/0+$/, '').replace(/\.$/, ''))) {
      return `daily prose states "${raw}", which is not a number in today's ledger`;
    }
  }
  return null;
}

/** The ledger's own paragraphs — composed by code, always true. */
export function dailyLedgerBody(f: DailyFacts): string[] {
  const out: string[] = [];
  if (f.cycles.length === 0) {
    out.push(
      `No measurement cycle ran in the last 24 hours. The registry stands at ${f.registrySize} models on prices ${shortPricesLabel(f.pricesVersion)}. A quiet day is a real result: the instruments looked and found nothing worth measuring.`,
    );
  } else {
    const live = f.cycles.filter((c) => c.provenance === 'live').length;
    out.push(
      `${f.cycles.length} measurement ${f.cycles.length === 1 ? 'cycle' : 'cycles'} ran in the last 24 hours` +
        `${live > 0 ? ` (${live} against live providers)` : ''}, sweeping ${f.cycles.reduce((a, c) => a + c.candidates, 0)} candidate configurations.`,
    );
    if (f.measured.length > 0) {
      out.push(`Newly listed models measured today: ${f.measured.join(', ')}.`);
    }
    out.push(
      f.promoted === 0
        ? 'No recipe reached a frontier today: every candidate measured was beaten by an option already on the board. Most measurement days end this way, and that is the point of measuring.'
        : `${f.promoted} ${f.promoted === 1 ? 'recipe' : 'recipes'} reached a frontier today — the routed choice for that work changed.`,
    );
  }
  out.push(
    `Registry: ${f.registrySize} models, prices ${shortPricesLabel(f.pricesVersion)}. Every figure here is the instrument's own count for the day; nothing is estimated.`,
  );
  return out;
}

/** The deterministic daily draft — always available, always true. The model
 * writer improves the framing; it never supplies a number. */
export function deterministicDailyDraft(f: DailyFacts): Draft {
  const title = f.quiet
    ? 'A quiet day on the frontier: nothing measured, nothing moved.'
    : f.promoted === 0
      ? `${f.cycles.length} ${f.cycles.length === 1 ? 'cycle' : 'cycles'} measured today; no frontier changed.`
      : `${f.promoted} ${f.promoted === 1 ? 'recipe' : 'recipes'} reached a frontier today.`;
  const body = dailyLedgerBody(f);
  const plain = f.quiet
    ? 'Potion keeps a scoreboard of AI models: how well each does a kind of work, and what it costs. Today the instruments ran and found nothing new worth measuring, so nothing on the scoreboard changed. Quiet days are reported too.'
    : `Potion measures AI models continuously to find which ones are the best value for each kind of work. Today the instruments measured new candidates and ${f.promoted === 0 ? 'none of them beat what is already on the scoreboard' : 'the scoreboard changed'}.`;
  return {
    title,
    summary: body[0]!.slice(0, 275),
    plain,
    lede: body.join(' '),
    frontierNote: body[body.length - 1]!,
    auditionNote: f.measured.length > 0 ? `Measured today: ${f.measured.join(', ')}.` : 'No newly listed model was measured today.',
    mixingNote: '',
    takeaway: f.quiet
      ? 'Nothing you route changed today. The value of a daily check is knowing that for certain rather than assuming it.'
      : 'If you pay per request, a frontier change is the day your cheapest acceptable option moves. Days without one are days your current choice still holds.',
    faq: [],
  };
}

/** UTC day id for a date — the daily issue's address and filename. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface DailyRow {
  focusAlias: string | null;
  status: string;
  provenance: string;
  candidates: number;
  spendUsd: number;
  createdAt: Date | string;
}

/** Compose the day's facts from the instruments' own rows. Pure: the caller
 * fetches, so this stays testable and the workers package stays honest
 * about where numbers come from. */
export function composeDailyFacts(input: {
  now: Date;
  cycles: readonly DailyRow[];
  promoted: number;
  registrySize: number;
  pricesVersion: string;
}): DailyFacts {
  const since = input.now.getTime() - 24 * 60 * 60 * 1000;
  const inWindow = input.cycles.filter((c) => new Date(c.createdAt).getTime() >= since);
  const cycles: DailyCycle[] = inWindow.map((c) => ({
    focusAlias: c.focusAlias,
    status: c.status,
    provenance: c.provenance,
    candidates: c.candidates,
    spendUsd: c.spendUsd,
  }));
  const measured = [...new Set(cycles.map((c) => c.focusAlias).filter((a): a is string => a !== null && a !== ''))];
  const spendUsd = Math.round(cycles.reduce((a, c) => a + c.spendUsd, 0) * 1e6) / 1e6;
  return {
    day: utcDay(input.now),
    at: input.now.toISOString(),
    cycles,
    measured,
    promoted: input.promoted,
    registrySize: input.registrySize,
    pricesVersion: input.pricesVersion,
    spendUsd,
    quiet: cycles.length === 0 && input.promoted === 0,
    caveats: [
      'The daily ledger reports what the measurement instruments did in the last 24 hours; it is not a re-measurement of the frontier. The weekly issue carries that.',
      'A quiet day is published as a quiet day: the absence of a change is a measured result, never padding.',
    ],
  };
}

/** Assemble a daily issue — same redaction gate as the weekly, its own
 * shape (body paragraphs, no FactSheet). */
export function assembleDailyIssue(
  facts: DailyFacts,
  draft: Draft,
  opts: { publishedAt: string; byline?: string; writer: Issue['writer']; extraNeverName?: readonly string[] },
): Issue {
  const base: Omit<Issue, 'status' | 'heldReason'> = {
    slug: facts.day,
    week: facts.day,
    kind: 'daily',
    body: dailyLedgerBody(facts).join('\n\n'),
    title: draft.title,
    summary: draft.summary,
    publishedAt: opts.publishedAt,
    byline: opts.byline ?? 'Potion Research',
    plain: draft.plain,
    lede: draft.lede,
    frontierNote: draft.frontierNote,
    auditionNote: draft.auditionNote,
    mixingNote: draft.mixingNote,
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

/** THE DAILY PARSER (2026-09-04): parseDraft is the WEEKLY shape and
 * requires exactly three FAQ entries — a daily has none by design, so every
 * daily framing would have failed its parse and the Delta byline was
 * unreachable no matter what the writer produced. Found by the test written
 * for the read-after-write race, one layer down from it. Same discipline as
 * parseDraft otherwise: the title and the plain-words opening must be the
 * model's own; secondary fields fall back to the composed ledger. */
export function parseDailyDraft(text: string, fallback: Draft): Draft | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Partial<Draft>;
    const s = (k: keyof Draft): string | null => {
      const v = o[k];
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    };
    const title = s('title');
    const plain = s('plain');
    if (title === null || plain === null) return null;
    return {
      title,
      plain,
      summary: s('summary') ?? fallback.summary,
      lede: s('lede') ?? fallback.lede,
      frontierNote: s('frontierNote') ?? fallback.frontierNote,
      auditionNote: s('auditionNote') ?? fallback.auditionNote,
      // A daily carries no mixing note and no FAQ, ever.
      mixingNote: '',
      takeaway: s('takeaway') ?? fallback.takeaway,
      faq: [],
    };
  } catch {
    return null;
  }
}
