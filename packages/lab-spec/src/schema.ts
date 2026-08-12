// zod schemas for the harness spec (Lab) — the enforcement truth.
//
// `.strict()` everywhere: unknown fields are REJECTED, not stripped. Forward
// compatibility lives in `specVersion`, not in silently ignored fields — a
// typo'd `maxUsdPerRnu` that validates is a budget that doesn't exist.
//
// DEVIATION FROM THE APPROVED SPEC, recorded per the binding protocol (also
// noted in docs/specs/step-02-harness-spec.md): the spec said "reuse core's
// PolicySchema". On contact with the real schema that was wrong in two ways:
// (1) core's z.object defaults STRIP unknown keys, violating the
// unknown-field rule inside the policy slot; (2) core policies carry
// `shadow`/`guarantee` — serving-side configuration a harness runtime will
// not honor, and an accepted-but-unenforced slot is the phantom-decision
// pattern. So LabPolicySchema below is a STRICT SUBSET: the same four
// discriminants with identical field validators, minus shadow/guarantee,
// `.strict()`. The subset relationship is PROVEN by a test (schema.test.ts:
// every LabPolicySchema-valid value parses under core's PolicySchema), so
// drift from core's vocabulary fails the build instead of accumulating.
import { z } from 'zod';
import {
  MAX_CHECKINS,
  MAX_CRON_CHARS,
  MAX_GOAL_CHARS,
  MAX_NAME_CHARS,
  MAX_QUESTION_CHARS,
  MAX_RULES,
  MAX_RULE_CHARS,
  MAX_SCOPES_PER_SUPERPOWER,
  MAX_SCOPE_CHARS,
  MAX_SUPERPOWERS,
  MAX_SUPERPOWER_ID_CHARS,
} from './limits.js';

/** Strict subset of core's Policy vocabulary — see the header. */
export const LabPolicySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('max_quality'), costCeilingPer1K: z.number().positive() }).strict(),
  z.object({ type: z.literal('min_cost'), qualityFloor: z.number().min(0).max(1) }).strict(),
  z.object({ type: z.literal('latency_bound'), p95Ms: z.number().positive() }).strict(),
  z
    .object({
      type: z.literal('compound'),
      qualityFloor: z.number().min(0).max(1),
      p95Ms: z.number().positive(),
    })
    .strict(),
]);

const BrainSchema = z
  .object({
    policy: LabPolicySchema,
    toolPolicy: LabPolicySchema.optional(),
  })
  .strict();

const MissionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('task'),
      goal: z.string().min(1).max(MAX_GOAL_CHARS),
      doneDefinition: z.string().min(1).max(MAX_GOAL_CHARS),
      worthPerRunUsd: z.number().positive().optional(),
    })
    .strict(),
  // Standing missions have NO done-definition by design: governed by rules
  // and check-ins, not a done-verifier.
  z
    .object({
      kind: z.literal('standing'),
      goal: z.string().min(1).max(MAX_GOAL_CHARS),
    })
    .strict(),
]);

const SuperpowerSchema = z
  .object({
    id: z.string().min(1).max(MAX_SUPERPOWER_ID_CHARS),
    scopes: z.array(z.string().min(1).max(MAX_SCOPE_CHARS)).max(MAX_SCOPES_PER_SUPERPOWER),
    maxSpendUsdPerRun: z.number().positive().optional(),
    maxSpendUsdPerDay: z.number().positive().optional(),
  })
  .strict();

const MemorySchema = z
  .object({
    enabled: z.boolean(),
    retentionDays: z.number().int().positive().optional(),
  })
  .strict();

const FuelSchema = z
  .object({
    maxUsdPerRun: z.number().positive(),
    maxUsdPerDay: z.number().positive().optional(),
    // LITERAL true: "no hard stop" is unrepresentable, not merely invalid.
    hardStop: z.literal(true),
  })
  .strict()
  .refine((f) => f.maxUsdPerDay === undefined || f.maxUsdPerDay >= f.maxUsdPerRun, {
    message: 'maxUsdPerDay must be >= maxUsdPerRun — a day that cannot fund one run is a misconfiguration, not a budget',
    path: ['maxUsdPerDay'],
  });

const CheckInSchema = z.discriminatedUnion('trigger', [
  z.object({ trigger: z.literal('before-external-action') }).strict(),
  z
    .object({
      trigger: z.literal('on-budget-fraction'),
      fraction: z.number().gt(0).max(1),
    })
    .strict(),
  z
    .object({
      trigger: z.literal('cron'),
      schedule: z.string().min(1).max(MAX_CRON_CHARS),
      question: z.string().min(1).max(MAX_QUESTION_CHARS),
    })
    .strict(),
]);

export const HarnessSpecSchema = z
  .object({
    specVersion: z.literal(1),
    name: z.string().min(1).max(MAX_NAME_CHARS),
    // 64 hex chars — sha256. Presence is optional; correctness is not
    // (parse.ts recomputes and rejects mismatch: hash-mismatch).
    hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'hash must be 64 lowercase hex chars (sha256)')
      .optional(),
    brain: BrainSchema,
    mission: MissionSchema,
    superpowers: z.array(SuperpowerSchema).max(MAX_SUPERPOWERS),
    memory: MemorySchema,
    rules: z.array(z.string().min(1).max(MAX_RULE_CHARS)).max(MAX_RULES),
    fuel: FuelSchema,
    checkIns: z.array(CheckInSchema).max(MAX_CHECKINS),
  })
  .strict();
