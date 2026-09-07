// TOOL SELECTION (C4 rung 4, docs/INFERENCE-COMPILER-PLAN.md).
//
// The same idea as context selection, applied to the other thing a request
// carries too much of. A tool CATALOGUE is input tokens on every call — verbose
// JSON schemas, sent whole — and an agent offering twenty tools pays for
// nineteen it will not use. Fewer tools is also measurably easier to choose
// between, so this is a quality axis as well as a cost one.
//
// WHY IT IS DANGEROUS IN A WAY CONTEXT SELECTION IS NOT. Dropping a paragraph
// costs answer quality; the model still answers. Dropping the tool the request
// needed costs the TASK — the model cannot do it at all, and says so in prose.
// That is why the mechanism this feeds is never bare: the `tool-called` check
// exists so a selection that guessed wrong is caught and retried with the full
// catalogue, which turns an undetectable correctness failure into a measurable
// cost.
import type { Tool } from './types.js';

/** Offer the k most relevant tools. */
export interface ToolSelect {
  keepTools: number;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'of',
  'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'with',
  'do', 'does', 'did', 'can', 'will', 'would', 'call', 'tool', 'use', 'get', 'set',
]);

/** Words of a tool's NAME and DESCRIPTION — what it is for, in the author's
 *  own words. Snake_case and camelCase are split, because `refund_order` has
 *  to be able to meet "refund". */
function toolWords(tool: Tool): Set<string> {
  const text = `${tool.function.name} ${tool.function.description ?? ''}`
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
  return words(text);
}

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return out;
}

/**
 * Keep the k tools whose name and description best overlap the request, in
 * their original order. A no-op — the same array back — when there is nothing
 * to do: no selection, or a catalogue already at or under k.
 *
 * Ties break toward the EARLIER tool, so the result is deterministic and the
 * caller's own ordering is respected where relevance cannot separate.
 */
export function selectTools(
  tools: Tool[] | undefined,
  requestText: string,
  select: ToolSelect | undefined,
): Tool[] | undefined {
  if (tools === undefined || select === undefined || select.keepTools < 1) return tools;
  if (tools.length <= select.keepTools) return tools;
  const q = words(requestText);
  return tools
    .map((tool, index) => {
      const w = toolWords(tool);
      let hits = 0;
      for (const t of w) if (q.has(t)) hits++;
      return { tool, index, score: w.size === 0 ? 0 : hits / Math.sqrt(w.size) };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, select.keepTools)
    .sort((a, b) => a.index - b.index)
    .map((c) => c.tool);
}

/** Below this a catalogue is not worth compiling over — choosing 2 of 3 is a
 *  coin flip, not a decision. */
export const MIN_SELECTABLE_TOOLS = 5;
