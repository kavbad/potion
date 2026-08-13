// Deterministic spec assembly — everything below the extraction call is
// code: field mapping, fuel arithmetic, hashing, canonical serialization.
// This split (model fills a strict extraction schema; code assembles the
// spec) is what makes the closure property provable.
import { canonicalJson, type Policy } from '@potion/core';
import { harnessSpecHash, SPEC_LIMITS, type HarnessSpec } from '@potion/lab-spec';
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

export function assembleSpec(answers: InterviewAnswers, extraction: Extraction, policy: Policy): HarnessSpec {
  const superpowers = [...new Set(answers.accounts.map(accountSlug))]
    .slice(0, SPEC_LIMITS.MAX_SUPERPOWERS)
    .map((id) => ({ id, scopes: [] as string[] }));
  const rules = (answers.constraints ?? [])
    .map((r) => sanitizeVerbatim(r).slice(0, SPEC_LIMITS.MAX_RULE_CHARS))
    .filter((r) => r.length > 0)
    .slice(0, SPEC_LIMITS.MAX_RULES);
  return {
    specVersion: 1,
    name: extraction.nameSlug,
    brain: { policy },
    mission:
      answers.kind === 'task'
        ? {
            kind: 'task',
            goal: extraction.normalizedGoal,
            // extract.ts guarantees presence for tasks; the non-null makes
            // a future regression loud instead of emitting an invalid spec.
            doneDefinition: extraction.doneDefinition!,
            worthPerRunUsd: answers.worthUsd,
          }
        : { kind: 'standing', goal: extraction.normalizedGoal },
    superpowers,
    memory: { enabled: answers.kind === 'standing' },
    rules,
    fuel: { maxUsdPerRun: fuelFromWorth(answers.worthUsd), hardStop: true },
    checkIns: superpowers.length > 0 ? [{ trigger: 'before-external-action' }] : [],
  };
}

/** Canonical spec text with the embedded content hash — the first-class
 * harness file: byte-stable, parseable, tamper-evident. */
export function specToText(spec: HarnessSpec): string {
  const hash = harnessSpecHash(spec);
  return canonicalJson({ ...spec, hash });
}
