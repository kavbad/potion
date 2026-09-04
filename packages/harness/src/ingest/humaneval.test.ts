// HumanEval adapter golden tests (ROADMAP M1a): a fixed 3-task fixture
// converts to exactly the expected EvalItems — JS for the hand-transpiled
// task, python (runner-skipped) for the rest. Also pins docstring extraction,
// id sanitization, and malformed-input errors.
import { describe, expect, it } from 'vitest';
import {
  convertHumanEval,
  descriptionFromPrompt,
  sanitizeTaskId,
  type JsTranspilation,
} from './humaneval.js';

const FIXTURE = [
  {
    task_id: 'JS-Bench/01',
    prompt:
      'def count_vowels(s):\n    """Count the vowels (a, e, i, o, u) in s.\n    >>> count_vowels("hello")\n    2\n    """\n',
    canonical_solution: 'def count_vowels(s):\n    return sum(1 for ch in s if ch.lower() in "aeiou")\n',
    test: 'def check(candidate):\n    assert candidate("hello") == 2\n',
    entry_point: 'count_vowels',
  },
  {
    task_id: 'JS-Bench/02',
    prompt: 'def merge_dicts(a, b):\n    """Merge two dicts; b wins conflicts."""\n',
    canonical_solution: 'def merge_dicts(a, b):\n    return {**a, **b}\n',
    test: 'def check(candidate):\n    assert candidate({"x": 1}, {"x": 2}) == {"x": 2}\n',
    entry_point: 'merge_dicts',
  },
  {
    task_id: 'JS-Bench/03',
    prompt: 'def flatten_once(items):\n    """Flatten one level of nesting."""\n',
    canonical_solution: 'def flatten_once(items):\n    return [x for el in items for x in (el if isinstance(el, list) else [el])]\n',
    test: 'def check(candidate):\n    assert candidate([[1], 2]) == [1, 2]\n',
    entry_point: 'flatten_once',
  },
];

const TRANSPILE = {
  'JS-Bench/01': {
    entryPoint: 'countVowels',
    solution: "function countVowels(s) {\n  return [...s].filter((c) => 'aeiouAEIOU'.includes(c)).length;\n}",
    tests: "test('two vowels', () => assert(countVowels('hello') === 2));\ntest('none', () => assert(countVowels('xyz') === 0));",
  },
} satisfies Record<string, JsTranspilation>;

function convert(transpilations?: Record<string, JsTranspilation>) {
  return convertHumanEval(FIXTURE.map((t) => JSON.stringify(t)).join('\n') + '\n', {
    idPrefix: 'he-js-',
    transpilations,
  });
}

describe('convertHumanEval', () => {
  it('golden: transpiled task → javascript code-exec item', () => {
    const { items, warnings } = convert(TRANSPILE);
    expect(items).toHaveLength(3);
    expect(warnings).toHaveLength(2);

    const js = items[0]!;
    expect(js).toEqual({
      id: 'he-js-js-bench-01',
      clusterId: 'code-gen',
      prompt: [
        {
          role: 'user',
          content:
            'EVAL: he-js-js-bench-01\nImplement `countVowels`: Count the vowels (a, e, i, o, u) in s.\n\n' +
            'Respond with ONLY the JavaScript function source, no markdown fences, no explanation.',
        },
      ],
      reference: TRANSPILE['JS-Bench/01'].solution,
      scoring: { kind: 'code-exec', language: 'javascript', tests: TRANSPILE['JS-Bench/01'].tests },
    });
  });

  it('golden: non-transpiled tasks → python items + skip warnings', () => {
    const { items, warnings } = convert(TRANSPILE);
    const py = items[1]!;
    expect(py.id).toBe('he-js-js-bench-02');
    expect(py.scoring).toEqual({
      kind: 'code-exec',
      language: 'python',
      tests: FIXTURE[1]!.test,
    });
    expect(py.reference).toBe(FIXTURE[1]!.canonical_solution);
    expect(py.prompt[0]!.content).toContain('Implement `merge_dicts`: Merge two dicts; b wins conflicts.');
    expect(py.prompt[0]!.content).toContain('ONLY the Python function source');
    expect(warnings[0]).toContain('JS-Bench/02');
    expect(warnings[0]).toContain('SKIP');
    expect(warnings[1]).toContain('JS-Bench/03');
  });

  it('without any transpilations every task is emitted as python', () => {
    const { items, warnings } = convert();
    expect(items.map((i) => (i.scoring as { language: string }).language)).toEqual([
      'python',
      'python',
      'python',
    ]);
    expect(warnings).toHaveLength(3);
  });

  it('honors clusterId + no-prefix options', () => {
    const { items } = convertHumanEval(JSON.stringify(FIXTURE[0]) + '\n', {
      clusterId: 'code-review',
    });
    expect(items[0]!.id).toBe('js-bench-01');
    expect(items[0]!.clusterId).toBe('code-review');
  });

  it('rejects malformed JSONL and schema violations with line numbers', () => {
    expect(() => convertHumanEval('{not json}\n')).toThrow(/line 1.*invalid JSON/);
    expect(() =>
      convertHumanEval(JSON.stringify({ task_id: 'X/1', prompt: 'p' }) + '\n'),
    ).toThrow(/line 1.*invalid task/);
  });

  it('sanitizeTaskId + descriptionFromPrompt helpers', () => {
    expect(sanitizeTaskId('HumanEval/164')).toBe('humaneval-164');
    expect(sanitizeTaskId('JS-Bench/01')).toBe('js-bench-01');
    expect(descriptionFromPrompt(FIXTURE[0]!.prompt)).toBe('Count the vowels (a, e, i, o, u) in s.');
    expect(descriptionFromPrompt('def f(x):\n    """One line. Two lines."""\n')).toBe('One line. Two lines.');
  });
});
