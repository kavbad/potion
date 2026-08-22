import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './types.js';
import { CHAR_BUCKETS, requestShape, shapeClass } from './shape.js';

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

describe('requestShape', () => {
  it('records structure: turns, system, tools, stream, ceiling, size bucket', () => {
    expect(
      requestShape({
        messages: [msg('system', 'you are helpful'), msg('user', 'hi')],
        tools: [{ type: 'function' }, { type: 'function' }],
        tool_choice: 'required',
        stream: true,
        max_tokens: 512,
      }),
    ).toEqual({
      messages: 2,
      system: true,
      tools: 2,
      toolChoice: 'required',
      stream: true,
      maxTokens: 512,
      chars: '0-1k',
    });
  });

  it('omits toolChoice and maxTokens when the caller did not send them', () => {
    const shape = requestShape({ messages: [msg('user', 'hi')] });
    expect(shape).toEqual({ messages: 1, system: false, tools: 0, stream: false, chars: '0-1k' });
    expect('toolChoice' in shape).toBe(false);
    expect('maxTokens' in shape).toBe(false);
  });

  // THE property this module exists to have (S7 §4 D1): a shape is a
  // structure, so it cannot carry what the customer was talking about. If
  // this test ever fails, shapes have stopped being safe to aggregate across
  // orgs and the demand-cell design underneath them is void.
  it('is content-free: different text of the same structure gives the same shape', () => {
    const a = requestShape({
      messages: [msg('system', 'ACME internal policy v3'), msg('user', 'refund order 4471?')],
      tools: [{ type: 'function' }],
    });
    const b = requestShape({
      messages: [msg('system', 'xxxxxxxxxxxxxxxxxxxxxxxx'), msg('user', 'yyyyyyyyyyyyyyyyy')],
      tools: [{ type: 'function' }],
    });
    expect(a).toEqual(b);
  });

  it('records tool_choice MODE for a named function, never the tool name', () => {
    const shape = requestShape({
      messages: [msg('user', 'go')],
      tool_choice: { type: 'function', function: { name: 'charge_customer_card' } },
    });
    expect(shape.toolChoice).toBe('named');
    expect(JSON.stringify(shape)).not.toContain('charge_customer_card');
  });

  it('buckets total content length across all messages', () => {
    const long = 'x'.repeat(3_000);
    expect(requestShape({ messages: [msg('user', long)] }).chars).toBe('1k-4k');
    // Length is SUMMED over messages: two 3k turns are a 6k request.
    expect(requestShape({ messages: [msg('user', long), msg('user', long)] }).chars).toBe('4k-16k');
    expect(requestShape({ messages: [msg('user', 'x'.repeat(300_000))] }).chars).toBe('256k+');
  });

  it('every bucket boundary is reachable and ordered', () => {
    let previous = 0;
    for (const b of CHAR_BUCKETS) {
      expect(b.max).toBeGreaterThan(previous);
      previous = b.max;
    }
    expect(CHAR_BUCKETS[CHAR_BUCKETS.length - 1]!.max).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('shapeClass', () => {
  it('groups on the axes where measured evidence can be wrong for a request', () => {
    const base = { messages: [msg('user', 'hi')] };
    expect(shapeClass(requestShape(base))).toBe('no-tools/sync/0-1k');
    expect(shapeClass(requestShape({ ...base, tools: [{}] }))).toBe('tools/sync/0-1k');
    expect(shapeClass(requestShape({ ...base, stream: true }))).toBe('no-tools/stream/0-1k');
  });

  it('ignores turn depth and the caller output ceiling (cells must not shatter)', () => {
    const a = requestShape({ messages: [msg('user', 'hi')], max_tokens: 100 });
    const b = requestShape({
      messages: [msg('user', 'hi'), msg('assistant', 'yes'), msg('user', 'more')],
      max_tokens: 4000,
    });
    expect(shapeClass(a)).toBe(shapeClass(b));
  });
});
