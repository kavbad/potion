// Mock provider (SPEC §2): fully deterministic, seeded by params.seed ?? hash(prompt).
// Text tagged `[mock:<model>]`; usage from chars/4 token estimates; latency from a
// per-model latency profile; logprobConfidence deterministic in [0.5, 0.99];
// embed → semantically clustered deterministic 384-dim vectors (see embedding.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// TEST/CI SIMULATION ONLY — never authoritative for customer-facing evals.
// Every answer this provider returns (including corpus-backed EVAL answers,
// see ./eval-corpus.ts) is synthetic. Eval results produced with it are
// pipeline simulations, not measurements of real-world quality.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loud provenance disclaimer for the mock provider. Exported so callers
 * (harness CLI, seed/demo scripts, dashboards) can surface it verbatim
 * whenever mock-backed (simulated) eval results are shown.
 */
export const MOCK_PROVIDER_DISCLAIMER =
  'SIMULATED RESULTS — produced by the deterministic mock provider and/or ' +
  'mock-corpus-derived suites. TEST/CI SIMULATION ONLY: never authoritative ' +
  'for customer-facing evals and never evidence of real-world quality.';
import type { PriceTable, ReasoningEffort, ToolCall } from '@potion/core';
import type { CompleteRequest, CompleteResponse, Provider } from '../types.js';
import { MOCK_WORDS, specialFixtureText } from './fixtures.js';
import { mockConfidenceOverride } from './eval-corpus.js';
import { mockEmbedText } from './embedding.js';
import { hashString, mulberry32, seedOf } from './rng.js';

/** Deterministic latency profile (ms) by model name/alias (SPEC §2 examples:
 * cheap ~ haiku-class = 300ms, mid = 900ms, frontier-class = 1800ms). */
export function latencyProfileMs(model: string): number {
  const m = model.toLowerCase();
  if (/(cheap|haiku|mini|flash)/.test(m)) return 300;
  if (/(frontier|opus|pro)/.test(m)) return 1800;
  return 900; // mid: sonnet/judge/plain mock-mid etc.
}

function promptTextOf(req: CompleteRequest): string {
  return req.messages.map((m) => `${m.role}:${m.content}`).join('\n');
}

/** Deterministic fixture-transcript text: `[mock:<model>] <seeded words>`. */
function generateText(model: string, rng: () => number): string {
  const wordCount = 12 + Math.floor(rng() * 24); // 12..35 words
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(MOCK_WORDS[Math.floor(rng() * MOCK_WORDS.length)] ?? 'word');
  }
  return `[mock:${model}] ${words.join(' ')}.`;
}

/** chars/4 token estimate, rounded up. */
function estTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// M3 #25 (OpenAI parity, ADDITIVE): deterministic TOOL-CALL ECHO fixture.
// When the request carries params.tools (function tools), the mock answers
// with a tool call instead of prose — the same way a live model answers a
// tool-augmented prompt it decides to route to a function. The echo is
// PURELY hash-derived (no rng draws), so adding it changes NOTHING about the
// legacy word-bank/fixture draw sequence for tool-less prompts:
//   · id        `call_<8 hex of hash(model|name|prompt)>`  (OpenAI-style id)
//   · name      the FIRST declared tool's function name
//   · arguments JSON string echoing the last user message (truncated) + the
//               resolved seed — graders can assert the wiring end-to-end.
// text is '' in this branch (mirrors OpenAI: content null on tool_call turns).
// TEST/CI SIMULATION ONLY — like every mock answer, this is a wiring fixture,
// never evidence of real tool-use quality (see eval-corpus.ts header).
// ─────────────────────────────────────────────────────────────────────────────
export function toolCallEchoFixture(req: CompleteRequest, seed: number): ToolCall[] | null {
  const tools = req.params?.tools;
  if (!tools || tools.length === 0) return null;
  const first = tools[0];
  if (!first) return null;
  // Step 8 (ADDITIVE): once the transcript carries a TOOL RESULT (the lab
  // runtime's `[tool <name> result]` user message), answer with TEXT like a
  // real model — call-then-answer. Without this no tool-bearing run can ever
  // complete against the mock route (every call would echo another tool
  // call forever). Transcripts without tool results keep the original
  // always-echo behavior byte-identical.
  const hasToolResult = req.messages.some(
    (m) => typeof m.content === 'string' && m.content.startsWith('[tool ') && m.content.includes(' result]'),
  );
  if (hasToolResult) return null;
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const idHex = hashString(`${req.model}|${first.function.name}|${promptTextOf(req)}`)
    .toString(16)
    .padStart(8, '0');
  return [
    {
      id: `call_${idHex}`,
      type: 'function',
      function: {
        name: first.function.name,
        arguments: JSON.stringify({ echo: lastUser.slice(0, 80), seed }),
      },
    },
  ];
}

/**
 * C4 mock effort model (TEST/CI SIMULATION ONLY, like the confidence marker).
 * Thinking costs tokens and time and buys certainty — the three things the
 * compiler trades between — so the mock makes each move monotonically, and
 * deterministically, without touching the rng stream.
 */
export const MOCK_REASONING_TOKENS: Record<ReasoningEffort, number> = { low: 64, medium: 256, high: 1024 };
export const MOCK_EFFORT_LATENCY: Record<ReasoningEffort, number> = { low: 2, medium: 4, high: 8 };
/** Effort closes the gap to certainty: high effort removes 3/4 of the doubt.
 *  Monotone, stays inside [0, 1), and leaves an effort-free call untouched. */
export function liftConfidence(c: number, effort: ReasoningEffort | undefined): number {
  if (effort === undefined) return c;
  const divisor = { low: 1.5, medium: 2, high: 4 }[effort];
  return 1 - (1 - c) / divisor;
}

export function createMockProvider(prices: PriceTable): Provider {
  return {
    id: 'mock',

    async complete(req: CompleteRequest): Promise<CompleteResponse> {
      const seed = seedOf(req.params?.seed, promptTextOf(req));
      const rng = mulberry32(seed);
      // M3 #25: tool-calling requests get the deterministic echo fixture
      // (hash-derived, NO rng draws — legacy draw sequence untouched).
      const toolCalls = toolCallEchoFixture(req, seed);
      // Structured-answer fixtures (Phase 1, additive): strategy prompts that
      // explicitly request CONFIDENCE:/PICK:/JSON-subtask formats get a
      // deterministic structured answer; all other prompts keep the original
      // word-bank text with an identical rng draw sequence.
      const text =
        toolCalls !== null
          ? ''
          : (specialFixtureText(req.model, promptTextOf(req), rng) ?? generateText(req.model, rng));
      // Draw confidence from the same seeded stream AFTER text generation so
      // both are stable functions of the seed.
      const drawnConfidence = 0.5 + rng() * 0.49; // in [0.5, 0.99)
      // M3 #23 (additive, TEST/CI SIMULATION ONLY): a `[[mock-confidence:x]]`
      // prompt marker pins the confidence (rng draw sequence unchanged — the
      // draw above is always consumed). See eval-corpus.ts.
      const logprobConfidence =
        mockConfidenceOverride(promptTextOf(req)) ?? drawnConfidence;
      const entry = prices.entries.find(
        (e) => e.alias === req.model || e.model === req.model,
      );
      const resolvedModel = entry?.model ?? req.model;
      // C4 reasoning effort. A DETERMINISTIC POST-HOC TRANSFORM of values that
      // were already drawn — it consumes no rng, so a request that does not
      // ask for effort produces byte-identical output to before, which is the
      // whole fixture backbone of this repo.
      const effort = req.params?.reasoningEffort;
      const answerTokens =
        estTokens(text.length) + (toolCalls ? estTokens(toolCalls[0]!.function.arguments.length) : 0);
      const reasoningTokens = effort !== undefined ? MOCK_REASONING_TOKENS[effort] : 0;
      return {
        text,
        usage: {
          inputTokens: estTokens(promptTextOf(req).length),
          // Reasoning tokens ARE output tokens on every real bill, so they are
          // inside the total as well as broken out — a cost model that read
          // only the total must not undercount thinking.
          outputTokens: answerTokens + reasoningTokens,
          ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
        },
        latencyMs: latencyProfileMs(req.model) * (effort !== undefined ? MOCK_EFFORT_LATENCY[effort] : 1),
        logprobConfidence: liftConfidence(logprobConfidence, effort),
        modelVersion: `${resolvedModel}#mock-v1`,
        ...(toolCalls !== null ? { toolCalls } : {}),
      };
    },

    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(mockEmbedText);
    },
  };
}
