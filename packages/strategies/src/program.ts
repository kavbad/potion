// THE PROGRAM INTERPRETER — mixing program rung 3.
//
// A mechanism is DATA: a tree of call / if / vote / pick nodes (core
// ProgramNode). This is the one audited piece of code that runs any of them.
// Discovery (rung 4) writes programs; it never writes code.
//
// Guarantees the grammar gives for free:
//   · static bounds — programCallCount() before a run, MAX_CALLS enforced here;
//   · memoization per node — a call node referenced from a check AND a branch
//     executes once; the worst case is exactly the static count;
//   · no side effects beyond provider calls; no loops (no node recurses);
//   · every stage is traced, so the receipt can name what ran.
import type { ChatMessage, ProgramCheck, ProgramNode, Usage } from '@potion/core';
import { costUsd, roundCost } from '@potion/core';
import type { ExecContext, StageTrace, StrategyResult } from './types.js';

export const MAX_PROGRAM_CALLS = 8;

interface NodeResult {
  text: string;
  confidence?: number;
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
  const memo = new Map<ProgramNode, Promise<NodeResult>>();
  let calls = 0;

  const call = async (model: string, msgs: ChatMessage[], stage: string): Promise<NodeResult> => {
    if (++calls > MAX_PROGRAM_CALLS) {
      throw new Error(`program '${name}' exceeded ${MAX_PROGRAM_CALLS} calls — refused (static bound)`);
    }
    const { provider, entry } = ctx.resolve(model);
    const response = await provider.complete({
      model,
      messages: msgs,
      params: {
        ...(ctx.seed !== undefined ? { seed: ctx.seed } : {}),
        ...(ctx.maxOutputTokens !== undefined ? { maxTokens: ctx.maxOutputTokens } : {}),
        ...(ctx.captureConfidence ? { logprobs: true } : {}),
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
      stage,
      model,
      text: response.text,
      usage,
      ...(response.logprobConfidence !== undefined ? { confidence: response.logprobConfidence } : {}),
    };
    return { text: response.text, ...(response.logprobConfidence !== undefined ? { confidence: response.logprobConfidence } : {}), trace: [trace], usage };
  };

  const evalNode = (node: ProgramNode): Promise<NodeResult> => {
    const hit = memo.get(node);
    if (hit) return hit.then((r) => ({ ...r, trace: [], usage: zeroUsage() })); // already paid for
    const p = (async (): Promise<NodeResult> => {
      switch (node.op) {
        case 'call':
          return call(node.model, messages, `program:${name}:call`);
        case 'if': {
          const { ok, trace, usage } = await evalCheck(node.check);
          const branch = await evalNode(ok ? node.then : node.else);
          return { ...branch, trace: [...trace, ...branch.trace], usage: addUsage(usage, branch.usage) };
        }
        case 'vote': {
          const results = await Promise.all(node.of.map(evalNode));
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
          if (node.by.kind === 'confidence') {
            const winner = results.reduce((a, b) => ((b.confidence ?? -1) > (a.confidence ?? -1) ? b : a));
            return { text: winner.text, ...(winner.confidence !== undefined ? { confidence: winner.confidence } : {}), ...spent };
          }
          const prompt: ChatMessage[] = [
            { role: 'system', content: 'You are a strict judge. Reply with only the number of the best candidate answer.' },
            { role: 'user', content: `${messages.map((m) => `${m.role}: ${m.content}`).join('\n')}\n\n${results.map((r, i) => `Candidate ${i + 1}:\n${r.text}`).join('\n\n')}\n\nBest candidate number:` },
          ];
          const judged = await call(node.by.model, prompt, `program:${name}:judge`);
          const idx = Math.max(0, Math.min(results.length - 1, (parseInt(judged.text.match(/\d+/)?.[0] ?? '1', 10) || 1) - 1));
          const winner = results[idx]!;
          return { text: winner.text, ...(winner.confidence !== undefined ? { confidence: winner.confidence } : {}), trace: [...spent.trace, ...judged.trace], usage: addUsage(spent.usage, judged.usage) };
        }
      }
    })();
    memo.set(node, p);
    return p;
  };

  const evalCheck = async (check: ProgramCheck): Promise<{ ok: boolean; trace: StageTrace[]; usage: Usage }> => {
    switch (check.kind) {
      case 'agree': {
        const [a, b] = await Promise.all([evalNode(check.of[0]), evalNode(check.of[1])]);
        return { ok: normalizeAnswer(a.text) === normalizeAnswer(b.text), trace: [...a.trace, ...b.trace], usage: addUsage(a.usage, b.usage) };
      }
      case 'confidence': {
        const r = await evalNode(check.of);
        return { ok: r.confidence !== undefined && r.confidence >= check.min, trace: r.trace, usage: r.usage };
      }
      case 'regex': {
        const r = await evalNode(check.of);
        return { ok: new RegExp(check.pattern, 's').test(r.text), trace: r.trace, usage: r.usage };
      }
      case 'json': {
        const r = await evalNode(check.of);
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
  return { text: result.text, trace: result.trace, usage: result.usage };
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
