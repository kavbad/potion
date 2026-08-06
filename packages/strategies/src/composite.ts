// `composite` strategy interpreter (M3 #23, SPEC §12.6): stream from a cheap
// startModel; when confidence falls below upgradeIf.confidenceBelow, restart
// from upgradeModel WITH the already-generated prefix as context. The client
// sees ONE coherent token stream; the keep/upgrade decision lives in the
// StageTrace (`decision: 'kept' | 'upgraded'`), never in the stream.
//
// Confidence: the start call's logprobConfidence when the provider exposes it
// (mock always; live OpenAI when params.logprobs is honored), else the SAME
// calibrated self-report probe cascade uses (buildSelfReportMessages +
// calibrateSelfReport, reused from ./cascade.js — one calibration constant).
//
// Threshold boundary (documented contract): confidence STRICTLY below
// upgradeIf.confidenceBelow upgrades; confidence == threshold is KEPT.
//
// Streaming (ctx.stream provided — composite is the second strategy after
// 'single' to honor it): the Provider contract resolves confidence only at
// completion, so the interpreter buffers the first
// COMPOSITE_STREAM_BUFFER_TOKENS token-chunks of the start answer, evaluates
// confidence, then either
//   kept     → flush-and-continue: buffered chunks + the rest of the start
//              answer (indistinguishable from a plain 'single' stream);
//   upgraded → flush-then-switch: the buffered prefix chunks go out first
//              (the client already "saw" them when the decision fired), then
//              the upgrade model's continuation is emitted seamlessly — no
//              meta-commentary in the client stream. result.text is exactly
//              what the client received: prefix + upgrade continuation.
// Non-stream upgraded: the FULL start answer is the context prefix and
// result.text is the upgrade model's text only (SPEC §12.6: "final text =
// coherent continuation" of the full-answer restart).
//
// Cost: sum of stage costs via prices — start always, self-report probe when
// needed, upgrade only when triggered. Usage/cost aggregated across ALL calls.
import { lastAnchoredValue, wrapUntrustedData } from '@potion/core';
import type { ChatMessage, StrategyConfig } from '@potion/core';
import { SELF_REPORT_FALLBACK_RAW, buildSelfReportMessages, calibrateSelfReport } from './cascade.js';
import { addUsage, baseSeedOf, callModel, zeroUsage } from './helpers.js';
import { streamChunks } from './single.js';
import type { ExecContext, StageTrace, StrategyResult } from './types.js';

type CompositeConfig = Extract<StrategyConfig, { type: 'composite' }>;

/** Tokens of the start answer buffered before the keep/upgrade decision
 * (SPEC §12.6 "first token-batch"; Provider confidence resolves at
 * completion, so the buffer is internal — see file header). */
export const COMPOSITE_STREAM_BUFFER_TOKENS = 20;

/** System note prepended to the start model's partial answer in the upgrade
 * prompt (SPEC §12.6 prompt shape). Exported for tests/contract pinning. */
export const COMPOSITE_UPGRADE_NOTE =
  'A cheaper model produced this partial answer; continue/improve it:';

/** Bounded self-report value pattern (same rule as cascade). */
const CONFIDENCE_VALUE_PATTERN = '0?\\.\\d+|1(?:\\.0+)?';

/**
 * Upgrade prompt: the original messages plus a trailing system note carrying
 * the start model's partial answer as context prefix. The partial is
 * untrusted model output → wrapped in DATA markers (M2-security convention,
 * same as cascade's self-report probe; the mock strips markers on extract).
 */
export function buildCompositeUpgradeMessages(
  original: ChatMessage[],
  partial: string,
): ChatMessage[] {
  return [
    ...original,
    { role: 'system', content: `${COMPOSITE_UPGRADE_NOTE}\n${wrapUntrustedData(partial)}` },
  ];
}

export async function runComposite(
  strategy: CompositeConfig,
  messages: ChatMessage[],
  ctx: ExecContext,
): Promise<StrategyResult> {
  const trace: StageTrace[] = [];
  const total = zeroUsage();
  const baseSeed = baseSeedOf(ctx, messages);
  let callOffset = 0;
  const threshold = strategy.upgradeIf.confidenceBelow;

  // ---- stage 0: start model (always) ----
  const start = await callModel(strategy.startModel, messages, ctx, baseSeed + callOffset++);
  addUsage(total, start.usage);

  // Confidence: logprob when exposed, else calibrated self-report probe
  // (probe usage is real spend and folds into the total, like cascade).
  let confidence: number;
  const probeEntries: StageTrace[] = [];
  if (start.logprobConfidence !== undefined) {
    confidence = start.logprobConfidence;
  } else {
    const probe = await callModel(
      strategy.startModel,
      buildSelfReportMessages(messages, start.text),
      ctx,
      baseSeed + callOffset++,
    );
    addUsage(total, probe.usage);
    const v = lastAnchoredValue(probe.text, 'CONFIDENCE', CONFIDENCE_VALUE_PATTERN);
    const raw = v !== null ? Number(v) : SELF_REPORT_FALLBACK_RAW;
    probeEntries.push({
      stage: 'composite-start-self-report',
      model: strategy.startModel,
      text: probe.text,
      usage: probe.usage,
      confidence: raw,
      decision:
        v !== null ? 'self-report' : `self-report-unparseable-default-${SELF_REPORT_FALLBACK_RAW}`,
    });
    confidence = calibrateSelfReport(raw);
  }

  // Boundary: STRICTLY below upgrades; == keeps.
  const upgraded = confidence < threshold;

  trace.push({
    stage: 'composite-start',
    model: strategy.startModel,
    text: start.text,
    usage: start.usage,
    confidence,
    decision: upgraded ? 'upgraded' : 'kept',
  });
  trace.push(...probeEntries);

  if (!upgraded) {
    // kept: flush-and-continue — one coherent stream of the start answer.
    if (ctx.stream) for (const chunk of streamChunks(start.text)) ctx.stream(chunk);
    return { text: start.text, trace, usage: total };
  }

  // upgraded: the context prefix is the buffered first-N token batch when
  // streaming, else the full start answer.
  const prefixChunks = ctx.stream
    ? streamChunks(start.text).slice(0, COMPOSITE_STREAM_BUFFER_TOKENS)
    : [];
  const partial = ctx.stream ? prefixChunks.join('') : start.text;

  // flush-then-switch: the buffered prefix goes out BEFORE the upgrade call,
  // then the upgrade continuation streams seamlessly (no meta-commentary).
  if (ctx.stream) for (const chunk of prefixChunks) ctx.stream(chunk);

  const upgrade = await callModel(
    strategy.upgradeModel,
    buildCompositeUpgradeMessages(messages, partial),
    ctx,
    baseSeed + callOffset++,
  );
  addUsage(total, upgrade.usage);
  trace.push({
    stage: 'composite-upgrade',
    model: strategy.upgradeModel,
    text: upgrade.text,
    usage: upgrade.usage,
    ...(upgrade.logprobConfidence !== undefined ? { confidence: upgrade.logprobConfidence } : {}),
    decision: 'upgraded',
  });
  if (ctx.stream) for (const chunk of streamChunks(upgrade.text)) ctx.stream(chunk);

  return { text: ctx.stream ? partial + upgrade.text : upgrade.text, trace, usage: total };
}
