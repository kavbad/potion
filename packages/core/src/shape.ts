// Request SHAPE (S7 L1) — the content-free description of a served request.
//
// Serving already knows what a request LOOKS LIKE and records none of it:
// request_logs keeps the cluster the router picked and nothing about the
// envelope. That absence has a concrete cost. A cluster's frontier can be
// fully measured on tool-free items and be the wrong evidence for half the
// traffic in it, and nothing in the database can say so — the measurement
// and the demand are never compared on the axis where they disagree.
//
// EVERY FIELD HERE IS A COUNT, A FLAG, OR A CALLER-CHOSEN NUMBER. Nothing
// reads a character of message content; the only content-derived value is a
// coarse total LENGTH bucket, which is a size and not a subject. That is the
// property that lets shapes be aggregated across orgs at all (S7 §4 D1), and
// it is pinned by test: two requests with completely different text and the
// same structure produce the same shape.
import type { ChatMessage, ToolChoice } from './types.js';

/** Coarse total-content-length buckets, in characters. */
export const CHAR_BUCKETS: readonly { readonly label: string; readonly max: number }[] = [
  { label: '0-1k', max: 1_000 },
  { label: '1k-4k', max: 4_000 },
  { label: '4k-16k', max: 16_000 },
  { label: '16k-64k', max: 64_000 },
  { label: '64k-256k', max: 256_000 },
  { label: '256k+', max: Number.POSITIVE_INFINITY },
];

/** How the caller constrained tool use, as an enum — never the tool NAMES. */
export type ToolChoiceMode = 'none' | 'auto' | 'required' | 'named';

export interface RequestShape {
  /** Message count (turn depth). */
  messages: number;
  /** A system message was present. */
  system: boolean;
  /** Declared tool count. 0 = the request carried no tools. */
  tools: number;
  /** Present only when the caller sent tool_choice. */
  toolChoice?: ToolChoiceMode;
  /** The caller asked for a stream. */
  stream: boolean;
  /** The caller's declared output ceiling, verbatim (their number, not ours). */
  maxTokens?: number;
  /** Bucketed total content length — a size, never a subject. */
  chars: string;
}

export interface ShapeInput {
  messages: readonly ChatMessage[];
  tools?: readonly unknown[] | undefined;
  tool_choice?: ToolChoice | undefined;
  stream?: boolean | undefined;
  max_tokens?: number | undefined;
}

function charBucket(total: number): string {
  for (const b of CHAR_BUCKETS) {
    if (total < b.max) return b.label;
  }
  // CHAR_BUCKETS ends at Infinity, so this is unreachable; kept total rather
  // than asserted so a future edit that drops the sentinel degrades to the
  // widest label instead of throwing on the serve path.
  return CHAR_BUCKETS[CHAR_BUCKETS.length - 1]!.label;
}

function toolChoiceMode(choice: ToolChoice | undefined): ToolChoiceMode | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === 'string') return choice;
  // A named function: the MODE is recorded, the NAME is not. Tool names are
  // customer vocabulary ("charge_customer_card"), which is exactly the kind
  // of thing that must not accumulate in a cross-org aggregate.
  return 'named';
}

/** Describe a request's structure. Reads lengths and counts; never content. */
export function requestShape(input: ShapeInput): RequestShape {
  let chars = 0;
  let system = false;
  for (const m of input.messages) {
    chars += m.content.length;
    if (m.role === 'system') system = true;
  }
  const shape: RequestShape = {
    messages: input.messages.length,
    system,
    tools: input.tools?.length ?? 0,
    stream: input.stream === true,
    chars: charBucket(chars),
  };
  const mode = toolChoiceMode(input.tool_choice);
  if (mode !== undefined) shape.toolChoice = mode;
  if (input.max_tokens !== undefined) shape.maxTokens = input.max_tokens;
  return shape;
}

/**
 * The demand-cell key for a shape (S7 L2): the axes on which measured
 * evidence can actually be WRONG for a request, and nothing else.
 *
 * `messages` and `maxTokens` are deliberately excluded — a 4-turn and a
 * 6-turn conversation are not measured by different models, and including
 * them would shatter demand into cells too small to ever clear the
 * k-anonymity gate. Cell keys are for grouping; the full shape stays on the
 * request row for anyone who needs the detail.
 */
export function shapeClass(shape: RequestShape): string {
  return [
    shape.tools > 0 ? 'tools' : 'no-tools',
    shape.stream ? 'stream' : 'sync',
    shape.chars,
  ].join('/');
}

/** The upper edge of a bucket label, in characters (Infinity for the last). */
export function charBucketMax(label: string): number {
  return CHAR_BUCKETS.find((b) => b.label === label)?.max ?? Number.POSITIVE_INFINITY;
}

export interface ParsedShapeClass {
  tools: boolean;
  stream: boolean;
  chars: string;
}

/**
 * Read a `shapeClass` string back into its axes.
 *
 * Coverage (L3) asks questions of a cell that only the axes can answer —
 * "did this traffic carry tools?", "how long did it get?" — and the cell
 * stores the joined key. Parsing beats storing the parts three times.
 * Returns null for anything that is not a key this module produced.
 */
export function parseShapeClass(key: string): ParsedShapeClass | null {
  const parts = key.split('/');
  if (parts.length !== 3) return null;
  const [tools, stream, chars] = parts as [string, string, string];
  if (tools !== 'tools' && tools !== 'no-tools') return null;
  if (stream !== 'stream' && stream !== 'sync') return null;
  if (!CHAR_BUCKETS.some((b) => b.label === chars)) return null;
  return { tools: tools === 'tools', stream: stream === 'stream', chars };
}
