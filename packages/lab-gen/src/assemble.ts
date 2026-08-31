// Deterministic spec assembly — everything below the extraction call is
// code: field mapping, fuel arithmetic, hashing, canonical serialization.
// This split (model fills a strict extraction schema; code assembles the
// spec) is what makes the closure property provable.
import { canonicalJson, type Policy } from '@potion/core';
import { harnessSpecHash, SPEC_LIMITS, type HarnessSpec } from '@potion/lab-spec';
import { getPackage } from '@potion/lab-superpowers';
import { FUEL_MAX_USD, FUEL_MIN_USD, WORTH_TO_FUEL_RATIO } from './constants.js';
import type { Extraction } from './extract.js';
import type { InterviewAnswers } from './interview.js';

/** worth → maxUsdPerRun: quarter of stated worth, cent-rounded, clamped. */
export function fuelFromWorth(worthUsd: number): number {
  const raw = Math.round(worthUsd * WORTH_TO_FUEL_RATIO * 100) / 100;
  return Math.min(Math.max(raw, FUEL_MIN_USD), FUEL_MAX_USD);
}

/** Account name → superpower id: lowercased, kebab, bounded, deduped by caller. */
export function accountSlug(account: string): string {
  const slug = account
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SPEC_LIMITS.MAX_SUPERPOWER_ID_CHARS);
  return slug.length > 0 ? slug : 'service';
}

/** Deterministic sanitation for user-verbatim strings: lab-spec rejects
 * control characters, and a verbatim pass-through would turn a pasted
 * escape byte into a closure-gate crash. */
export function sanitizeVerbatim(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
}

/** Recipe cadence → a FIXED cron by code (the user never writes cron). */
export const CADENCE_CRON: Record<'hourly' | 'daily' | 'weekly', string> = {
  hourly: '0 * * * *',
  daily: '0 9 * * *',
  weekly: '0 9 * * 1',
};

/** Recipe-card fields → deterministic rules. The prefix names the field so
 * the spec stays self-describing when read raw; the content is verbatim
 * (sanitized, capped) — the runtime injects rules[] into the system prompt,
 * which is what makes these load-bearing rather than decorative. */
export function recipeRules(answers: InterviewAnswers): string[] {
  const out: string[] = [];
  const bar = answers.qualityBar !== undefined ? sanitizeVerbatim(answers.qualityBar) : '';
  if (bar.length > 0) out.push(`Done well means: ${bar}`.slice(0, SPEC_LIMITS.MAX_RULE_CHARS));
  const prod = answers.produces !== undefined ? sanitizeVerbatim(answers.produces) : '';
  if (prod.length > 0) out.push(`Deliverable: ${prod}`.slice(0, SPEC_LIMITS.MAX_RULE_CHARS));
  return out;
}

export function assembleSpec(answers: InterviewAnswers, extraction: Extraction, policy: Policy): HarnessSpec {
  // Step 11 §6 — LEAST PRIVILEGE BY DEFAULT: a declared superpower carries
  // its catalog package's `defaultScopes`, which is the MINIMUM that
  // package's own mini-eval needs to pass (never the maximum the vendor
  // offers, and never an act tool's write scope). An account with no
  // catalog package keeps the empty set — the Step 8 posture, unchanged.
  const superpowers = [...new Set(answers.accounts.map(accountSlug))]
    .slice(0, SPEC_LIMITS.MAX_SUPERPOWERS)
    .map((id) => ({ id, scopes: [...(getPackage(id)?.defaultScopes ?? [])] }));
  // Recipe rules FIRST (the quality bar and deliverable are read before
  // governance), then the operator's verbatim must-nevers. The combined
  // overflow refusal lives in generate.ts — no silent truncation here.
  const rules = [
    ...recipeRules(answers),
    ...(answers.constraints ?? [])
      .map((r) => sanitizeVerbatim(r).slice(0, SPEC_LIMITS.MAX_RULE_CHARS))
      .filter((r) => r.length > 0),
  ].slice(0, SPEC_LIMITS.MAX_RULES);
  return {
    specVersion: 1,
    name: extraction.nameSlug,
    brain: { policy },
    mission:
      answers.kind === 'task'
        ? {
            kind: 'task',
            // FAITHFUL GOAL (2026-08-31): the mission goal is the user's
            // OWN words, verbatim — never the model's "restatement", which
            // silently dropped embedded data, examples, and specifics and
            // left workers unable to do the actual job. The extraction
            // still gives the name slug, cluster, and sharpened done-def.
            goal: answers.goal.trim(),
            // extract.ts guarantees presence for tasks; the non-null makes
            // a future regression loud instead of emitting an invalid spec.
            doneDefinition: extraction.doneDefinition!,
            worthPerRunUsd: answers.worthUsd,
          }
        : {
            kind: 'standing',
            // FAITHFUL GOAL (2026-08-31): the mission goal is the user's
            // OWN words, verbatim — never the model's "restatement", which
            // silently dropped embedded data, examples, and specifics and
            // left workers unable to do the actual job. The extraction
            // still gives the name slug, cluster, and sharpened done-def.
            goal: answers.goal.trim(),
            // P5: the shape rides the mission — the runtime's watchdog law
            // (quiet checks are valid deliverables) keys on it.
            ...(answers.shape === 'watchdog' ? { shape: 'watchdog' as const } : {}),
          },
    superpowers,
    // P3: every standing hire keeps the BEAT working set — entities with
    // history, dedup keys, source stats, reflections — via the `remember`
    // core tool. Task hires stay memory-off (nothing to carry between runs).
    memory: answers.kind === 'standing' ? { enabled: true, beat: true } : { enabled: false },
    // X4: the fan-out knob — helpers under one fuel tree, chosen by the
    // operator, never assumed.
    ...(answers.helpers !== undefined && answers.helpers >= 1
      ? { fanOut: { maxWorkers: Math.min(Math.max(Math.floor(answers.helpers), 1), 5) } }
      : {}),
    rules,
    ...(answers.exampleResult !== undefined && sanitizeVerbatim(answers.exampleResult).length > 0
      ? { exemplar: sanitizeVerbatim(answers.exampleResult).slice(0, SPEC_LIMITS.MAX_EXEMPLAR_CHARS) }
      : {}),
    fuel: { maxUsdPerRun: fuelFromWorth(answers.worthUsd), hardStop: true },
    // Step 8: a STANDING mission checks in at half fuel — "a standing
    // mission has no natural run in the user's head; a check does" (Step 6
    // review outcome 1). Without this a Step 8 standing trial (tools not
    // yet wired) burns to its hard stop with no human touchpoint; tasks
    // complete on their own done-definition and stay check-in-free unless
    // tool-bearing.
    // P1 (the mouth): standing missions carry the brief contract — the
    // check's final answer must BE the deliverable, schema-checked by the
    // runtime's completion law. Tasks keep their done-definition semantics
    // unchanged (contract-less specs behave byte-identically to before).
    ...(answers.kind === 'standing' ? { contract: { type: 'brief' as const } } : {}),
    checkIns: [
      // 'ask-first' extends the half-budget check-in to TASK missions too;
      // it never removes the standing default (additive-only safety).
      ...(answers.kind === 'standing' || answers.whenUnsure === 'ask-first'
        ? [{ trigger: 'on-budget-fraction', fraction: 0.5 } as const]
        : []),
      ...(superpowers.length > 0 ? [{ trigger: 'before-external-action' } as const] : []),
      // Recipe cadence (standing only): a scheduled human touchpoint, cron
      // fixed by code — the enum is the whole input surface.
      ...(answers.kind === 'standing' && answers.cadence !== undefined
        ? [{
            trigger: 'cron' as const,
            schedule: CADENCE_CRON[answers.cadence],
            question: 'Scheduled check-in: anything meaningful since the last check? Anything the operator should decide?',
          }]
        : []),
      // P5: a watched page derives the feed-change trigger — the scheduler
      // hashes it every cycle and starts a check on a REAL change.
      ...(answers.kind === 'standing' && answers.watchUrl !== undefined
        ? [{ trigger: 'feed-change' as const, url: answers.watchUrl }]
        : []),
    ],
  };
}

/** Canonical spec text with the embedded content hash — the first-class
 * harness file: byte-stable, parseable, tamper-evident. */
export function specToText(spec: HarnessSpec): string {
  const hash = harnessSpecHash(spec);
  return canonicalJson({ ...spec, hash });
}
