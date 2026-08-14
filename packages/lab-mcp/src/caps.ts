// Per-tool caps (Step 10 §4) — what they meter, precisely. All fail-closed,
// all recorded, all derived from the DURABLE step record rather than
// in-memory counters: a resumed leg's meters are correct by construction,
// because the checkpoints ARE the state (the capstone lesson applied to
// metering). Crossing a cap never kills the run — it kills the TOOL for
// the run, typed, and the model routes around or completes without it.
//
// The run-level fuel hard stop is unchanged and OUTER (est currency, Step 8
// semantics); these are an inner partition of the same accounting plus the
// two non-dollar meters.

/** Structural step shape — matches lab-runtime's checkpointed steps without
 * importing them (the dependency points lab-runtime → lab-mcp). */
export interface StepLike {
  kind: string;
  payload: unknown;
}

interface StepPayloadLike {
  toolName?: string;
  toolOutput?: unknown;
  toolCalls?: Array<{ function?: { name?: string } }>;
  estCostUsd?: number;
}

export interface ToolCapConfig {
  maxCalls: number;
  /** Cumulative post-truncation result bytes per (run, tool). */
  maxResultBytes: number;
  /** Per-call truncation threshold — truncate-with-typed-marker FIRST;
   * the cumulative cap is crossed only by many large results. */
  maxPerCallBytes: number;
  /** superpower.maxSpendUsdPerRun when set; null = unmetered dollars. */
  maxAttributedEstUsd: number | null;
  /** superpower.maxSpendUsdPerDay — enforced at GRANT scope across runs
   * via the daily rollup the caller supplies; null = no daily cap. */
  maxAttributedEstUsdPerDay: number | null;
}

export const DEFAULT_TOOL_CAPS: ToolCapConfig = {
  maxCalls: 20,
  maxResultBytes: 256 * 1024,
  maxPerCallBytes: 64 * 1024,
  maxAttributedEstUsd: null,
  maxAttributedEstUsdPerDay: null,
};

/**
 * ATTRIBUTION RULE (PROVISIONAL, labeled — the WORTH_TO_FUEL convention):
 * a tool's attributed spend is the est cost of the model steps that
 * EMITTED calls to it. This under-counts result-processing tokens and
 * over-counts multi-intent steps; once live per-tool traffic exists,
 * re-derive attribution from observed step composition and RETIRE this
 * rule. The pin test greps this note — do not detach it from the code.
 */
export function attributedEstUsd(steps: StepLike[], toolName: string): number {
  let total = 0;
  for (const s of steps) {
    if (s.kind !== 'model') continue;
    const p = s.payload as StepPayloadLike;
    if (p.toolCalls?.some((c) => c.function?.name === toolName)) total += p.estCostUsd ?? 0;
  }
  return total;
}

/**
 * GRANT-SCOPED attributed spend (Step 10 review fix): the est cost of the
 * model steps that emitted a call to ANY tool under `connectorPrefix`
 * (namespaced `<connector>.<tool>`). The DOLLAR caps meter here, not
 * per-tool — the operator's `maxSpendUsdPerRun` / `maxSpendUsdPerDay` on a
 * superpower is ONE budget for the whole connection, so a connector with N
 * tools must NOT get N× the ceiling (metering per-tool was fail-open by a
 * factor of the tool count). A step is attributed once even if it emitted
 * several of the connector's tools (max, not sum — the step's tokens are
 * one purchase). callCount / resultBytes stay per-tool (spec §4 table).
 */
export function attributedEstUsdForConnector(steps: StepLike[], connectorPrefix: string): number {
  const prefix = `${connectorPrefix}.`;
  let total = 0;
  for (const s of steps) {
    if (s.kind !== 'model') continue;
    const p = s.payload as StepPayloadLike;
    if (p.toolCalls?.some((c) => (c.function?.name ?? '').startsWith(prefix))) {
      total += p.estCostUsd ?? 0;
    }
  }
  return total;
}

export function toolCallCount(steps: StepLike[], toolName: string): number {
  return steps.filter(
    (s) => s.kind === 'tool' && (s.payload as StepPayloadLike).toolName === toolName,
  ).length;
}

export function toolResultBytes(steps: StepLike[], toolName: string): number {
  let total = 0;
  for (const s of steps) {
    if (s.kind !== 'tool') continue;
    const p = s.payload as StepPayloadLike;
    if (p.toolName !== toolName) continue;
    total += Buffer.byteLength(JSON.stringify(p.toolOutput ?? null), 'utf8');
  }
  return total;
}

export type CapExceeded = 'calls' | 'result-bytes' | 'spend' | 'spend-day';

/** The typed refusal result a capped tool feeds the model — recorded as an
 * ordinary tool step (the record says the cap tripped; the report says the
 * run finished without the tool). */
export interface CapRefusal {
  capExceeded: CapExceeded;
  toolName: string;
  detail: string;
}

/** Check every meter BEFORE a call executes.
 *   · callCount / resultBytes — per (run, TOOL), read from `steps` (spec §4)
 *   · attributed spend (run + day) — per GRANT: the caller supplies the
 *     grant-scoped figures (`runAttributedUsd` summed over the connector's
 *     tools this run, `dayAttributedUsd` over today), because the operator's
 *     dollar budget is one ceiling for the whole connection, not per-tool
 *     (Step 10 review: metering the dollars per-tool was fail-open by the
 *     tool count). Omit them (0) when no dollar cap is set. */
export function checkToolCaps(
  steps: StepLike[],
  toolName: string,
  caps: ToolCapConfig,
  dayAttributedUsd = 0,
  runAttributedUsd = 0,
): CapRefusal | null {
  const calls = toolCallCount(steps, toolName);
  if (calls >= caps.maxCalls) {
    return {
      capExceeded: 'calls',
      toolName,
      detail: `call cap reached: ${calls} of ${caps.maxCalls} calls this run`,
    };
  }
  const bytes = toolResultBytes(steps, toolName);
  if (bytes >= caps.maxResultBytes) {
    return {
      capExceeded: 'result-bytes',
      toolName,
      detail: `cumulative result cap reached: ${bytes} of ${caps.maxResultBytes} bytes this run`,
    };
  }
  if (caps.maxAttributedEstUsd !== null && runAttributedUsd >= caps.maxAttributedEstUsd) {
    return {
      capExceeded: 'spend',
      toolName,
      detail: `attributed est spend cap reached: $${runAttributedUsd.toFixed(4)} of $${caps.maxAttributedEstUsd} this run, grant scope (PROVISIONAL attribution)`,
    };
  }
  if (caps.maxAttributedEstUsdPerDay !== null && dayAttributedUsd >= caps.maxAttributedEstUsdPerDay) {
    return {
      capExceeded: 'spend-day',
      toolName,
      detail: `daily attributed est spend cap reached: $${dayAttributedUsd.toFixed(4)} of $${caps.maxAttributedEstUsdPerDay} today (grant scope)`,
    };
  }
  return null;
}

export interface TruncatedResult {
  truncated: true;
  bytes: number;
  originalBytes: number;
  text: string;
}

/** Per-call truncation with the TYPED marker (never silent). Applied to the
 * textual result before it becomes a tool output. */
export function truncateResult(text: string, maxBytes: number): string | TruncatedResult {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (originalBytes <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  // avoid splitting a multi-byte char: toString drops a trailing partial
  const cut = buf.toString('utf8').replace(/�+$/, '');
  return { truncated: true, bytes: Buffer.byteLength(cut, 'utf8'), originalBytes, text: cut };
}
