// THE PROGRAM INTERPRETER — mixing program rung 3.
//
// A mechanism is DATA: a tree of call / if / vote / pick nodes (core
// ProgramNode). This is the one audited piece of code that runs any of them.
// Discovery (rung 4) writes programs; it never writes code.
//
// Guarantees the grammar gives for free:
//   · static bounds — programCallCount() before a run, MAX_CALLS enforced here;
//   · memoization per node — a call node referenced from a check AND a branch
//     executes once; the worst case is exactly the static count. The memo is
//     keyed on the node's STRUCTURE, never its object identity: a program is
//     data, so the one that serves has been through JSON, and JSON does not
//     preserve sharing. Identity keys made a parsed program pay twice for the
//     node a built program paid for once — same tree, different mechanism;
//   · no side effects beyond provider calls; no loops (no node recurses);
//   · every stage is traced, so the receipt can name what ran.
import type { ChatMessage, ContextSelect, ProgramCheck, ProgramNode, PromptVariant, ReasoningEffort, ToolCall, ToolSelect, Usage } from '@potion/core';
import { costUsd, MAX_PROGRAM_CALLS, programNodeKey, roundCost } from '@potion/core';
import { applyPromptVariant, selectContext, selectTools } from '@potion/core';
import { buildJudgeMessages, parsePick } from './helpers.js';
import type { ExecContext, StageTrace, StrategyResult } from './types.js';

// The ceiling is DECLARED in @potion/core beside programCallCount, so the
// schema can refuse an over-budget program at parse time instead of only
// mid-run. Re-exported here because this is where it is ENFORCED.
export { MAX_PROGRAM_CALLS } from '@potion/core';

interface NodeResult {
  text: string;
  confidence?: number;
  /** C4b: a tool call TERMINATES the program. It is a decision, not an answer
   *  to judge — the cascade has said so since MIXING M3, and the IR now says
   *  it too. Every combinator below propagates one out unchanged rather than
   *  gating on the empty text that comes with it. */
  toolCalls?: ToolCall[];
  /** Traces contributed by evaluating this node (memoized nodes contribute once). */
  trace: StageTrace[];
  usage: Usage;
}

const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 });
function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: roundCost(a.costUsd + b.costUsd),
    latencyMs: a.latencyMs + b.latencyMs,
  };
}

/** Agreement is judged on normalized text: case, whitespace, trailing punctuation. */
export function normalizeAnswer(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/g, '');
}

export async function runProgram(
  name: string,
  body: ProgramNode,
  messages: ChatMessage[],
  ctx: ExecContext,
): Promise<StrategyResult> {
  const memo = new Map<string, Promise<NodeResult>>();
  let calls = 0;

  const call = async (
    model: string,
    msgs: ChatMessage[],
    stage: string,
    reasoningEffort?: ReasoningEffort,
    promptVariant?: PromptVariant,
    contextSelect?: ContextSelect,
    toolSelect?: ToolSelect,
  ): Promise<NodeResult> => {
    if (++calls > MAX_PROGRAM_CALLS) {
      throw new Error(`program '${name}' exceeded ${MAX_PROGRAM_CALLS} calls — refused (static bound)`);
    }
    const { provider, entry } = ctx.resolve(model);
    const response = await provider.complete({
      model,
      // C4: selection first, then the instruction. Order matters — the
      // instruction is ours and must survive selection, and selection ranks
      // against the caller's question, not against text we added.
      messages: applyPromptVariant(selectContext(msgs, contextSelect), promptVariant),
      params: {
        ...(ctx.seed !== undefined ? { seed: ctx.seed } : {}),
        ...(ctx.maxOutputTokens !== undefined ? { maxTokens: ctx.maxOutputTokens } : {}),
        ...(ctx.captureConfidence ? { logprobs: true } : {}),
        // C4b: the caller's tools, forwarded UNMODIFIED, exactly as `single`
        // does. Without this a program evaluated on a tool-bearing item was
        // never offered the tools and scored zero for a reason that has
        // nothing to do with its mechanism.
        // C4 rung 4: the caller's catalogue, narrowed to what this request
        // looks like it needs. Ranked against the request text, never against
        // anything the program added.
        ...(() => {
          const kept = selectTools(ctx.params?.tools, msgs.map((m) => m.content).join('\n'), toolSelect);
          return kept !== undefined ? { tools: kept } : {};
        })(),
        ...(ctx.params?.toolChoice !== undefined ? { tool_choice: ctx.params.toolChoice } : {}),
        // C4: absent stays absent — a program that names no effort must reach
        // the wire exactly as it did before effort existed.
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      },
    });
    const usage: Usage = {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: roundCost(costUsd(response.usage, entry)),
      latencyMs: response.latencyMs,
      ...(response.usage.usageEstimated ? { usageEstimated: true as const } : {}),
    };
    const trace: StageTrace = {
      // The receipt names the effort, because "the same model" at two efforts
      // is two operating points and a stage that does not say which one ran
      // cannot be read back.
      // The receipt names every knob that was turned — two variants of one
      // model at one effort are two operating points, and a stage that cannot
      // say which one ran cannot be read back.
      stage: [
        stage,
        reasoningEffort,
        promptVariant,
        contextSelect !== undefined ? `keep${contextSelect.keepParagraphs}` : undefined,
        toolSelect !== undefined ? `tools${toolSelect.keepTools}` : undefined,
      ]
        .filter((x) => x !== undefined)
        .join(':'),
      model,
      text: response.text,
      usage,
      ...(response.logprobConfidence !== undefined ? { confidence: response.logprobConfidence } : {}),
    };
    return {
      text: response.text,
      ...(response.logprobConfidence !== undefined ? { confidence: response.logprobConfidence } : {}),
      ...(response.toolCalls !== undefined && response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      trace: [trace],
      usage,
    };
  };

  const evalNode = (node: ProgramNode): Promise<NodeResult> => {
    const key = programNodeKey(node);
    const hit = memo.get(key);
    if (hit) return hit.then((r) => ({ ...r, trace: [], usage: zeroUsage() })); // already paid for
    const p = (async (): Promise<NodeResult> => {
      switch (node.op) {
        case 'call':
          return call(node.model, messages, `program:${name}:call`, node.reasoningEffort, node.promptVariant, node.contextSelect, node.toolSelect);
        case 'if': {
          const checked = await evalCheck(node.check);
          // The check's own calls may have produced a tool call. There is
          // nothing to check, and nothing after this to run.
          if (checked.toolCalls !== undefined) {
            return { text: '', toolCalls: checked.toolCalls, trace: checked.trace, usage: checked.usage };
          }
          const branch = await evalNode(checked.ok ? node.then : node.else);
          return { ...branch, trace: [...checked.trace, ...branch.trace], usage: addUsage(checked.usage, branch.usage) };
        }
        case 'vote': {
          const results = await Promise.all(node.of.map(evalNode));
          const tool = results.find((r) => r.toolCalls !== undefined);
          if (tool !== undefined) {
            return { text: '', toolCalls: tool.toolCalls!, trace: results.flatMap((r) => r.trace), usage: results.reduce((a, r) => addUsage(a, r.usage), zeroUsage()) };
          }
          const counts = new Map<string, { n: number; first: NodeResult }>();
          for (const r of results) {
            const k = normalizeAnswer(r.text);
            const e = counts.get(k);
            if (e) e.n++; else counts.set(k, { n: 1, first: r });
          }
          let winner = results[0]!;
          let best = 0;
          for (const { n, first } of counts.values()) if (n > best) { best = n; winner = first; }
          return { text: winner.text, ...(winner.confidence !== undefined ? { confidence: winner.confidence } : {}), trace: results.flatMap((r) => r.trace), usage: results.reduce((a, r) => addUsage(a, r.usage), zeroUsage()) };
        }
        case 'pick': {
          const results = await Promise.all(node.of.map(evalNode));
          const spent = { trace: results.flatMap((r) => r.trace), usage: results.reduce((a, r) => addUsage(a, r.usage), zeroUsage()) };
          const picked = results.find((r) => r.toolCalls !== undefined);
          if (picked !== undefined) return { text: '', toolCalls: picked.toolCalls!, ...spent };
          if (node.by.kind === 'confidence') {
            const winner = results.reduce((a, b) => ((b.confidence ?? -1) > (a.confidence ?? -1) ? b : a));
            return { text: winner.text, ...(winner.confidence !== undefined ? { confidence: winner.confidence } : {}), ...spent };
          }
          // THE SAME JUDGE AS EVERY OTHER JUDGE (M2-security). This used to
          // build its own prompt — candidate answers interpolated RAW, and a
          // parse that took the first number anywhere in the reply. Measured,
          // that was steerable: a candidate embedding "PICK: 0" won even when
          // the judge's own closing verdict said otherwise, because the
          // injected digit came first. buildJudgeMessages wraps every
          // candidate in a delimited DATA block and parsePick takes the LAST
          // line-anchored PICK, which is the judge's, not a candidate's.
          const prompt: ChatMessage[] = buildJudgeMessages(messages, results.map((r) => r.text));
          const judged = await call(node.by.model, prompt, `program:${name}:judge`);
          const { index: idx } = parsePick(judged.text, results.length);
          const winner = results[idx]!;
          return { text: winner.text, ...(winner.confidence !== undefined ? { confidence: winner.confidence } : {}), trace: [...spent.trace, ...judged.trace], usage: addUsage(spent.usage, judged.usage) };
        }
      }
    })();
    memo.set(key, p);
    return p;
  };

  const evalCheck = async (
    check: ProgramCheck,
  ): Promise<{ ok: boolean; trace: StageTrace[]; usage: Usage; toolCalls?: ToolCall[] }> => {
    switch (check.kind) {
      case 'agree': {
        const [a, b] = await Promise.all([evalNode(check.of[0]), evalNode(check.of[1])]);
        const spent = { trace: [...a.trace, ...b.trace], usage: addUsage(a.usage, b.usage) };
        const tool = a.toolCalls ?? b.toolCalls;
        if (tool !== undefined) return { ok: false, ...spent, toolCalls: tool };
        return { ok: normalizeAnswer(a.text) === normalizeAnswer(b.text), ...spent };
      }
      case 'tool-called': {
        // The ONE check that does not short-circuit on a tool call: it is
        // asking whether one happened, not judging what it says. `then` is
        // normally the node that made the call, so the tool call still
        // reaches the caller — through the branch, not around it.
        const r = await evalNode(check.of);
        return { ok: r.toolCalls !== undefined, trace: r.trace, usage: r.usage };
      }
      case 'confidence': {
        const r = await evalNode(check.of);
        if (r.toolCalls !== undefined) return { ok: false, trace: r.trace, usage: r.usage, toolCalls: r.toolCalls };
        return { ok: r.confidence !== undefined && r.confidence >= check.min, trace: r.trace, usage: r.usage };
      }
      case 'regex': {
        const r = await evalNode(check.of);
        if (r.toolCalls !== undefined) return { ok: false, trace: r.trace, usage: r.usage, toolCalls: r.toolCalls };
        return { ok: new RegExp(check.pattern, 's').test(r.text), trace: r.trace, usage: r.usage };
      }
      case 'json': {
        const r = await evalNode(check.of);
        if (r.toolCalls !== undefined) return { ok: false, trace: r.trace, usage: r.usage, toolCalls: r.toolCalls };
        let ok = false;
        try {
          const m = r.text.match(/\{[\s\S]*\}/);
          const parsed = JSON.parse(m ? m[0] : r.text) as Record<string, unknown>;
          ok = parsed !== null && typeof parsed === 'object' && (check.requiredKeys ?? []).every((k) => k in parsed);
        } catch {
          ok = false;
        }
        return { ok, trace: r.trace, usage: r.usage };
      }
    }
  };

  const result = await evalNode(body);
  return {
    text: result.text,
    trace: result.trace,
    usage: result.usage,
    ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
  };
}

// ---- reference programs (the first potions, as data) ----

/** Two cheap models answer; if they agree the more confident stands, else the strong one decides. */
export function consensusOrEscalate(name: string, cheapA: string, cheapB: string, strong: string): ProgramNode {
  const a: ProgramNode = { op: 'call', model: cheapA };
  const b: ProgramNode = { op: 'call', model: cheapB };
  return { op: 'if', check: { kind: 'agree', of: [a, b] }, then: { op: 'pick', of: [a, b], by: { kind: 'confidence' } }, else: { op: 'call', model: strong } };
}

/** Cheap model answers; a fact-check (JSON shape / regex) decides whether to trust it. */
export function verifiedCascade(cheap: string, strong: string, check: { kind: 'json'; requiredKeys?: string[] } | { kind: 'regex'; pattern: string }): ProgramNode {
  const c: ProgramNode = { op: 'call', model: cheap };
  const chk: ProgramCheck = check.kind === 'json' ? { kind: 'json', of: c, ...(check.requiredKeys ? { requiredKeys: check.requiredKeys } : {}) } : { kind: 'regex', of: c, pattern: check.pattern };
  return { op: 'if', check: chk, then: c, else: { op: 'call', model: strong } };
}

/** Cheap model answers; escalate when its confidence is below τ. */
export function confidenceGatedCascade(cheap: string, strong: string, tau: number): ProgramNode {
  const c: ProgramNode = { op: 'call', model: cheap };
  return { op: 'if', check: { kind: 'confidence', of: c, min: tau }, then: c, else: { op: 'call', model: strong } };
}
