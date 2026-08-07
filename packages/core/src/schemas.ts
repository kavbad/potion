import { z } from 'zod';

/** Evidence provenance (M1a). Absence of the field on a value object means
 * 'unknown' — only 'live' may ever be served as live evidence. */
export const ProviderModeSchema = z.enum(['mock', 'live']);

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

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
  method: z.enum(['judge-pick', 'concat-rank']),
  judge: JudgeConfigSchema.optional(),
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
    shadow: ShadowConfigSchema.optional(),
    guarantee: GuaranteeConfigSchema.optional(),
  }),
  z.object({
    type: z.literal('latency_bound'),
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
]);

export const EvalItemSchema = z.object({
  id: z.string(),
  clusterId: z.string(),
  prompt: z.array(ChatMessageSchema).min(1),
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
