// Claude Code session transcripts → SPEC §14.1 trace spans (G2.8).
//
// This is the capstone's onboarding adapter: it takes a real agent workload
// that knows nothing about Potion's conventions and produces the span shape
// POST /v1/traces accepts. It is also the honest test of whether that shape is
// actually reachable from a real exporter's data.
//
// TWO RULES THIS FILE EXISTS TO KEEP:
//
// 1. FAITHFUL. One tool span per tool call, in order, with the real args and
//    results. It would be easy to collapse repeated calls here and hand the
//    clustering stage a tidy workload — and that is precisely what would have
//    hidden the tool-signature defect G2.8 found (48 real sessions produced 45
//    distinct raw signatures, i.e. one cluster each). The adapter reports the
//    workload as it is; the platform learns to handle it.
//
// 2. SCRUBBED BEFORE IT LEAVES. The platform redacts at ingest
//    (`redactAttrs`/`redactPii`), but that is the SECOND line. Agent
//    transcripts are dense with credentials — measured on this machine's own
//    corpus: `sk-or-v1-` ×2, `sk-proj-` ×5, `OPENROUTER_API_KEY` ×48,
//    `Bearer` ×363 — so anything key-shaped dies here, before the network
//    call, and `--verify-scrub` re-reads the generated batches and refuses to
//    emit if a pattern survived. Defence in depth means the outer layer does
//    not get to assume the inner one works.
//
// The source transcripts are opened READ-ONLY and never modified.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Secret scrubbing — first line of defence, ahead of the platform redactor
// ---------------------------------------------------------------------------

/**
 * Credential shapes, ordered specific → generic (the `redactPii` convention,
 * so a specific match is not eaten by a broad one).
 *
 * Deliberately over-broad: `pk_` matches this repo's own test fixtures
 * (`pk_keys_test_admin_a`) as well as real minted keys, and scrubbing a
 * fixture costs nothing. A scrubber that tries to be clever about which
 * secrets are "real" is a scrubber that eventually guesses wrong.
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp; replacement: string }> = [
  { name: 'openrouter-key', re: /sk-or-v1-[A-Za-z0-9]{16,}/g, replacement: '<secret:openrouter>' },
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{16,}/g, replacement: '<secret:anthropic>' },
  { name: 'openai-project-key', re: /sk-proj-[A-Za-z0-9_-]{16,}/g, replacement: '<secret:openai>' },
  { name: 'generic-sk-key', re: /\bsk-[A-Za-z0-9_-]{20,}/g, replacement: '<secret:sk>' },
  { name: 'potion-api-key', re: /\bpk_[A-Za-z0-9_]{4,}/g, replacement: '<secret:potion-key>' },
  // Step 10 grant-shaped credentials — keep in sync with the REJECTING copy
  // in packages/lab-spec/src/security.ts (that file's header explains the
  // deliberate duplication; the lab-spec corpus pins both directions).
  { name: 'github-token', re: /\bgh[opsur]_[A-Za-z0-9]{16,}/g, replacement: '<secret:github>' },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: '<secret:github-pat>' },
  { name: 'linear-key', re: /\blin_(?:api|oauth)_[A-Za-z0-9]{16,}/g, replacement: '<secret:linear>' },
  {
    name: 'bearer-token',
    re: /\b(Bearer|bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/g,
    replacement: 'Bearer <secret:bearer>',
  },
  // `OPENROUTER_API_KEY=sk-...` and friends — catches the assignment even when
  // the value itself does not match a known key shape.
  //
  // The `(?!['"]?<secret)` lookahead is load-bearing, not cosmetic: without it
  // the pattern matches its OWN output (`OPENROUTER_API_KEY=<secret:openrouter>`,
  // produced a moment earlier by the key patterns above), which makes
  // findSecrets report a survivor on correctly-scrubbed text — and
  // `--verify-scrub` would then refuse every clean run. A verifier that cannot
  // recognise a successful scrub is worse than no verifier: it trains you to
  // pass `--no-verify-scrub`.
  //
  // It matches `<secret` WITHOUT the colon on purpose. A placeholder can be
  // chopped by the length cap into `<secret` + truncation marker, and the
  // real corpus produced exactly that (`SERVE_KEY='<secret…[+N chars]`). The
  // value there is already safe — a severed placeholder carries no key
  // material — so requiring the colon only manufactures false refusals. The
  // optional quote covers `KEY='<secret:…'`, which the corpus also produced.
  {
    name: 'env-assignment',
    re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS))\s*=\s*(?!['"]?<secret)("[^"\n]*"|'[^'\n]*'|[^\s"';|&]+)/g,
    replacement: '$1=<secret:env>',
  },
];

/**
 * Scrub, THEN truncate. The order is a security property, not a style choice.
 *
 * Truncating first can cut a credential in half and leave a fragment short
 * enough that no pattern recognises it — `sk-or-v1-0123` matches nothing, but
 * it is still key material, and `--verify-scrub` would pass it. Found exactly
 * this way on the real corpus: a truncated `SERVE_KEY='pk_…` fragment survived
 * both the specific pattern (too short to match) and the env rule.
 *
 * A scrubbed string, by contrast, is safe to cut at any offset: the worst case
 * is a chopped placeholder.
 */
function safe(s: string, n = TOOL_PAYLOAD_CAP): string {
  return dropPartialPlaceholder(cap(scrubSecrets(s), n));
}

/**
 * Remove a placeholder the length cap severed mid-token.
 *
 * The cap can cut anywhere, including inside `<secret:potion-key>`, leaving
 * `<secre` — safe (no key material) but unrecognisable to the verifier, which
 * then reports a survivor and refuses a clean run. Chasing this with a longer
 * lookahead is a losing game: the cut can land after `<`, `<s`, `<se`… so the
 * fix is to make the cut itself placeholder-safe.
 *
 * If the tail holds a `<` with no `>` after it, the string is trimmed back to
 * that `<`. Found on the real corpus, where the cap landed inside a scrubbed
 * `SERVE_KEY='<secret:…'`.
 */
function dropPartialPlaceholder(s: string): string {
  const lastOpen = s.lastIndexOf('<');
  if (lastOpen === -1) return s;
  if (s.indexOf('>', lastOpen) !== -1) return s; // closed — a whole placeholder
  return s.slice(0, lastOpen);
}

/** Replace every credential shape in `text`. Deterministic and idempotent:
 * running it twice yields the same string (the placeholders match nothing). */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const { re, replacement } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), replacement);
  }
  return out;
}

/** Which credential shapes survive in `text` — the `--verify-scrub` oracle.
 * Returns pattern NAMES, never the matched values. */
export function findSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (new RegExp(re.source, re.flags).test(text)) hits.push(name);
  }
  return hits;
}

/**
 * Which credential shapes survive anywhere in a STRUCTURE — the real
 * `--verify-scrub` oracle.
 *
 * Walks string leaves rather than scanning `JSON.stringify(spans)`, because
 * the serialized form lets a quoted pattern run across value boundaries and
 * match a quote from an unrelated span three objects later. On the real corpus
 * that produced a refusal for a payload that was entirely clean — a false
 * alarm, and false alarms are how a safety gate gets switched off. The
 * verifier must inspect the same units the scrubber operates on.
 */
export function findSecretsDeep(value: unknown): string[] {
  const hits = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const name of findSecrets(v)) hits.add(name);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...hits];
}

/** Recursively scrub every string leaf. Keys are left alone (they are
 * structure, and `tool.name`-style keys drive tool detection downstream). */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubDeep(v);
    return out as unknown as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Transcript shape (the subset this adapter reads)
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
}

interface TranscriptRecord {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

export interface TraceSpanPayload {
  trace_id: string;
  span_id: string;
  parent_id?: string;
  name: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  attributes?: Record<string, unknown>;
  ts?: string;
}

/** Tool args/results are transcript-sized (a Bash result can be megabytes).
 * The platform truncates again at 2000 for embedding; this keeps the POST
 * body sane without losing the shape of the call. */
export const TOOL_PAYLOAD_CAP = 1500;

function cap(s: string, n = TOOL_PAYLOAD_CAP): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[+${s.length - n} chars]`;
}

function asText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('\n');
}

function parseJsonl(text: string): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      out.push(JSON.parse(t) as TranscriptRecord);
    } catch {
      // A partially-flushed final line is normal in a live transcript.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export interface SessionConversion {
  traceId: string;
  spans: TraceSpanPayload[];
  /** Distinct tools in first-use order — what the cluster signature buckets
   * on after G2.8. Reported so the operator can predict clustering. */
  toolSignature: string[];
  toolCalls: number;
  /** Text-producing model calls (llm.call spans emitted) — the step-item
   * budget this session contributes before sampling. */
  llmCalls: number;
  hasReference: boolean;
  models: string[];
}

/**
 * One Claude Code session → one trace.
 *
 * Span layout follows SPEC §14.1's payload conventions exactly:
 *   agent.root   `gen_ai.prompt`     — the task prompt (embedding text, turn 1)
 *   tool.<Name>  `tool.args`/`tool.result` + `gen_ai.operation.name`
 *   llm.call     `gen_ai.completion` — ONE span per text-producing model call
 *                (post-capstone item 2 / Decision 1): per-call model, per-call
 *                usage, `potion.step_index`. These are what step-level item
 *                synthesis consumes — the pre-v2 layout summed usage across
 *                all assistant turns and kept only the last text, which is
 *                why whole-session replay was the only measurement possible.
 *                Text-producing calls only: a pure tool-dispatch turn has no
 *                judgeable completion; its activity is in the tool spans.
 *   chat         `gen_ai.completion` — the FINAL assistant text (unchanged;
 *                every pre-v2 consumer — clustering turns, session reference,
 *                tool signatures — reads exactly what it read before)
 *
 * The completion matters more than it looks: it becomes the derived replay
 * item's `reference`, which is what makes the suite REFERENCE-ANCHORED — the
 * only judging configuration this project has measured above the 0.8 trust bar
 * (G1.4: sonnet pearson 0.948 anchored vs 0.544 reference-free).
 */
export function sessionToSpans(
  records: TranscriptRecord[],
  opts: { traceId: string; sessionLabel?: string },
): SessionConversion {
  const { traceId } = opts;
  const spans: TraceSpanPayload[] = [];

  // The task prompt: the first user record carrying real text. Subsequent
  // user records are tool results, not turns.
  let prompt = '';
  for (const r of records) {
    if (r.type !== 'user') continue;
    const text = asText(r.message?.content);
    if (text.trim() !== '') {
      prompt = text;
      break;
    }
  }

  // Tool results are keyed by tool_use_id across the whole session.
  const resultById = new Map<string, string>();
  for (const r of records) {
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      resultById.set(
        b.tool_use_id,
        typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
      );
    }
  }

  const firstTs = records.find((r) => typeof r.timestamp === 'string')?.timestamp;
  const rootTs = firstTs ?? new Date(0).toISOString();

  spans.push({
    trace_id: traceId,
    span_id: `${traceId}_root`,
    name: 'agent.root',
    attributes: { 'gen_ai.prompt': safe(prompt, 8000) },
    ts: rootTs,
  });

  // Tool spans, in call order. FAITHFUL: no collapsing (see the header).
  const toolSignature: string[] = [];
  const seenTool = new Set<string>();
  let toolIdx = 0;
  let inTokens = 0;
  let outTokens = 0;
  const models = new Set<string>();
  let finalText = '';
  let lastTs = rootTs;

  let stepIdx = 0;
  for (const r of records) {
    if (r.type !== 'assistant') continue;
    const msg = r.message;
    if (msg?.model !== undefined && msg.model !== '<synthetic>') models.add(msg.model);
    inTokens += msg?.usage?.input_tokens ?? 0;
    outTokens += msg?.usage?.output_tokens ?? 0;
    if (typeof r.timestamp === 'string') lastTs = r.timestamp;

    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    const text = asText(content);
    if (text.trim() !== '') {
      finalText = text; // last non-empty wins (session reference, unchanged)
      // llm.call: the per-call record step-level synthesis consumes. Same ts
      // as this record's tool spans; span_id 's' sorts before 't' at equal
      // ts, matching reality (the assistant text precedes its tool calls).
      stepIdx += 1;
      spans.push({
        trace_id: traceId,
        span_id: `${traceId}_s${stepIdx}`,
        parent_id: `${traceId}_root`,
        name: 'llm.call',
        ...(msg?.model !== undefined && msg.model !== '<synthetic>' ? { model: msg.model } : {}),
        input_tokens: msg?.usage?.input_tokens ?? 0,
        output_tokens: msg?.usage?.output_tokens ?? 0,
        attributes: {
          'gen_ai.operation.name': 'llm_call',
          'gen_ai.completion': safe(text, 8000),
          'potion.step_index': stepIdx,
        },
        ts: typeof r.timestamp === 'string' ? r.timestamp : rootTs,
      });
    }

    for (const b of content) {
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      toolIdx += 1;
      if (!seenTool.has(b.name)) {
        seenTool.add(b.name);
        toolSignature.push(b.name);
      }
      const result = b.id !== undefined ? resultById.get(b.id) : undefined;
      spans.push({
        trace_id: traceId,
        span_id: `${traceId}_t${toolIdx}`,
        parent_id: `${traceId}_root`,
        name: `tool.${b.name}`,
        attributes: {
          // Both markers: the platform detects a tool span by EITHER the
          // `execute_tool` operation OR the `tool.` name prefix, and an
          // adapter should not depend on which check runs first.
          'gen_ai.operation.name': 'execute_tool',
          'tool.name': b.name,
          'tool.args': safe(typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {})),
          ...(result !== undefined ? { 'tool.result': safe(result) } : {}),
        },
        ts: typeof r.timestamp === 'string' ? r.timestamp : rootTs,
      });
    }
  }

  spans.push({
    trace_id: traceId,
    span_id: `${traceId}_chat`,
    parent_id: `${traceId}_root`,
    name: 'chat',
    // The REAL model id, not a price-table alias. Unknown models price at $0
    // at ingest — a true statement about onboarding (a customer's models must
    // be priced before cost attribution means anything), and a finding worth
    // more than a fabricated cost.
    ...(models.size > 0 ? { model: [...models][0]! } : {}),
    input_tokens: inTokens,
    output_tokens: outTokens,
    attributes: { 'gen_ai.completion': safe(finalText, 8000) },
    ts: lastTs,
  });

  return {
    traceId,
    // Every payload already went through safe() (scrub-then-truncate). This
    // second pass is belt-and-braces: it catches any field a future edit adds
    // without routing it through safe(). Scrubbing is idempotent, so the
    // double pass costs nothing and changes nothing.
    spans: scrubDeep(spans),
    toolSignature,
    toolCalls: toolIdx,
    llmCalls: stepIdx,
    hasReference: finalText.trim() !== '',
    models: [...models],
  };
}

/** Stable trace id from the transcript's filename. */
export function traceIdForFile(file: string): string {
  return `cc-${createHash('sha1').update(path.basename(file)).digest('hex').slice(0, 12)}`;
}

export function convertFile(file: string): SessionConversion {
  const records = parseJsonl(readFileSync(file, 'utf8'));
  return sessionToSpans(records, { traceId: traceIdForFile(file), sessionLabel: path.basename(file) });
}

/** SPEC §14.1 caps a batch at 500 spans; long sessions chunk across POSTs
 * (ingest is idempotent on (org, trace, span), so chunking is free). */
export const TRACES_BATCH_CAP = 500;

export function chunkSpans(spans: TraceSpanPayload[], size = TRACES_BATCH_CAP): TraceSpanPayload[][] {
  const out: TraceSpanPayload[][] = [];
  for (let i = 0; i < spans.length; i += size) out.push(spans.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface ConvertOptions {
  dir: string;
  outDir?: string;
  apiUrl?: string;
  apiKey?: string;
  dryRun: boolean;
  verifyScrub: boolean;
  limit?: number;
}

export function listTranscripts(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => path.join(dir, f));
}

export async function runConvert(opts: ConvertOptions): Promise<{
  sessions: number;
  spans: number;
  toolSignatures: Record<string, number>;
  withReference: number;
  posted: number;
  duplicates: number;
}> {
  const files = listTranscripts(opts.dir).slice(0, opts.limit ?? Infinity);
  if (files.length === 0) throw new Error(`no .jsonl transcripts under ${opts.dir}`);

  const conversions = files.map(convertFile);
  const allSpans = conversions.flatMap((c) => c.spans);

  // --verify-scrub: re-read the GENERATED payload (not the source) and refuse
  // to go further if anything key-shaped survived. The scrubber checking its
  // own output is the point — a bug in a pattern shows up here, not on a
  // provider's servers.
  if (opts.verifyScrub) {
    const survivors = findSecretsDeep(allSpans);
    if (survivors.length > 0) {
      throw new Error(
        `SCRUB VERIFICATION FAILED: credential shapes survived conversion ` +
          `[${survivors.join(', ')}] — refusing to emit or POST. Nothing was sent.`,
      );
    }
  }

  const toolSignatures: Record<string, number> = {};
  for (const c of conversions) {
    const key = c.toolSignature.join('>') || 'chat';
    toolSignatures[key] = (toolSignatures[key] ?? 0) + 1;
  }
  const withReference = conversions.filter((c) => c.hasReference).length;

  let posted = 0;
  let duplicates = 0;

  if (opts.dryRun) {
    const outDir = opts.outDir ?? 'artifacts';
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, 'g28-trace-batches.json');
    writeFileSync(
      target,
      `${JSON.stringify({ sessions: conversions.length, batches: chunkSpans(allSpans) }, null, 2)}\n`,
    );
    console.log(`dry-run: wrote ${allSpans.length} spans to ${target} — nothing POSTed`);
  } else {
    if (opts.apiUrl === undefined || opts.apiKey === undefined) {
      throw new Error('--api-url and --api-key are required unless --dry-run');
    }
    for (const batch of chunkSpans(allSpans)) {
      const res = await fetch(`${opts.apiUrl}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ spans: batch }),
      });
      if (!res.ok) throw new Error(`POST /v1/traces → HTTP ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { accepted: number; duplicates: number };
      posted += body.accepted;
      duplicates += body.duplicates;
    }
  }

  return {
    sessions: conversions.length,
    spans: allSpans.length,
    toolSignatures,
    withReference,
    posted,
    duplicates,
  };
}

function parseArgs(argv: string[]): ConvertOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = get('--dir');
  if (dir === undefined) throw new Error('--dir <transcript directory> is required');
  const limit = get('--limit');
  return {
    dir,
    ...(get('--out') !== undefined ? { outDir: get('--out')! } : {}),
    ...(get('--api-url') !== undefined ? { apiUrl: get('--api-url')! } : {}),
    ...(get('--api-key') !== undefined ? { apiKey: get('--api-key')! } : {}),
    dryRun: argv.includes('--dry-run'),
    // Verification is ON unless explicitly disabled — the safe default is the
    // one that refuses.
    verifyScrub: !argv.includes('--no-verify-scrub'),
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`;

if (isMain) {
  runConvert(parseArgs(process.argv.slice(2)))
    .then((r) => {
      console.log(`sessions      : ${r.sessions}`);
      console.log(`spans         : ${r.spans}`);
      console.log(`with reference: ${r.withReference}/${r.sessions}`);
      console.log('tool signatures (canonical — what clustering buckets on):');
      for (const [sig, n] of Object.entries(r.toolSignatures).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(3)}  ${sig}`);
      }
      if (!r.posted && !r.duplicates) return;
      console.log(`posted        : ${r.posted} accepted, ${r.duplicates} duplicate`);
    })
    .catch((e: unknown) => {
      console.error(`\nREFUSED: ${(e as Error).message}\n`);
      process.exit(2);
    });
}
