import { z } from 'zod';
import type { ChatMessage } from './types.js';

/** Evidence provenance (M1a). Absence of the field on a value object means
 * 'unknown' — only 'live' may ever be served as live evidence. */
export const ProviderModeSchema = z.enum(['mock', 'live']);

/** One OpenAI content part. Text is carried; images are parsed so the API
 * edge can refuse them with a precise message instead of a schema error. */
export const ContentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string(), detail: z.string().optional() }) }),
  /** G audio (2026-08-24): OpenAI-shaped audio input part. */
  z.object({ type: z.literal('input_audio'), input_audio: z.object({ data: z.string(), format: z.enum(['wav', 'mp3']) }) }),
]);

/** The wire shape of a message (OpenAI chat-completions), including the
 * agentic turns: assistant tool_calls and role 'tool' results. */
export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(ContentPartSchema), z.null()]),
  tool_calls: z.array(z.lazy(() => ToolCallSchema)).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});
export type WireChatMessage = z.infer<typeof ChatMessageSchema>;

export const SamplingParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  seed: z.number().int().optional(),
  user: z.string().max(256).optional(),
  response_format: z
    .union([
      z.object({ type: z.enum(['text', 'json_object']) }),
      z.object({ type: z.literal('json_schema'), json_schema: z.record(z.unknown()) }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().optional(),
});

/** Flatten a wire message to the internal ChatMessage. Returns the image
 * count so the edge can refuse vision input precisely. */
export function flattenWireMessage(m: WireChatMessage): { message: ChatMessage; images: number; audio: number } {
  let images = 0;
  let audio = 0;
  let content = '';
  if (typeof m.content === 'string') content = m.content;
  else if (Array.isArray(m.content)) {
    const texts: string[] = [];
    for (const part of m.content) {
      if (part.type === 'text') texts.push(part.text);
      else if (part.type === 'input_audio') audio++;
      else images++;
    }
    content = texts.join('\n');
  }
  const message: ChatMessage = { role: m.role, content };
  if (Array.isArray(m.content) && (images > 0 || audio > 0)) message.parts = m.content as NonNullable<ChatMessage['parts']>;
  if (m.tool_calls !== undefined) message.tool_calls = m.tool_calls;
  if (m.tool_call_id !== undefined) message.tool_call_id = m.tool_call_id;
  if (m.name !== undefined) message.name = m.name;
  return { message, images, audio };
}

// ---- tool calling (M3 #25 OpenAI parity; ADDITIVE) ----
export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

export const ToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }),
});

export const ToolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string() }),
  }),
]);

export const CascadeStageSchema = z.object({
  model: z.string(),
  escalateIf: z.object({ confidenceBelow: z.number().min(0).max(1).optional() }).optional(),
});

export const JudgeConfigSchema = z.object({
  model: z.string(),
  rubric: z.string().optional(),
});

export const FusionConfigSchema = z.object({
  /** R4 (2026-08-24): 'exec-pick' — a test-writer model derives a JS test
   * snippet FROM THE REQUEST ONLY (never a reference), every candidate runs
   * against it in the code-exec sandbox, the highest pass count wins; ties
   * (including "tests unusable") fall back to judge-pick, then confidence.
   * Measured motivation: judge-pick realized 27% of a pair's oracle
   * headroom on code-gen — the text judge is the bottleneck. */
  method: z.enum(['judge-pick', 'concat-rank', 'exec-pick']),
  judge: JudgeConfigSchema.optional(),
  /** exec-pick only: the model that writes the tests. */
  testWriter: JudgeConfigSchema.optional(),
  /** exec-pick, selector stabilization (2026-08-25): MULTIPLE independent
   * test-writers ride the same parallel fan-out; a candidate's score is the
   * MEAN pass rate across suites — majority by execution, so one wrong test
   * suite is half the vote instead of the whole verdict. Exact ties still
   * fall to the judge. Takes precedence over testWriter when non-empty. */
  testWriters: z.array(JudgeConfigSchema).min(1).max(3).optional(),
});

export const StrategyConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('single'), model: z.string() }),
  z.object({
    type: z.literal('cascade'),
    stages: z.array(CascadeStageSchema).min(1),
    confidenceMethod: z.enum(['logprob', 'self-report-calibrated']),
  }),
  z.object({
    type: z.literal('best-of-n'),
    model: z.string(),
    n: z.number().int().min(2).max(16),
    judge: JudgeConfigSchema,
  }),
  z.object({
    type: z.literal('draft-verify'),
    draftModel: z.string(),
    verifierModel: z.string(),
  }),
  z.object({
    type: z.literal('ensemble'),
    models: z.array(z.string()).min(2),
    fusion: FusionConfigSchema,
  }),
  z.object({
    type: z.literal('decompose'),
    decomposerModel: z.string(),
    routing: z.record(z.string()),
    fusion: FusionConfigSchema.optional(),
  }),
  // M3 #23 composite streaming (SPEC §12.6).
  z.object({
    type: z.literal('composite'),
    startModel: z.string(),
    upgradeModel: z.string(),
    upgradeIf: z.object({ confidenceBelow: z.number().min(0).max(1) }),
  }),
]);

/** Shadow mode (M3 #21, SPEC §12.4) — ADDITIVE optional member on Policy. */
export const ShadowConfigSchema = z.object({
  sampleRate: z.number().min(0).max(1),
  candidates: z.union([z.literal('frontier'), z.array(z.string().min(1)).min(1)]),
});

/** Quality guarantee (M3 #22, SPEC §12.5) — ADDITIVE optional member on Policy. */
export const GuaranteeConfigSchema = z.object({
  minQuality: z.number().min(0).max(1),
  windowMin: z.number().positive(),
  sampleRate: z.number().min(0).max(1),
  action: z.enum(['rollback', 'alert']),
  /** Judge model ALIAS for sampled-answer scoring (G0.1). Absent → the
   * platform default (judge-class live / mock-judge mock). Additive —
   * stored policy rows without it parse unchanged. */
  judgeModel: z.string().min(1).optional(),
  /** Minimum window evidence before a breach may fire (G0.3). Absent →
   * platform floor (5). The floor is a hard minimum — contract-grade
   * partners raise it, never lower it. Applied at EVALUATION time only
   * (never injected into stored configs). */
  minSamples: z.number().int().min(5).optional(),
  /** Judge completion cap for sampled-answer scoring (G2.1). Absent → 128.
   * Bounded 128–4096: the floor keeps the legacy default reachable, the
   * cap keeps serve-path judge spend projection-bound. */
  judgeMaxTokens: z.number().int().min(128).max(4096).optional(),
  /** Contractual retention floor (G2.1). Absent → 0.9 platform default,
   * applied at EVALUATION time only (never injected into stored configs).
   * Relative and scale-free — denominator is the incumbent's measured
   * score on identical items. */
  retentionFloor: z.number().min(0).max(1).optional(),
  /** Verification SLA bound in minutes (G2.2). Absent → platform 240,
   * applied at EVALUATION time only. Clock starts at advisory creation. */
  verifySlaMin: z.number().positive().optional(),
  /** Auto-restore on CONFIDENT suite-verified recovery (G2.2). Hierarchy
   * mode only; legacy mode is a surfaced no-op. Default false. */
  autoRestore: z.boolean().optional(),
});

export const PolicySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('max_quality'),
    costCeilingPer1K: z.number().positive(),
    shadow: ShadowConfigSchema.optional(),
    guarantee: GuaranteeConfigSchema.optional(),
  }),
  z.object({
    type: z.literal('min_cost'),
    qualityFloor: z.number().min(0).max(1),
    clusterFloors: z.record(z.string(), z.number().min(0).max(1)).optional(),
    shadow: ShadowConfigSchema.optional(),
    guarantee: GuaranteeConfigSchema.optional(),
  }),
  z.object({
    type: z.literal('latency_bound'),
    p95Ms: z.number().positive(),
    shadow: ShadowConfigSchema.optional(),
    guarantee: GuaranteeConfigSchema.optional(),
  }),
  /** G2.6 compound: quality floor AND hard latency bound, min cost among the
   * survivors. See the Policy union comment for why this is its own type. */
  z.object({
    type: z.literal('compound'),
    qualityFloor: z.number().min(0).max(1),
    clusterFloors: z.record(z.string(), z.number().min(0).max(1)).optional(),
    p95Ms: z.number().positive(),
    shadow: ShadowConfigSchema.optional(),
    guarantee: GuaranteeConfigSchema.optional(),
  }),
]);

export const ScoringMethodSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), field: z.string().optional() }),
  z.object({
    kind: z.literal('code-exec'),
    language: z.enum(['javascript', 'python']),
    tests: z.string(),
  }),
  z.object({
    kind: z.literal('field-match'),
    schema: z.record(z.enum(['string', 'number', 'boolean', 'array'])),
  }),
  z.object({
    kind: z.literal('llm-judge'),
    rubric: z.string(),
    judgeModel: z.string(),
    scale: z.tuple([z.number(), z.number()]),
  }),
  z.object({ kind: z.literal('tool-call'), expect: z.object({ name: z.string(), arguments: z.record(z.unknown()).optional() }) }),
]);

export const EvalItemSchema = z.object({
  id: z.string(),
  clusterId: z.string(),
  prompt: z.array(ChatMessageSchema).min(1),
  /** Tools offered to the model for this item (MIXING M3). */
  tools: z.array(ToolSchema).optional(),
  reference: z.unknown().optional(),
  scoring: ScoringMethodSchema,
});

export const PriceEntrySchema = z.object({
  alias: z.string(),
  provider: z.enum(['anthropic', 'openai', 'google', 'openrouter', 'mock']),
  model: z.string(),
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
});

export const PriceTableSchema = z.object({
  version: z.string(),
  updatedAt: z.string(),
  entries: z.array(PriceEntrySchema).min(1),
});
