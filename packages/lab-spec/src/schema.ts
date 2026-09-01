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
  MAX_EXEMPLAR_CHARS,
  MAX_SCOPES_PER_SUPERPOWER,
  MAX_SCOPE_CHARS,
  MAX_SUPERPOWERS,
  MAX_SUPERPOWER_ID_CHARS,
  MAX_CONSTITUTION_ENTRIES,
  MAX_ACTION_CLASS_CHARS,
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
      /** P5 (2026-08-28): the SHAPE — the first standing shape that is not
       * a reporter. A watchdog is mostly silent: it fires only on a true
       * condition, a quiet check is a valid judged deliverable, and its
       * judge weighs precision/false alarms. OPTIONAL AND ADDITIVE: absent
       * = the reporter behavior, byte-identical prompts, old records
       * replay clean. */
      shape: z.literal('watchdog').optional(),
    })
    .strict(),
]);

const SuperpowerSchema = z
  .object({
    id: z.string().min(1).max(MAX_SUPERPOWER_ID_CHARS),
    scopes: z.array(z.string().min(1).max(MAX_SCOPE_CHARS)).max(MAX_SCOPES_PER_SUPERPOWER),
    maxSpendUsdPerRun: z.number().positive().optional(),
    maxSpendUsdPerDay: z.number().positive().optional(),
    maxCalls: z.number().int().positive().max(1000).optional(),
  })
  .strict();

const MemorySchema = z
  .object({
    enabled: z.boolean(),
    retentionDays: z.number().int().positive().optional(),
    /** P3 (2026-08-28): the beat working set — a standing worker keeps
     * structured memory (entities, dedup keys, source stats, reflections)
     * through the `remember` core tool, and its prompt renders the beat
     * ledger + law. OPTIONAL AND ADDITIVE: absent = the pre-P3 blob
     * behavior, byte-identical prompts, old records replay clean. */
    beat: z.boolean().optional(),
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
  // P5 event triggers — anything can poke a worker awake:
  //   · webhook: the arm mints a secret inlet URL; a POST to it starts a
  //     check (rate-limited; the token hash lives on the mission row);
  //   · feed-change: the scheduler polls the page on its tick, hashes the
  //     body, and starts a check within one cycle of a real change.
  z.object({ trigger: z.literal('webhook') }).strict(),
  z
    .object({
      trigger: z.literal('feed-change'),
      url: z
        .string()
        .max(500)
        .refine((u) => /^https:\/\//.test(u), 'feed-change url must be https'),
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
    // P1 (the mouth): the output CONTRACT. Optional — a contract-less spec
    // behaves exactly as before, byte-for-byte. 'brief' is the first and
    // only contract type; the deliverable schema lives in contract.ts and
    // is enforced by the runtime's completion law, not here.
    contract: z.object({ type: z.literal('brief') }).strict().optional(),
    // X4 (2026-08-28): FAN-OUT — the worker may split big work across
    // helper sub-runs. One fuel tree (every helper's cap is a slice of
    // THIS spec's remaining budget — the family can never outspend the cap
    // the operator set), one trace (each helper is a full recorded run,
    // linked to its parent). Helpers think, read the web, and run code
    // when those powers are enabled — they never take external actions
    // and never delegate further (depth 1). OPTIONAL AND ADDITIVE: absent
    // = no delegate tool, byte-identical prompts, old records replay clean.
    fanOut: z
      .object({ maxWorkers: z.number().int().min(1).max(5) })
      .strict()
      .optional(),
    // W1: the Action Constitution (see types.ts) — small, typed, strict.
    constitution: z
      .array(
        z
          .object({
            action: z.string().min(1).max(MAX_ACTION_CLASS_CHARS),
            maxAuthority: z.enum(['earnable', 'ask-forever', 'barred']),
            note: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(MAX_CONSTITUTION_ENTRIES)
      .optional(),
    // C-3 (2026-08-28): the operator's pasted "a great result looks like" —
    // THE standard to hit, carried on the spec and injected into every
    // run's context (it was extraction-context-only before: the most
    // potent quality signal never reached the worker doing the work).
    exemplar: z.string().min(1).max(MAX_EXEMPLAR_CHARS).optional(),
  })
  .strict();
