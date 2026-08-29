// Every numeric cap in the harness spec, one place, one comment each.
// The oversized-fixture class in the corpus exercises each of these.

/** Total raw input bytes. Checked BEFORE any JSON.parse — running a parser
 * on a 100 MB input is the denial of service, not the overflow after it. */
export const MAX_TOTAL_BYTES = 64 * 1024;

/** Human label; long names are a UI problem, not an expressiveness need. */
export const MAX_NAME_CHARS = 120;

/** Mission goal / done-definition: generous prose, bounded so a spec cannot
 * smuggle a novel (or a context-window bomb) into a single field. */
export const MAX_GOAL_CHARS = 4_000;

/** Rules are plain-language governance lines, not documents. */
export const MAX_RULE_CHARS = 2_000;
export const MAX_RULES = 100;

/** Catalog references, not an inventory. */
export const MAX_SUPERPOWERS = 50;
export const MAX_SCOPES_PER_SUPERPOWER = 20;
export const MAX_SCOPE_CHARS = 200;
export const MAX_SUPERPOWER_ID_CHARS = 200;

export const MAX_CHECKINS = 25;
export const MAX_QUESTION_CHARS = 1_000;
export const MAX_CRON_CHARS = 100;
export const MAX_EXEMPLAR_CHARS = 2_000;

/** Object/array nesting. The deepest legitimate path in v1 is 4 levels;
 * 12 leaves headroom for policy sub-objects while making depth bombs a
 * typed rejection instead of a stack overflow. */
export const MAX_DEPTH = 12;
