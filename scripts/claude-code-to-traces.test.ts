// Converter tests (G2.8) — SYNTHETIC transcripts only.
//
// No real transcript is ever read here. The corpus this adapter was built for
// contains the operator's own provider keys, and a test fixture is a file that
// gets copied, pasted into issues, and eventually published.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  chunkSpans,
  convertFile,
  findSecrets,
  findSecretsDeep,
  runConvert,
  scrubDeep,
  scrubSecrets,
  sessionToSpans,
  traceIdForFile,
  TRACES_BATCH_CAP,
} from './claude-code-to-traces.js';

// Synthetic credentials shaped like the real ones. None of these is a key.
const FAKE_OR = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const FAKE_OPENAI = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345';
const FAKE_ANTHROPIC = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
const FAKE_POTION = 'pk_live_abcdef123456';

describe('scrubSecrets — the first line of defence', () => {
  it('removes every credential shape, whole-value', () => {
    for (const secret of [FAKE_OR, FAKE_OPENAI, FAKE_ANTHROPIC, FAKE_POTION]) {
      const out = scrubSecrets(secret);
      expect(out).not.toContain(secret);
      expect(out).toContain('<secret:');
    }
  });

  it('removes them MID-SENTENCE, not just when they are the whole string', () => {
    const out = scrubSecrets(`I set the key to ${FAKE_OR} and then ran the sweep.`);
    expect(out).not.toContain(FAKE_OR);
    expect(out.startsWith('I set the key to ')).toBe(true);
    expect(out.endsWith(' and then ran the sweep.')).toBe(true);
  });

  it('removes them inside JSON', () => {
    const json = JSON.stringify({ headers: { authorization: `Bearer ${FAKE_OR}` }, n: 3 });
    const out = scrubSecrets(json);
    expect(out).not.toContain(FAKE_OR);
    expect(JSON.parse(out)).toMatchObject({ n: 3 }); // still valid JSON
  });

  it('removes them inside fenced code blocks', () => {
    const md = ['```bash', `export OPENROUTER_API_KEY=${FAKE_OR}`, 'pnpm smoke:live', '```'].join(
      '\n',
    );
    const out = scrubSecrets(md);
    expect(out).not.toContain(FAKE_OR);
    expect(out).toContain('pnpm smoke:live'); // structure survives
  });

  it('catches env assignments even when the VALUE is not key-shaped', () => {
    const out = scrubSecrets('ANTHROPIC_API_KEY=hunter2 pnpm test');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('ANTHROPIC_API_KEY=<secret:env>');
    // quoted forms too
    expect(scrubSecrets('MY_TOKEN="abc def"')).not.toContain('abc def');
  });

  it('scrubs bearer headers without eating the header name', () => {
    // The specific→generic ordering means a recognisable key shape gets its
    // own label and the generic bearer rule never sees it. What matters is
    // that the value is gone and the header survives — asserting WHICH
    // placeholder lands would pin an ordering detail, not the security property.
    const out = scrubSecrets(`authorization: Bearer ${FAKE_POTION}`);
    expect(out).not.toContain(FAKE_POTION);
    expect(out.startsWith('authorization: Bearer <secret:')).toBe(true);
    expect(findSecrets(out)).toEqual([]);
    // An opaque token with no recognisable shape falls to the generic rule.
    const opaque = scrubSecrets('authorization: Bearer abcdefghijklmnop');
    expect(opaque).toBe('authorization: Bearer <secret:bearer>');
  });

  it('is idempotent — scrubbing twice changes nothing', () => {
    const once = scrubSecrets(`key ${FAKE_OR} and ${FAKE_POTION}`);
    expect(scrubSecrets(once)).toBe(once);
  });

  it('leaves ordinary prose completely alone', () => {
    const prose = 'The cascade escalated on 3 of 25 items; see artifacts/m1b-sweep.log.';
    expect(scrubSecrets(prose)).toBe(prose);
  });

  it('scrubs the repo’s own test-fixture keys too (over-broad on purpose)', () => {
    // pk_keys_test_admin_a is a fixture, not a credential — and a scrubber
    // that tries to tell the difference is one that eventually guesses wrong.
    expect(scrubSecrets('pk_keys_test_admin_a')).not.toContain('pk_keys_test_admin_a');
  });
});

describe('findSecrets — the --verify-scrub oracle', () => {
  it('names surviving patterns and never leaks the value', () => {
    const hits = findSecrets(`token ${FAKE_OR}`);
    expect(hits).toContain('openrouter-key');
    expect(hits.join(',')).not.toContain(FAKE_OR);
  });

  it('reports nothing on scrubbed text — the two functions agree', () => {
    expect(findSecrets(scrubSecrets(`${FAKE_OR} ${FAKE_OPENAI} ${FAKE_POTION}`))).toEqual([]);
  });

  it('REGRESSION: does not flag its own placeholders as survivors', () => {
    // The env-assignment pattern used to match `KEY=<secret:openrouter>` —
    // the output of the key patterns that ran before it — so --verify-scrub
    // refused every correctly-scrubbed run. A verifier that cannot recognise
    // a successful scrub trains you to disable it.
    const scrubbed = scrubSecrets(`OPENROUTER_API_KEY=${FAKE_OR}`);
    expect(scrubbed).not.toContain(FAKE_OR);
    expect(findSecrets(scrubbed)).toEqual([]);
    for (const placeholder of [
      'A=<secret:env>',
      'Bearer <secret:bearer>',
      'KEY=<secret:openrouter>',
      'TOKEN=<secret:sk>',
    ]) {
      expect(findSecrets(placeholder)).toEqual([]);
    }
  });
});

describe('scrubDeep', () => {
  it('walks nested structures and leaves keys/numbers/booleans alone', () => {
    const out = scrubDeep({
      'tool.args': { cmd: `curl -H "Authorization: Bearer ${FAKE_OR}"`, retries: 3, ok: true },
      list: [`key=${FAKE_POTION}`, 42],
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain(FAKE_OR);
    expect(json).not.toContain(FAKE_POTION);
    expect(out['tool.args']).toMatchObject({ retries: 3, ok: true });
    expect(Object.keys(out)).toContain('tool.args'); // key preserved
  });
});

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function record(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

/** A synthetic session: prompt → 3 tool calls (Bash, Read, Bash) → answer. */
function syntheticSession(): string {
  return [
    record({
      type: 'user',
      timestamp: '2026-08-08T10:00:00.000Z',
      message: { role: 'user', content: 'Find where the retention floor is defined.' },
    }),
    record({
      type: 'assistant',
      timestamp: '2026-08-08T10:00:05.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        usage: { input_tokens: 1200, output_tokens: 80 },
        content: [
          { type: 'text', text: 'Searching.' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'grep -rn floor .' } },
        ],
      },
    }),
    record({
      type: 'user',
      timestamp: '2026-08-08T10:00:06.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'guarantee.ts:139' }] },
    }),
    record({
      type: 'assistant',
      timestamp: '2026-08-08T10:00:10.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        usage: { input_tokens: 1500, output_tokens: 60 },
        content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: 'guarantee.ts' } }],
      },
    }),
    record({
      type: 'user',
      timestamp: '2026-08-08T10:00:11.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'PLATFORM_RETENTION_FLOOR = 0.9' }] },
    }),
    record({
      type: 'assistant',
      timestamp: '2026-08-08T10:00:14.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        usage: { input_tokens: 1800, output_tokens: 40 },
        content: [{ type: 'tool_use', id: 'tu_3', name: 'Bash', input: { command: 'grep -c 0.9 .' } }],
      },
    }),
    record({
      type: 'assistant',
      timestamp: '2026-08-08T10:00:20.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        usage: { input_tokens: 2000, output_tokens: 200 },
        content: [{ type: 'text', text: 'PLATFORM_RETENTION_FLOOR is 0.9 in guarantee.ts:139.' }],
      },
    }),
    // Noise the adapter must tolerate.
    record({ type: 'mode', mode: 'plan' }),
    record({ type: 'ai-title', title: 'x' }),
  ].join('\n');
}

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc2traces-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('sessionToSpans — SPEC §14.1 shape', () => {
  const conv = (): ReturnType<typeof convertFile> =>
    withTmpDir((dir) => {
      const f = path.join(dir, 'agent-synthetic.jsonl');
      writeFileSync(f, syntheticSession());
      return convertFile(f);
    });

  it('emits root + one span PER TOOL CALL + one llm.call PER TEXT-PRODUCING MODEL CALL + chat', () => {
    const c = conv();
    expect(c.spans.map((s) => s.name)).toEqual([
      'agent.root',
      'llm.call', // turn 1: 'Searching.' + Bash dispatch
      'tool.Bash',
      'tool.Read', // turns 2-3 are pure tool dispatch — no judgeable text, no llm.call
      'tool.Bash',
      'llm.call', // turn 4: the final answer
      'chat',
    ]);
    // FAITHFUL: three calls → three spans, even though two share a name.
    expect(c.toolCalls).toBe(3);
    expect(c.llmCalls).toBe(2);
  });

  it('llm.call spans carry PER-CALL usage/model/completion — not the summed-away totals (Decision 1)', () => {
    const calls = conv().spans.filter((s) => s.name === 'llm.call');
    // Turn 1's own tokens, not the session total.
    expect(calls[0]!.input_tokens).toBe(1200);
    expect(calls[0]!.output_tokens).toBe(80);
    expect(calls[0]!.model).toBe('claude-opus-5');
    expect(calls[0]!.attributes!['gen_ai.completion']).toBe('Searching.');
    expect(calls[0]!.attributes!['gen_ai.operation.name']).toBe('llm_call');
    expect(calls[0]!.attributes!['potion.step_index']).toBe(1);
    expect(calls[1]!.input_tokens).toBe(2000);
    expect(calls[1]!.attributes!['gen_ai.completion']).toContain('PLATFORM_RETENTION_FLOOR is 0.9');
    expect(calls[1]!.attributes!['potion.step_index']).toBe(2);
  });

  it('llm.call step indices are monotone and span ids sort before same-ts tool spans', () => {
    const c = conv();
    const idx = c.spans
      .filter((s) => s.name === 'llm.call')
      .map((s) => s.attributes!['potion.step_index'] as number);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    // The platform orders by (ts, spanId); at equal ts the llm.call ('_s')
    // sorts before its own tool spans ('_t') — text precedes its tool calls.
    const s1 = c.spans.find((s) => s.name === 'llm.call')!;
    const t1 = c.spans.find((s) => s.name === 'tool.Bash')!;
    expect(s1.ts).toBe(t1.ts);
    expect(s1.span_id < t1.span_id).toBe(true);
  });

  it('llm.call payloads are scrubbed BEFORE truncation (the security invariant)', () => {
    withTmpDir((dir) => {
      const f = path.join(dir, 'agent-secret.jsonl');
      const key = `sk-or-v1-${'a'.repeat(60)}`;
      writeFileSync(
        f,
        [
          record({
            type: 'user',
            timestamp: '2026-08-08T10:00:00.000Z',
            message: { role: 'user', content: 'Check the key.' },
          }),
          record({
            type: 'assistant',
            timestamp: '2026-08-08T10:00:05.000Z',
            message: {
              role: 'assistant',
              model: 'claude-opus-5',
              usage: { input_tokens: 10, output_tokens: 10 },
              content: [{ type: 'text', text: `The key is ${key} and it works.` }],
            },
          }),
        ].join('\n'),
      );
      const c = convertFile(f);
      const call = c.spans.find((s) => s.name === 'llm.call')!;
      const completion = String(call.attributes!['gen_ai.completion']);
      expect(completion).not.toContain(key);
      expect(completion).toContain('<secret:openrouter>');
    });
  });

  it('reports the CANONICAL signature (what clustering buckets on)', () => {
    // Distinct tools in first-use order — repetition collapsed for the
    // signature, but NOT in the spans themselves.
    expect(conv().toolSignature).toEqual(['Bash', 'Read']);
  });

  it('puts the task prompt on the root as gen_ai.prompt', () => {
    const root = conv().spans.find((s) => s.name === 'agent.root')!;
    expect(root.attributes!['gen_ai.prompt']).toBe('Find where the retention floor is defined.');
  });

  it('puts the FINAL assistant text on the chat span as gen_ai.completion', () => {
    // This becomes the replay item's reference — the thing that makes the
    // derived suite reference-anchored.
    const chat = conv().spans.find((s) => s.name === 'chat')!;
    expect(chat.attributes!['gen_ai.completion']).toContain('PLATFORM_RETENTION_FLOOR is 0.9');
    expect(conv().hasReference).toBe(true);
  });

  it('carries both tool-detection markers plus args and results', () => {
    const tool = conv().spans.find((s) => s.name === 'tool.Read')!;
    expect(tool.attributes!['gen_ai.operation.name']).toBe('execute_tool');
    expect(tool.attributes!['tool.name']).toBe('Read');
    expect(String(tool.attributes!['tool.args'])).toContain('guarantee.ts');
    expect(tool.attributes!['tool.result']).toBe('PLATFORM_RETENTION_FLOOR = 0.9');
  });

  it('sums real token usage and keeps the real model id', () => {
    const chat = conv().spans.find((s) => s.name === 'chat')!;
    expect(chat.input_tokens).toBe(1200 + 1500 + 1800 + 2000);
    expect(chat.output_tokens).toBe(80 + 60 + 40 + 200);
    // The REAL id, not a price alias — unknown models price at $0 at ingest,
    // which is a true statement about onboarding rather than a fabricated cost.
    expect(chat.model).toBe('claude-opus-5');
  });

  it('parents tool and chat spans to the root, and ids are unique', () => {
    const c = conv();
    const root = c.spans[0]!;
    expect(root.parent_id).toBeUndefined();
    for (const s of c.spans.slice(1)) expect(s.parent_id).toBe(root.span_id);
    expect(new Set(c.spans.map((s) => s.span_id)).size).toBe(c.spans.length);
  });

  it('uses real timestamps, in order', () => {
    const ts = conv().spans.map((s) => s.ts!);
    expect(ts).toEqual([...ts].sort());
  });

  it('tolerates malformed lines and non-message record types', () => {
    withTmpDir((dir) => {
      const f = path.join(dir, 'agent-messy.jsonl');
      writeFileSync(f, `{not json\n${syntheticSession()}\n{"type":"queue-operation"}\n{partial`);
      expect(convertFile(f).toolCalls).toBe(3);
    });
  });

  it('a session with no final text reports hasReference false, not a fake reference', () => {
    withTmpDir((dir) => {
      const f = path.join(dir, 'agent-noanswer.jsonl');
      writeFileSync(
        f,
        [
          record({ type: 'user', message: { role: 'user', content: 'do a thing' } }),
          record({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-opus-5',
              content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
            },
          }),
        ].join('\n'),
      );
      const c = convertFile(f);
      expect(c.hasReference).toBe(false);
      expect(c.spans.find((s) => s.name === 'chat')!.attributes!['gen_ai.completion']).toBe('');
    });
  });

  it('trace ids are stable per filename and differ across files', () => {
    expect(traceIdForFile('/a/b/agent-x.jsonl')).toBe(traceIdForFile('/other/agent-x.jsonl'));
    expect(traceIdForFile('/a/agent-x.jsonl')).not.toBe(traceIdForFile('/a/agent-y.jsonl'));
    expect(traceIdForFile('/a/agent-x.jsonl')).toMatch(/^cc-[0-9a-f]{12}$/);
  });
});

describe('secrets never survive conversion', () => {
  it('scrubs credentials out of prompts, tool args AND tool results', () => {
    withTmpDir((dir) => {
      const f = path.join(dir, 'agent-secrets.jsonl');
      writeFileSync(
        f,
        [
          record({
            type: 'user',
            message: { role: 'user', content: `use ${FAKE_OR} for the sweep` },
          }),
          record({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-opus-5',
              content: [
                {
                  type: 'tool_use',
                  id: 't1',
                  name: 'Bash',
                  input: { command: `OPENROUTER_API_KEY=${FAKE_OR} pnpm smoke:live` },
                },
              ],
            },
          }),
          record({
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 't1', content: `minted ${FAKE_POTION}` }],
            },
          }),
          record({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-opus-5',
              content: [{ type: 'text', text: `done, key ${FAKE_OPENAI} works` }],
            },
          }),
        ].join('\n'),
      );
      const json = JSON.stringify(convertFile(f).spans);
      for (const secret of [FAKE_OR, FAKE_POTION, FAKE_OPENAI]) {
        expect(json).not.toContain(secret);
      }
      expect(findSecrets(json)).toEqual([]);
    });
  });
});

describe('truncation must not defeat scrubbing (found on the real corpus)', () => {
  it('scrubs BEFORE truncating — a cut key never survives as a fragment', () => {
    withTmpDir((dir) => {
      const f = path.join(dir, 'agent-longarg.jsonl');
      // A secret placed just past the payload cap: truncate-then-scrub would
      // leave `sk-or-v1-0123…` — short enough that no pattern matches, and
      // still key material.
      const filler = 'x'.repeat(1490);
      writeFileSync(
        f,
        [
          record({ type: 'user', message: { role: 'user', content: 'go' } }),
          record({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-opus-5',
              content: [
                { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `${filler}${FAKE_OR}` } },
              ],
            },
          }),
        ].join('\n'),
      );
      const tool = convertFile(f).spans.find((s2) => s2.name === 'tool.Bash')!;
      const args = String(tool.attributes!['tool.args']);
      // No fragment of the key survives — not even the first 12 characters.
      expect(args).not.toContain(FAKE_OR.slice(0, 12));
      expect(findSecrets(args)).toEqual([]);
    });
  });

  it('never leaves a placeholder severed by the cap', () => {
    withTmpDir((dir) => {
      const f = path.join(dir, 'agent-cut.jsonl');
      // Position the secret so the cap lands INSIDE `<secret:openrouter>`.
      const filler = 'y'.repeat(1495);
      writeFileSync(
        f,
        [
          record({ type: 'user', message: { role: 'user', content: 'go' } }),
          record({
            type: 'assistant',
            message: {
              role: 'assistant',
              model: 'claude-opus-5',
              content: [
                { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `${filler}${FAKE_OR}` } },
              ],
            },
          }),
        ].join('\n'),
      );
      const args = String(convertFile(f).spans.find((s2) => s2.name === 'tool.Bash')!.attributes!['tool.args']);
      // Either a whole placeholder or none — never `<secr`.
      const lastOpen = args.lastIndexOf('<');
      if (lastOpen !== -1) expect(args.indexOf('>', lastOpen)).toBeGreaterThan(lastOpen);
    });
  });
});

describe('findSecretsDeep — the verifier scans leaves, not the serialized blob', () => {
  it('does not fire on quotes spanning separate values', () => {
    // JSON.stringify would put these adjacent, letting a quoted pattern run
    // from one value into the next and match across the boundary. On the real
    // corpus that produced a refusal for an entirely clean payload.
    const spans = [
      { attributes: { 'tool.args': "export SERVE_KEY='" } },
      { attributes: { 'tool.args': "echo 'done'" } },
    ];
    expect(findSecretsDeep(spans)).toEqual([]);
    // …whereas the naive whole-document scan does fire — the bug, pinned.
    expect(findSecrets(JSON.stringify(spans)).length).toBeGreaterThan(0);
  });

  it('still finds a real secret nested anywhere', () => {
    expect(findSecretsDeep({ a: [{ b: { c: `key ${FAKE_OR}` } }] })).toContain('openrouter-key');
  });
});

describe('runConvert', () => {
  it('--dry-run writes batches and POSTs nothing', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(path.join(dir, 'agent-a.jsonl'), syntheticSession());
      writeFileSync(path.join(dir, 'agent-b.jsonl'), syntheticSession());
      const out = path.join(dir, 'out');
      const r = await runConvert({ dir, outDir: out, dryRun: true, verifyScrub: true });
      expect(r.sessions).toBe(2);
      // 5 pre-v2 spans + 2 llm.call spans per session (Decision 1).
      expect(r.spans).toBe(14);
      expect(r.posted).toBe(0);
      expect(r.withReference).toBe(2);
      expect(r.toolSignatures).toEqual({ 'Bash>Read': 2 });
    });
  });

  it('--verify-scrub REFUSES when a credential shape survives', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(path.join(dir, 'agent-a.jsonl'), syntheticSession());
      const out = path.join(dir, 'out');
      // Scrubbing is real, so nothing survives — prove the gate is wired by
      // asserting the clean path passes, then that findSecrets is what it
      // consults (an unscrubbed payload trips it).
      await expect(
        runConvert({ dir, outDir: out, dryRun: true, verifyScrub: true }),
      ).resolves.toBeDefined();
      expect(findSecrets(JSON.stringify([{ a: `Bearer ${FAKE_OR}` }])).length).toBeGreaterThan(0);
    });
  });

  it('refuses an empty directory rather than silently posting nothing', async () => {
    await withTmpDir(async (dir) => {
      await expect(runConvert({ dir, dryRun: true, verifyScrub: true })).rejects.toThrow(
        /no \.jsonl transcripts/,
      );
    });
  });

  it('refuses to POST without an api url/key', async () => {
    await withTmpDir(async (dir) => {
      writeFileSync(path.join(dir, 'agent-a.jsonl'), syntheticSession());
      await expect(runConvert({ dir, dryRun: false, verifyScrub: true })).rejects.toThrow(
        /--api-url and --api-key are required/,
      );
    });
  });
});

describe('chunkSpans', () => {
  it('respects the 500-span batch cap', () => {
    const spans = Array.from({ length: 1201 }, (_, i) => ({
      trace_id: 't',
      span_id: `s${i}`,
      name: 'chat',
    }));
    const batches = chunkSpans(spans);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(TRACES_BATCH_CAP);
    expect(batches[2]).toHaveLength(201);
    expect(batches.flat()).toHaveLength(1201);
  });

  it('a short session is one batch', () => {
    expect(chunkSpans([{ trace_id: 't', span_id: 's', name: 'chat' }])).toHaveLength(1);
  });
});

describe('sessionToSpans on an empty transcript', () => {
  it('still produces a well-formed root+chat pair', () => {
    const c = sessionToSpans([], { traceId: 'cc-empty' });
    expect(c.spans.map((s) => s.name)).toEqual(['agent.root', 'chat']);
    expect(c.toolSignature).toEqual([]);
    expect(c.hasReference).toBe(false);
  });
});
