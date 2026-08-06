// ─────────────────────────────────────────────────────────────────────────────
// TEST/CI SIMULATION ONLY — never authoritative for customer-facing evals.
//
// This module is the mock-world eval corpus (tasks + uncorrupted references +
// the deterministic corruption engine) that powers the mock provider's
// answerable EVAL prompts (SPEC §5 harness contract). It exists so CI can run
// the full harness end-to-end with deterministic, gradable answers.
//
// PROVENANCE WARNING: the uncorrupted references below were used to GENERATE
// the gate suites now quarantined in packages/harness/suites/simulated/
// (code-gen.jsonl, extraction.jsonl). Those suites are therefore coupled to
// the mock by construction and must NEVER be presented as evidence of
// real-world quality. See packages/harness/suites/simulated/README.md and
// MOCK_PROVIDER_DISCLAIMER (exported from ./mock.js).
// ─────────────────────────────────────────────────────────────────────────────
//
// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 (ADDITIVE): EVAL task corpus + class-dependent corruption — the
// mock-world quality model (SPEC §5 harness contract).
//
// Problem: the mock provider otherwise emits lorem word-bank text that no
// scorer can grade. Solution: eval-suite prompts carry a signature line
// `EVAL: <taskId>`; the mock then answers from a fixed TASK CORPUS (the
// "ground truth" a real model would approximate) and CORRUPTS the answer with
// a deterministic, seeded, model-class-dependent probability:
//
//   mock-cheap    ~45% corrupted   (weak model)
//   mock-mid      ~20% corrupted   (decent model)
//   mock-frontier ~ 5% corrupted   (strong model)
//   mock-judge*     0% corrupted   (it judges; it does not answer)
//
// Corruption is task-kind specific:
//   code    → one documented subtle bug injected (find/replace on the source)
//   extract → one field dropped (50%) or set to a typed wrong value (50%)
//   prose   → one off-topic sentence prepended
//
// The mock JUDGE does not hallucinate an opinion: it re-derives correctness
// by comparing the embedded answer against the corpus reference, then adds
// small seeded noise (±0.08 of scale). That is the calibration story: judge
// scores correlate with true correctness because they are DERIVED from it,
// with independent noise per judge model seed (mock-judge-a / mock-judge-b
// double-scoring agreement in packages/harness).
//
// Determinism: every decision below comes from the caller's seeded rng stream
// (seedOf(params.seed ?? hash(prompt))). Corruption draws are consumed ONLY
// inside the EVAL branches, so legacy word-bank/special-fixture behavior for
// non-EVAL prompts is bit-identical to Phases 0–2.
//
// M2-security (ADDITIVE): judge/probe prompts now wrap untrusted sections
// (TASK / ANSWER / CANDIDATE / assistant draft) in <<<UNTRUSTED_DATA_*>>>
// DATA-block markers (@potion/core safety.ts). The section extractors below
// STRIP those markers before comparing against the corpus, so hardened
// prompts extract bit-identical content to the pre-hardening format.
// ─────────────────────────────────────────────────────────────────────────────
import { unwrapUntrustedData } from '@potion/core';

/** Signature line marking an eval-corpus prompt: `EVAL: cg-01` / `EVAL: ex-30`. */
export const EVAL_SIG_RE = /EVAL:\s*([a-z]{2}-\d{2})/;

/** Marker: harness llm-judge prompts — "Respond with exactly one line: SCORE: <number> ...". */
export const SCORE_MARKER = /SCORE:\s*<number>/i;

/** Marker: draft-verify verifier prompts (buildVerifyMessages in @potion/strategies). */
export const VERIFY_MARKER = /Verify the draft answer above/i;

export type EvalTaskKind = 'code' | 'extract' | 'prose';
export type EvalFieldType = 'string' | 'number' | 'boolean' | 'array';

export interface EvalCorpusTask {
  id: string; // 'cg-01'…'cg-30', 'ex-01'…'ex-30', 'pr-01'…'pr-03'
  kind: EvalTaskKind;
  /** Task body the suite embeds in the user prompt (spec / document / brief). */
  task: string;
  /** Uncorrupted reference answer: JS function source | JSON string | prose. */
  reference: string;
  /** code only: node:vm test snippet registering test(name, fn) cases (harness contract). */
  tests?: string;
  /** extract only: field schema (drives typed corruption + field-match scoring). */
  schema?: Record<string, EvalFieldType>;
  /** code only: subtle-bug injections as [find, replace] pairs on the reference source. */
  bugs?: ReadonlyArray<readonly [string, string]>;
}

/**
 * Corruption probability per model class (documented mock-world quality model).
 * 'judge' → 0: judge models score, they never answer. Unknown → 0.25.
 */
export function corruptionRateForModel(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('judge')) return 0;
  if (m.includes('cheap')) return 0.45;
  if (m.includes('mid')) return 0.2;
  if (m.includes('frontier')) return 0.05;
  return 0.25;
}

// ---- code-gen corpus (cg-01 … cg-30) ---------------------------------------
// Reference = plain JS function source. tests = harness vm snippet contract:
// the sandbox provides test(name, fn), assert(cond, msg?), assertDeepEqual(a, b).
// bugs = [find, replace] pairs; each is a *subtle* bug (still parses, fails ≥1 test).

const CODE_TASKS: EvalCorpusTask[] = [
  {
    id: 'cg-01', kind: 'code',
    task: 'Implement `add(a, b)` returning the sum of two numbers.',
    reference: 'function add(a, b) {\n  return a + b;\n}',
    tests: "test('positives', () => assert(add(2, 3) === 5));\ntest('negatives cancel', () => assert(add(-4, 4) === 0));\ntest('zeros', () => assert(add(0, 0) === 0));",
    bugs: [['return a + b;', 'return a - b;']],
  },
  {
    id: 'cg-02', kind: 'code',
    task: 'Implement `clamp(x, lo, hi)` constraining x to the inclusive range [lo, hi].',
    reference: 'function clamp(x, lo, hi) {\n  return Math.min(hi, Math.max(lo, x));\n}',
    tests: "test('inside', () => assert(clamp(5, 0, 10) === 5));\ntest('below lo', () => assert(clamp(-1, 0, 10) === 0));\ntest('above hi', () => assert(clamp(11, 0, 10) === 10));",
    bugs: [['Math.max(lo, x)', 'Math.min(lo, x)']],
  },
  {
    id: 'cg-03', kind: 'code',
    task: 'Implement `reverseString(s)` returning s with characters in reverse order.',
    reference: "function reverseString(s) {\n  return s.split('').reverse().join('');\n}",
    tests: "test('basic', () => assert(reverseString('abc') === 'cba'));\ntest('empty', () => assert(reverseString('') === ''));",
    bugs: [[".reverse()", '']],
  },
  {
    id: 'cg-04', kind: 'code',
    task: 'Implement `sumArray(xs)` returning the sum of all numbers in xs (empty → 0).',
    reference: 'function sumArray(xs) {\n  return xs.reduce((a, x) => a + x, 0);\n}',
    tests: 'test(\'basic\', () => assert(sumArray([1, 2, 3]) === 6));\ntest(\'empty\', () => assert(sumArray([]) === 0));',
    bugs: [['a + x, 0)', 'a + x, 1)']],
  },
  {
    id: 'cg-05', kind: 'code',
    task: 'Implement `isPalindrome(s)` returning true when s reads the same backwards.',
    reference: "function isPalindrome(s) {\n  const r = s.split('').reverse().join('');\n  return s === r;\n}",
    tests: "test('palindrome', () => assert(isPalindrome('level') === true));\ntest('not', () => assert(isPalindrome('hello') === false));",
    bugs: [['return s === r;', 'return s !== r;']],
  },
  {
    id: 'cg-06', kind: 'code',
    task: 'Implement `factorial(n)` returning n! (factorial(0) === 1).',
    reference: 'function factorial(n) {\n  let r = 1;\n  for (let i = 2; i <= n; i++) r *= i;\n  return r;\n}',
    tests: 'test(\'five\', () => assert(factorial(5) === 120));\ntest(\'zero\', () => assert(factorial(0) === 1));\ntest(\'three\', () => assert(factorial(3) === 6));',
    bugs: [['let i = 2;', 'let i = 3;']],
  },
  {
    id: 'cg-07', kind: 'code',
    task: 'Implement `maxOf(xs)` returning the largest number in a non-empty array.',
    reference: 'function maxOf(xs) {\n  let m = xs[0];\n  for (const x of xs) {\n    if (x > m) m = x;\n  }\n  return m;\n}',
    tests: 'test(\'basic\', () => assert(maxOf([1, 9, 2]) === 9));\ntest(\'negatives\', () => assert(maxOf([-5, -2, -9]) === -2));',
    bugs: [['if (x > m)', 'if (x < m)']],
  },
  {
    id: 'cg-08', kind: 'code',
    task: 'Implement `countVowels(s)` counting lowercase vowels a/e/i/o/u in s.',
    reference: "function countVowels(s) {\n  let n = 0;\n  for (const c of s) {\n    if ('aeiou'.includes(c)) n++;\n  }\n  return n;\n}",
    tests: "test('basic', () => assert(countVowels('sequoia') === 5));\ntest('none', () => assert(countVowels('rhythm') === 0));",
    bugs: [['n++;', 'n += 2;']],
  },
  {
    id: 'cg-09', kind: 'code',
    task: 'Implement `titleCase(s)` uppercasing the first letter of each space-separated word.',
    reference: "function titleCase(s) {\n  return s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');\n}",
    tests: "test('two words', () => assert(titleCase('hello world') === 'Hello World'));\ntest('one word', () => assert(titleCase('potion') === 'Potion'));",
    bugs: [['w.slice(1)', 'w.slice(0)']],
  },
  {
    id: 'cg-10', kind: 'code',
    task: "Implement `fizzbuzz(n)` returning an array of strings for 1..n ('Fizz'/'Buzz'/'FizzBuzz' rules, else the number as a string).",
    reference: "function fizzbuzz(n) {\n  const out = [];\n  for (let i = 1; i <= n; i++) {\n    if (i % 15 === 0) out.push('FizzBuzz');\n    else if (i % 3 === 0) out.push('Fizz');\n    else if (i % 5 === 0) out.push('Buzz');\n    else out.push(String(i));\n  }\n  return out;\n}",
    tests: "test('first five', () => assertDeepEqual(fizzbuzz(5), ['1', '2', 'Fizz', '4', 'Buzz']));\ntest('fifteen', () => assert(fizzbuzz(15)[14] === 'FizzBuzz'));",
    bugs: [['i % 15 === 0', 'i % 14 === 0']],
  },
  {
    id: 'cg-11', kind: 'code',
    task: 'Implement `fibonacci(n)` returning the n-th Fibonacci number (fib(0)=0, fib(1)=1).',
    reference: 'function fibonacci(n) {\n  let a = 0, b = 1;\n  for (let i = 0; i < n; i++) {\n    const t = a + b;\n    a = b;\n    b = t;\n  }\n  return a;\n}',
    tests: 'test(\'ten\', () => assert(fibonacci(10) === 55));\ntest(\'zero\', () => assert(fibonacci(0) === 0));',
    bugs: [['let a = 0, b = 1;', 'let a = 1, b = 1;']],
  },
  {
    id: 'cg-12', kind: 'code',
    task: 'Implement `uniqueArray(xs)` returning xs with duplicates removed, first-occurrence order kept.',
    reference: 'function uniqueArray(xs) {\n  return [...new Set(xs)];\n}',
    tests: 'test(\'basic\', () => assertDeepEqual(uniqueArray([1, 2, 1, 3, 2]), [1, 2, 3]));\ntest(\'empty\', () => assertDeepEqual(uniqueArray([]), []));',
    bugs: [['return [...new Set(xs)];', 'return xs;']],
  },
  {
    id: 'cg-13', kind: 'code',
    task: 'Implement `flatten(xss)` concatenating an array of arrays into one flat array.',
    reference: 'function flatten(xss) {\n  return xss.reduce((acc, xs) => acc.concat(xs), []);\n}',
    tests: 'test(\'basic\', () => assertDeepEqual(flatten([[1, 2], [3], []]), [1, 2, 3]));',
    bugs: [['acc.concat(xs)', 'acc.concat([xs])']],
  },
  {
    id: 'cg-14', kind: 'code',
    task: 'Implement `charCount(s)` returning an object mapping each character to its count.',
    reference: 'function charCount(s) {\n  const m = {};\n  for (const c of s) {\n    m[c] = (m[c] || 0) + 1;\n  }\n  return m;\n}',
    tests: "test('basic', () => assertDeepEqual(charCount('aba'), { a: 2, b: 1 }));",
    bugs: [['(m[c] || 0) + 1', '(m[c] || 0) + 2']],
  },
  {
    id: 'cg-15', kind: 'code',
    task: 'Implement `isPrime(n)` returning true for prime numbers (n < 2 is not prime).',
    reference: 'function isPrime(n) {\n  if (n < 2) return false;\n  for (let i = 2; i * i <= n; i++) {\n    if (n % i === 0) return false;\n  }\n  return true;\n}',
    tests: 'test(\'two\', () => assert(isPrime(2) === true));\ntest(\'four\', () => assert(isPrime(4) === false));\ntest(\'nine\', () => assert(isPrime(9) === false));\ntest(\'seven\', () => assert(isPrime(7) === true));',
    bugs: [['i * i <= n', 'i * i < n']],
  },
  {
    id: 'cg-16', kind: 'code',
    task: 'Implement `celsiusToFahrenheit(c)` converting Celsius to Fahrenheit.',
    reference: 'function celsiusToFahrenheit(c) {\n  return (c * 9) / 5 + 32;\n}',
    tests: 'test(\'freezing\', () => assert(celsiusToFahrenheit(0) === 32));\ntest(\'boiling\', () => assert(celsiusToFahrenheit(100) === 212));',
    bugs: [['(c * 9) / 5', '(c * 5) / 9']],
  },
  {
    id: 'cg-17', kind: 'code',
    task: 'Implement `secondLargest(xs)` returning the second-largest number (xs has ≥2 distinct values).',
    reference: 'function secondLargest(xs) {\n  const s = [...xs].sort((a, b) => b - a);\n  return s[1];\n}',
    tests: 'test(\'basic\', () => assert(secondLargest([5, 1, 9, 7]) === 7));',
    bugs: [['(a, b) => b - a', '(a, b) => a - b']],
  },
  {
    id: 'cg-18', kind: 'code',
    task: 'Implement `repeatString(s, n)` returning s repeated n times.',
    reference: 'function repeatString(s, n) {\n  return s.repeat(n);\n}',
    tests: "test('basic', () => assert(repeatString('ab', 3) === 'ababab'));\ntest('zero', () => assert(repeatString('ab', 0) === ''));",
    bugs: [['s.repeat(n)', 's.repeat(n + 1)']],
  },
  {
    id: 'cg-19', kind: 'code',
    task: 'Implement `countWords(s)` counting whitespace-separated words (empty/blank → 0).',
    reference: 'function countWords(s) {\n  return s.trim().split(/\\s+/).filter(Boolean).length;\n}',
    tests: "test('basic', () => assert(countWords('the quick fox') === 3));\ntest('blank', () => assert(countWords('   ') === 0));\ntest('single char words', () => assert(countWords('a b c d') === 4));",
    bugs: [['.filter(Boolean)', '.filter((w) => w.length > 1)']],
  },
  {
    id: 'cg-20', kind: 'code',
    task: 'Implement `absDiff(a, b)` returning the absolute difference of a and b.',
    reference: 'function absDiff(a, b) {\n  return Math.abs(a - b);\n}',
    tests: 'test(\'basic\', () => assert(absDiff(3, 10) === 7));\ntest(\'symmetric\', () => assert(absDiff(10, 3) === 7));',
    bugs: [['Math.abs(a - b)', 'Math.abs(a + b)']],
  },
  {
    id: 'cg-21', kind: 'code',
    task: 'Implement `sumDigits(n)` summing the decimal digits of n (sign ignored).',
    reference: "function sumDigits(n) {\n  return String(Math.abs(n)).split('').reduce((a, d) => a + Number(d), 0);\n}",
    tests: 'test(\'basic\', () => assert(sumDigits(1234) === 10));\ntest(\'negative\', () => assert(sumDigits(-25) === 7));',
    bugs: [['a + Number(d)', 'a + Number(d) * 2']],
  },
  {
    id: 'cg-22', kind: 'code',
    task: 'Implement `range(start, end)` returning integers [start, end) as an array.',
    reference: 'function range(start, end) {\n  const out = [];\n  for (let i = start; i < end; i++) out.push(i);\n  return out;\n}',
    tests: 'test(\'basic\', () => assertDeepEqual(range(2, 6), [2, 3, 4, 5]));\ntest(\'empty\', () => assertDeepEqual(range(3, 3), []));',
    bugs: [['i < end;', 'i <= end;']],
  },
  {
    id: 'cg-23', kind: 'code',
    task: 'Implement `median(xs)` returning the median of a non-empty numeric array.',
    reference: 'function median(xs) {\n  const s = [...xs].sort((a, b) => a - b);\n  const m = Math.floor(s.length / 2);\n  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;\n}',
    tests: 'test(\'odd\', () => assert(median([3, 1, 2]) === 2));\ntest(\'even\', () => assert(median([4, 1, 3, 2]) === 2.5));',
    bugs: [['(s[m - 1] + s[m]) / 2', '(s[m - 1] + s[m]) / 3']],
  },
  {
    id: 'cg-24', kind: 'code',
    task: "Implement `initials(name)` returning uppercased initials joined with '.' (e.g. 'Ada Lovelace' → 'A.L').",
    reference: "function initials(name) {\n  return name.split(' ').map((w) => w.charAt(0).toUpperCase()).join('.');\n}",
    tests: "test('basic', () => assert(initials('Ada Lovelace') === 'A.L'));\ntest('three', () => assert(initials('john ronald tolkien') === 'J.R.T'));",
    bugs: [['w.charAt(0)', 'w.charAt(1)']],
  },
  {
    id: 'cg-25', kind: 'code',
    task: 'Implement `everyOther(xs)` returning elements at even indices (0, 2, 4, …).',
    reference: 'function everyOther(xs) {\n  return xs.filter((_, i) => i % 2 === 0);\n}',
    tests: 'test(\'basic\', () => assertDeepEqual(everyOther([\'a\', \'b\', \'c\', \'d\']), [\'a\', \'c\']));',
    bugs: [['i % 2 === 0', 'i % 2 === 1']],
  },
  {
    id: 'cg-26', kind: 'code',
    task: 'Implement `minMax(xs)` returning { min, max } of a non-empty numeric array.',
    reference: 'function minMax(xs) {\n  return { min: Math.min(...xs), max: Math.max(...xs) };\n}',
    tests: 'test(\'basic\', () => assertDeepEqual(minMax([3, 1, 9]), { min: 1, max: 9 }));',
    bugs: [['min: Math.min(...xs), max: Math.max(...xs)', 'min: Math.max(...xs), max: Math.min(...xs)']],
  },
  {
    id: 'cg-27', kind: 'code',
    task: 'Implement `power(base, exp)` returning base^exp for non-negative integer exp.',
    reference: 'function power(base, exp) {\n  let r = 1;\n  for (let i = 0; i < exp; i++) r *= base;\n  return r;\n}',
    tests: 'test(\'cube\', () => assert(power(2, 3) === 8));\ntest(\'zero exp\', () => assert(power(7, 0) === 1));',
    bugs: [['i < exp;', 'i < exp - 1;']],
  },
  {
    id: 'cg-28', kind: 'code',
    task: 'Implement `gcd(a, b)` returning the greatest common divisor (Euclidean algorithm).',
    reference: 'function gcd(a, b) {\n  while (b !== 0) {\n    const t = b;\n    b = a % b;\n    a = t;\n  }\n  return a;\n}',
    tests: 'test(\'basic\', () => assert(gcd(12, 8) === 4));\ntest(\'coprime\', () => assert(gcd(7, 5) === 1));',
    bugs: [['while (b !== 0)', 'while (b > 1)']],
  },
  {
    id: 'cg-29', kind: 'code',
    task: 'Implement `snakeToCamel(s)` converting snake_case to camelCase.',
    reference: "function snakeToCamel(s) {\n  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());\n}",
    tests: "test('basic', () => assert(snakeToCamel('user_id') === 'userId'));\ntest('two', () => assert(snakeToCamel('created_at_time') === 'createdAtTime'));",
    bugs: [['c.toUpperCase()', 'c']],
  },
  {
    id: 'cg-30', kind: 'code',
    task: "Implement `binaryToDecimal(bin)` parsing a binary string ('0'/'1's) to a number.",
    reference: 'function binaryToDecimal(bin) {\n  return parseInt(bin, 2);\n}',
    tests: "test('basic', () => assert(binaryToDecimal('1010') === 10));\ntest('one', () => assert(binaryToDecimal('1') === 1));",
    bugs: [['parseInt(bin, 2)', 'parseInt(bin, 10)']],
  },
];

// ---- extraction corpus (ex-01 … ex-30) --------------------------------------
// task = field spec + short document. reference = compact JSON string, fields
// in schema order. Corruption drops one field or types a wrong value (see below).

interface ExSpec { doc: string; schema: Record<string, EvalFieldType>; ref: Record<string, unknown>; }

function exTask(id: string, { doc, schema, ref }: ExSpec): EvalCorpusTask {
  const fields = Object.entries(schema).map(([k, t]) => `${k} (${t})`).join(', ');
  return {
    id,
    kind: 'extract',
    task: `Extract these fields as JSON: ${fields}.\nDOCUMENT:\n${doc}`,
    reference: JSON.stringify(ref),
    schema,
  };
}

const EXTRACTION_TASKS: EvalCorpusTask[] = [
  exTask('ex-01', {
    doc: 'Invoice INV-1042 from Acme Corp — amount due $1,250.75. Status: PAID.',
    schema: { vendor: 'string', invoiceNumber: 'string', total: 'number', paid: 'boolean' },
    ref: { vendor: 'Acme Corp', invoiceNumber: 'INV-1042', total: 1250.75, paid: true },
  }),
  exTask('ex-02', {
    doc: 'Booking confirmation HTL-8812: guest Maria Chen, 3 nights at $189.50/night, breakfast included.',
    schema: { guest: 'string', confirmation: 'string', nights: 'number', breakfastIncluded: 'boolean' },
    ref: { guest: 'Maria Chen', confirmation: 'HTL-8812', nights: 3, breakfastIncluded: true },
  }),
  exTask('ex-03', {
    doc: 'Flight UA-2471 departs SFO at 14:35, arrives JFK at 23:05. Seat 14C, boarding group 2.',
    schema: { flight: 'string', origin: 'string', destination: 'string', seat: 'string' },
    ref: { flight: 'UA-2471', origin: 'SFO', destination: 'JFK', seat: '14C' },
  }),
  exTask('ex-04', {
    doc: 'Support ticket #5521 opened by Priya Nair. Priority: high. Topic: billing. Unresolved.',
    schema: { ticketId: 'string', openedBy: 'string', priority: 'string', resolved: 'boolean' },
    ref: { ticketId: '#5521', openedBy: 'Priya Nair', priority: 'high', resolved: false },
  }),
  exTask('ex-05', {
    doc: 'Job posting: Senior Backend Engineer at Loopwell, salary $185,000, remote-friendly, requires Go and Postgres.',
    schema: { title: 'string', company: 'string', salary: 'number', remote: 'boolean', skills: 'array' },
    ref: { title: 'Senior Backend Engineer', company: 'Loopwell', salary: 185000, remote: true, skills: ['Go', 'Postgres'] },
  }),
  exTask('ex-06', {
    doc: 'Product listing: Trailblazer Backpack, 32 liters, price $89.99, in stock, colors: forest green, charcoal.',
    schema: { product: 'string', liters: 'number', price: 'number', inStock: 'boolean', colors: 'array' },
    ref: { product: 'Trailblazer Backpack', liters: 32, price: 89.99, inStock: true, colors: ['forest green', 'charcoal'] },
  }),
  exTask('ex-07', {
    doc: 'Receipt: Cafe Luna, 2026-07-14. Latte $4.50, croissant $3.25. Total $7.75. Paid by card.',
    schema: { merchant: 'string', date: 'string', total: 'number', cardPayment: 'boolean' },
    ref: { merchant: 'Cafe Luna', date: '2026-07-14', total: 7.75, cardPayment: true },
  }),
  exTask('ex-08', {
    doc: 'Lease notice: Unit 4B at 88 Harbor St, tenant Diego Ramos, rent $2,150 due monthly, pets allowed.',
    schema: { unit: 'string', tenant: 'string', rent: 'number', petsAllowed: 'boolean' },
    ref: { unit: '4B', tenant: 'Diego Ramos', rent: 2150, petsAllowed: true },
  }),
  exTask('ex-09', {
    doc: 'Patient intake: Aisha Bello, age 34, blood type O+, no known allergies, smoker: no.',
    schema: { patient: 'string', age: 'number', bloodType: 'string', smoker: 'boolean', allergies: 'array' },
    ref: { patient: 'Aisha Bello', age: 34, bloodType: 'O+', smoker: false, allergies: [] },
  }),
  exTask('ex-10', {
    doc: 'Recipe card: Mushroom Risotto, serves 4, prep 15 minutes, cook 35 minutes, vegetarian.',
    schema: { dish: 'string', servings: 'number', prepMinutes: 'number', cookMinutes: 'number', vegetarian: 'boolean' },
    ref: { dish: 'Mushroom Risotto', servings: 4, prepMinutes: 15, cookMinutes: 35, vegetarian: true },
  }),
  exTask('ex-11', {
    doc: 'Event flyer: Jazz Under Stars at Riverside Park, 2026-08-21, doors 19:00, tickets $25, rain or shine.',
    schema: { event: 'string', venue: 'string', date: 'string', ticketPrice: 'number' },
    ref: { event: 'Jazz Under Stars', venue: 'Riverside Park', date: '2026-08-21', ticketPrice: 25 },
  }),
  exTask('ex-12', {
    doc: 'Shipping notice: order ORD-77410, carrier DHL, 2 parcels, 8.4 kg total, tracking enabled, arrives Friday.',
    schema: { orderId: 'string', carrier: 'string', parcels: 'number', weightKg: 'number', tracked: 'boolean' },
    ref: { orderId: 'ORD-77410', carrier: 'DHL', parcels: 2, weightKg: 8.4, tracked: true },
  }),
  exTask('ex-13', {
    doc: 'Hotel folio: The Beacon Hotel, room 512, 4 nights, incidentals $62.30, rewards member, checkout 11:00.',
    schema: { hotel: 'string', room: 'string', nights: 'number', incidentals: 'number', rewardsMember: 'boolean' },
    ref: { hotel: 'The Beacon Hotel', room: '512', nights: 4, incidentals: 62.3, rewardsMember: true },
  }),
  exTask('ex-14', {
    doc: 'Expense report: Tom Okafor, Q2 offsite in Denver, airfare $412.20, lodging $690.00, approved.',
    schema: { employee: 'string', destination: 'string', airfare: 'number', lodging: 'number', approved: 'boolean' },
    ref: { employee: 'Tom Okafor', destination: 'Denver', airfare: 412.2, lodging: 690, approved: true },
  }),
  exTask('ex-15', {
    doc: 'Insurance quote: 2019 Honda Civic, driver age 41, premium $1,140/year, comprehensive coverage, deductible $500.',
    schema: { vehicle: 'string', driverAge: 'number', annualPremium: 'number', deductible: 'number' },
    ref: { vehicle: '2019 Honda Civic', driverAge: 41, annualPremium: 1140, deductible: 500 },
  }),
  exTask('ex-16', {
    doc: 'Car listing: 2021 Tesla Model 3, 28,400 miles, asking $27,900, single owner, autopilot included.',
    schema: { car: 'string', miles: 'number', price: 'number', singleOwner: 'boolean' },
    ref: { car: '2021 Tesla Model 3', miles: 28400, price: 27900, singleOwner: true },
  }),
  exTask('ex-17', {
    doc: 'Real-estate listing: 12 Willow Lane, 3 bed / 2 bath, 1,480 sqft, listed at $525,000, garage.',
    schema: { address: 'string', bedrooms: 'number', bathrooms: 'number', sqft: 'number', price: 'number', garage: 'boolean' },
    ref: { address: '12 Willow Lane', bedrooms: 3, bathrooms: 2, sqft: 1480, price: 525000, garage: true },
  }),
  exTask('ex-18', {
    doc: 'Bug report BUG-331: login page crashes on Safari 17, severity critical, 12 users affected, reproducible.',
    schema: { bugId: 'string', severity: 'string', usersAffected: 'number', reproducible: 'boolean' },
    ref: { bugId: 'BUG-331', severity: 'critical', usersAffected: 12, reproducible: true },
  }),
  exTask('ex-19', {
    doc: 'Survey result: respondent #88, age bracket 25-34, rating 4/5, would recommend, comments: none.',
    schema: { respondent: 'string', ageBracket: 'string', rating: 'number', wouldRecommend: 'boolean' },
    ref: { respondent: '#88', ageBracket: '25-34', rating: 4, wouldRecommend: true },
  }),
  exTask('ex-20', {
    doc: 'Press mention: Fenwick Robotics raised $18M Series A led by Northgate Ventures, 45 employees, hiring.',
    schema: { company: 'string', amountRaised: 'number', leadInvestor: 'string', employees: 'number', hiring: 'boolean' },
    ref: { company: 'Fenwick Robotics', amountRaised: 18000000, leadInvestor: 'Northgate Ventures', employees: 45, hiring: true },
  }),
  exTask('ex-21', {
    doc: 'Transcript line: Elena Voss, CS-301 Algorithms, Fall 2025, grade A-, 3 credits.',
    schema: { student: 'string', course: 'string', term: 'string', grade: 'string', credits: 'number' },
    ref: { student: 'Elena Voss', course: 'CS-301 Algorithms', term: 'Fall 2025', grade: 'A-', credits: 3 },
  }),
  exTask('ex-22', {
    doc: 'Bank statement: 2026-06-02, Wire to Orbital Supplies, -$2,340.00, balance $18,552.19.',
    schema: { date: 'string', payee: 'string', amount: 'number', balance: 'number' },
    ref: { date: '2026-06-02', payee: 'Orbital Supplies', amount: -2340, balance: 18552.19 },
  }),
  exTask('ex-23', {
    doc: 'Order confirmation: 2x Mechanical Keyboard at $129.00 each, 1x Wrist Rest at $24.50, ships to Portland, gift wrap: no.',
    schema: { itemCount: 'number', total: 'number', shipCity: 'string', giftWrap: 'boolean', items: 'array' },
    ref: { itemCount: 3, total: 282.5, shipCity: 'Portland', giftWrap: false, items: ['Mechanical Keyboard', 'Wrist Rest'] },
  }),
  exTask('ex-24', {
    doc: 'Appointment reminder: Dr. Han, dental cleaning, 2026-08-10 at 09:30, confirmed, bring insurance card.',
    schema: { provider: 'string', kind: 'string', date: 'string', time: 'string', confirmed: 'boolean' },
    ref: { provider: 'Dr. Han', kind: 'dental cleaning', date: '2026-08-10', time: '09:30', confirmed: true },
  }),
  exTask('ex-25', {
    doc: 'Warranty card: Aurora Blender model AB-7, serial 88451-Q, 2-year coverage, registered.',
    schema: { product: 'string', serial: 'string', coverageYears: 'number', registered: 'boolean' },
    ref: { product: 'Aurora Blender AB-7', serial: '88451-Q', coverageYears: 2, registered: true },
  }),
  exTask('ex-26', {
    doc: 'Library notice: "The Silent Ocean" by R. Adeyemi, due 2026-08-05, renewal available, fine so far $0.00.',
    schema: { title: 'string', author: 'string', dueDate: 'string', renewable: 'boolean', fine: 'number' },
    ref: { title: 'The Silent Ocean', author: 'R. Adeyemi', dueDate: '2026-08-05', renewable: true, fine: 0 },
  }),
  exTask('ex-27', {
    doc: 'Gym membership: IronWorks, member Lila Moreno, plan annual, $49/month, includes pool and sauna.',
    schema: { gym: 'string', member: 'string', monthlyFee: 'number', amenities: 'array' },
    ref: { gym: 'IronWorks', member: 'Lila Moreno', monthlyFee: 49, amenities: ['pool', 'sauna'] },
  }),
  exTask('ex-28', {
    doc: 'Form 1099: contractor Noel Fischer, nonemployee compensation $12,400, federal tax withheld $0, state CA.',
    schema: { contractor: 'string', compensation: 'number', taxWithheld: 'number', state: 'string' },
    ref: { contractor: 'Noel Fischer', compensation: 12400, taxWithheld: 0, state: 'CA' },
  }),
  exTask('ex-29', {
    doc: 'Donation receipt: $250 to Riverkeep Alliance from Sofia Marino, tax-deductible, campaign: Clean Rivers 2026.',
    schema: { donor: 'string', organization: 'string', amount: 'number', taxDeductible: 'boolean', campaign: 'string' },
    ref: { donor: 'Sofia Marino', organization: 'Riverkeep Alliance', amount: 250, taxDeductible: true, campaign: 'Clean Rivers 2026' },
  }),
  exTask('ex-30', {
    doc: 'Weather report: Reykjavik, high 11C low 4C, wind 22 km/h, rain likely, sunrise 04:58.',
    schema: { city: 'string', highC: 'number', lowC: 'number', windKmh: 'number', rainLikely: 'boolean' },
    ref: { city: 'Reykjavik', highC: 11, lowC: 4, windKmh: 22, rainLikely: true },
  }),
];

// ---- prose corpus (pr-01 … pr-03; exercised by the llm-judge scorer) --------

const PROSE_TASKS: EvalCorpusTask[] = [
  {
    id: 'pr-01', kind: 'prose',
    task: 'Write a two-sentence product blurb for a smart kettle aimed at tea drinkers.',
    reference: 'The Emberleaf kettle holds your water at the exact temperature each tea deserves, from delicate greens to robust blacks. One tap starts the pour-over preset, so every cup tastes like the roaster intended.',
  },
  {
    id: 'pr-02', kind: 'prose',
    task: 'Write a short apology email from a shipping company for a delayed parcel.',
    reference: 'We are sorry your parcel arrived later than promised — a routing error at our hub added two days to the journey. We have refunded the shipping fee and tightened our hub checks so it does not happen again.',
  },
  {
    id: 'pr-03', kind: 'prose',
    task: 'Write a one-paragraph summary of why databases use indexes.',
    reference: 'Indexes let a database find rows without scanning every page of a table, trading extra storage and slower writes for dramatically faster lookups. Picking the right columns to index is usually the single biggest query-performance lever.',
  },
];

/** Full eval corpus, addressable by task id. */
export const EVAL_CORPUS: readonly EvalCorpusTask[] = [
  ...CODE_TASKS,
  ...EXTRACTION_TASKS,
  ...PROSE_TASKS,
];

const CORPUS_BY_ID = new Map(EVAL_CORPUS.map((t) => [t.id, t]));

/** Corpus lookup by task id ('cg-01', …) — undefined when absent. */
export function evalTaskById(id: string): EvalCorpusTask | undefined {
  return CORPUS_BY_ID.get(id);
}

/** Extract the EVAL task id from a prompt, or null. */
export function extractEvalTaskId(promptText: string): string | null {
  const m = EVAL_SIG_RE.exec(promptText);
  return m?.[1] ?? null;
}

// ---- corruption -------------------------------------------------------------

/** Off-topic sentences prepended to corrupted prose answers. */
export const OFF_TOPIC_SENTENCES: readonly string[] = [
  'By the way, the night market in Taipei is famous for its stinky tofu.',
  'Interestingly, octopuses have three hearts and blue blood.',
  'On an unrelated note, the trans-Siberian railway spans eight time zones.',
];

function corruptCode(task: EvalCorpusTask, rng: () => number): string {
  const bugs = task.bugs ?? [];
  if (bugs.length === 0) return task.reference;
  const bug = bugs[Math.floor(rng() * bugs.length)] ?? bugs[0]!;
  if (!task.reference.includes(bug[0])) return task.reference; // documented guard
  return task.reference.replace(bug[0], bug[1]);
}

/** Typed wrong value for one extraction field (never the correct one by design). */
function wrongValueFor(type: EvalFieldType, correct: unknown, rng: () => number): unknown {
  switch (type) {
    case 'string':
      return 'UNKNOWN';
    case 'number':
      return typeof correct === 'number' ? correct + 1 : 42;
    case 'boolean':
      return !(correct === true);
    case 'array': {
      const arr = Array.isArray(correct) ? correct : [];
      if (arr.length > 1) return arr.slice(0, Math.max(1, arr.length - 1)); // drop tail
      return rng() < 0.5 ? [] : ['UNKNOWN'];
    }
  }
}

function corruptExtract(task: EvalCorpusTask, rng: () => number): string {
  const schema = task.schema ?? {};
  const fields = Object.keys(schema);
  if (fields.length === 0) return task.reference;
  const ref = JSON.parse(task.reference) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...ref };
  const field = fields[Math.floor(rng() * fields.length)] ?? fields[0]!;
  if (rng() < 0.5) {
    delete out[field]; // dropped field
  } else {
    out[field] = wrongValueFor(schema[field] ?? 'string', ref[field], rng); // wrong value
  }
  return JSON.stringify(out);
}

function corruptProse(task: EvalCorpusTask, rng: () => number): string {
  const s = OFF_TOPIC_SENTENCES[Math.floor(rng() * OFF_TOPIC_SENTENCES.length)] ?? OFF_TOPIC_SENTENCES[0]!;
  return `${s} ${task.reference}`;
}

/** Apply the task-kind corruption (deterministic via rng draws). */
export function corruptAnswer(task: EvalCorpusTask, rng: () => number): string {
  switch (task.kind) {
    case 'code':
      return corruptCode(task, rng);
    case 'extract':
      return corruptExtract(task, rng);
    case 'prose':
      return corruptProse(task, rng);
  }
}

/**
 * Answer an EVAL prompt from the corpus, corrupted with the model-class
 * probability (seeded rng). Draw 1 = corruption decision (always consumed so
 * the downstream confidence draw position is corruption-independent in count
 * for clean answers; corrupted answers consume a few extra parameter draws).
 */
export function evalAnswerText(model: string, task: EvalCorpusTask, rng: () => number): string {
  const draw = rng();
  if (draw >= corruptionRateForModel(model)) return task.reference; // clean
  return corruptAnswer(task, rng);
}

// ---- correctness derivation (judge ground truth) ----------------------------

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json|javascript|js)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function normalizeCode(text: string): string {
  return stripFences(text).replace(/\s+/g, '');
}

function extractCorrectness(task: EvalCorpusTask, answer: string): number {
  const schema = task.schema ?? {};
  const fields = Object.keys(schema);
  if (fields.length === 0) return 0;
  let parsed: Record<string, unknown>;
  try {
    const p = JSON.parse(stripFences(answer)) as unknown;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) return 0;
    parsed = p as Record<string, unknown>;
  } catch {
    return 0;
  }
  const ref = JSON.parse(task.reference) as Record<string, unknown>;
  let matched = 0;
  for (const f of fields) {
    if (!(f in parsed)) continue;
    matched += JSON.stringify(parsed[f]) === JSON.stringify(ref[f]) ? 1 : 0;
  }
  return matched / fields.length;
}

/**
 * Ground-truth correctness of an answer against the corpus reference, 0..1.
 * code: 1 iff whitespace-normalized source equals the reference (any injected
 * bug changes the token stream → 0). extract: fraction of schema fields equal
 * to the reference. prose: 1 exact, 0.35 when the reference survives behind an
 * off-topic prepend, else 0.
 */
export function corpusCorrectness(task: EvalCorpusTask, answer: string): number {
  switch (task.kind) {
    case 'code':
      return normalizeCode(answer) === normalizeCode(task.reference) ? 1 : 0;
    case 'extract':
      return extractCorrectness(task, answer);
    case 'prose': {
      const a = answer.trim();
      if (a === task.reference.trim()) return 1;
      if (a.includes(task.reference.trim())) return 0.35; // corrupted: off-topic prepend
      return 0;
    }
  }
}

// ---- prompt section parsing (judge / probe / verify prompts) -----------------

/** Last `assistant:` block before the final `user:` line (draft in probe/verify prompts). */
export function extractAssistantDraft(promptText: string): string | null {
  const aIdx = promptText.lastIndexOf('\nassistant:');
  if (aIdx < 0) return null;
  const uIdx = promptText.indexOf('\nuser:', aIdx + 1);
  if (uIdx < 0) return null;
  // M2-security: the draft is DATA-block wrapped in hardened probe prompts.
  return unwrapUntrustedData(promptText.slice(aIdx + '\nassistant:'.length, uIdx)).trim();
}

/** Candidate blocks from a best-of-n / ensemble judge prompt ("CANDIDATE <i>:\n…"). */
export function extractCandidates(promptText: string): string[] {
  const parts = promptText.split(/\nCANDIDATE \d+:\n/);
  if (parts.length < 2) return [];
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    let c = parts[i]!;
    // The final candidate runs into the closing instruction line.
    const end = c.indexOf('\nRespond with exactly one line:');
    if (end >= 0) c = c.slice(0, end);
    // M2-security: each candidate is DATA-block wrapped in hardened prompts.
    out.push(unwrapUntrustedData(c).trim());
  }
  return out;
}

/** Answer block from a harness llm-judge SCORE prompt (between ANSWER: and the instruction). */
export function extractScoreAnswer(promptText: string): string | null {
  const marker = '\nANSWER:\n';
  const aIdx = promptText.indexOf(marker);
  if (aIdx < 0) return null;
  const rest = promptText.slice(aIdx + marker.length);
  const end = rest.indexOf('\nRespond with exactly one line:');
  // M2-security: the answer is DATA-block wrapped in hardened judge prompts.
  return unwrapUntrustedData(end >= 0 ? rest.slice(0, end) : rest).trim();
}

/** Scale [lo, hi] from a SCORE instruction ("… in [0, 4]."). */
export function extractScoreScale(promptText: string): [number, number] {
  const m = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
  let last: [number, number] | null = null;
  for (let x = m.exec(promptText); x; x = m.exec(promptText)) {
    last = [Number(x[1]), Number(x[2])];
  }
  return last ?? [0, 1];
}

// ---- EVAL-aware special-fixture branches -------------------------------------
// Each returns null for non-EVAL prompts so specialFixtureText falls through to
// the bit-identical Phase-0/1 behavior. Each is documented in the header above.

/**
 * Corruption-aware self-report probe (cascade `self-report-calibrated`): the
 * mock rates its OWN draft. Clean drafts → raw confidence in [0.75, 0.99];
 * corrupted drafts → [0.50, 0.85] (seeded draws). After the strategy's linear
 * calibration (0.85·raw + 0.07) the bands become [0.7075, 0.911] vs
 * [0.495, 0.792], so a threshold near 0.70 accepts ALL clean drafts and
 * escalates ~71% of corrupted ones — a realistically imperfect self-report
 * (roughly three in ten corrupted drafts are over-confidently accepted, which
 * is exactly the quality gap a cascade leaves below a frontier-only strategy).
 */
export function evalSelfReportText(promptText: string, rng: () => number): string | null {
  const taskId = extractEvalTaskId(promptText);
  const task = taskId ? evalTaskById(taskId) : undefined;
  if (!task) return null;
  const draft = extractAssistantDraft(promptText);
  if (draft === null) return null;
  const correctness = corpusCorrectness(task, draft);
  const raw = correctness >= 0.999 ? 0.75 + rng() * 0.24 : 0.5 + rng() * 0.35;
  return `CONFIDENCE: ${raw.toFixed(2)}`;
}

/**
 * Corpus-aware judge pick (best-of-n / ensemble `judge-pick`): score every
 * CANDIDATE block against the corpus reference and pick the argmax. 15%
 * seeded fallibility picks uniformly at random instead — real judges err, and
 * a fallible judge is exactly why best-of-n lands below a frontier model.
 */
export function evalJudgePickText(promptText: string, rng: () => number): string | null {
  const taskId = extractEvalTaskId(promptText);
  const task = taskId ? evalTaskById(taskId) : undefined;
  if (!task) return null;
  const candidates = extractCandidates(promptText);
  if (candidates.length === 0) return null;
  const fallible = rng() < 0.15;
  let pick: number;
  if (fallible) {
    pick = Math.floor(rng() * candidates.length);
  } else {
    let best = -1;
    pick = 0;
    candidates.forEach((c, i) => {
      const s = corpusCorrectness(task, c);
      if (s > best) {
        best = s;
        pick = i;
      }
    });
  }
  return `PICK: ${pick}`;
}

/**
 * Judge SCORE fixture (harness llm-judge scorer): base = corpus correctness
 * of the ANSWER block (0.5 when the prompt carries no known EVAL task — e.g.
 * ad-hoc scorer tests), plus seeded noise ±0.08 of scale, clamped to the
 * scale, 1 decimal. Noise comes from the seeded rng, so two judge models with
 * different seeds (mock-judge-a / -b) get INDEPENDENT noise around the same
 * ground truth — that is what makes their scores correlate (calibration).
 */
export function evalJudgeScoreText(model: string, promptText: string, rng: () => number): string {
  const [lo, hi] = extractScoreScale(promptText);
  const span = hi - lo;
  const taskId = extractEvalTaskId(promptText);
  const task = taskId ? evalTaskById(taskId) : undefined;
  const answer = extractScoreAnswer(promptText);
  const base = task && answer !== null ? corpusCorrectness(task, answer) : 0.5;
  void model; // noise independence is achieved via caller-provided per-judge seeds
  const noise = (rng() - 0.5) * 2 * 0.08 * span;
  const score = Math.min(hi, Math.max(lo, lo + base * span + noise));
  return `SCORE: ${score.toFixed(1)}`;
}

/**
 * EVAL answer fixture: answer from the corpus with class-dependent seeded
 * corruption. Draft-verify verifier prompts (VERIFY_MARKER): the mock verifier
 * "trusts" the draft half the time (returns it verbatim, corruption and all);
 * otherwise it re-answers from the corpus at its own class rate. Returns null
 * when the prompt carries no EVAL signature (legacy word-bank path).
 */
export function evalAnswerFixtureText(
  model: string,
  promptText: string,
  rng: () => number,
): string | null {
  const taskId = extractEvalTaskId(promptText);
  const task = taskId ? evalTaskById(taskId) : undefined;
  if (!task) return null;
  if (VERIFY_MARKER.test(promptText)) {
    const draft = extractAssistantDraft(promptText);
    if (draft !== null && rng() < 0.5) return draft; // trust the draft
  }
  return evalAnswerText(model, task, rng);
}

// ─────────────────────────────────────────────────────────────────────────────
// M3 #23 composite streaming (ADDITIVE) — TEST/CI SIMULATION ONLY.
//
// Deterministic logprob-confidence override knob: a prompt containing the
// literal marker `[[mock-confidence:0.31]]` forces the mock's
// logprobConfidence to exactly 0.31 for that call. This lets composite /
// cascade tests pin the keep-vs-upgrade decision (confidence < threshold)
// without fishing for favorable seeds, in both directions (low forces an
// upgrade, high forces a keep). Prompts without the marker are bit-identical
// to before — the seeded rng draw sequence is UNCHANGED (the draw is still
// consumed; the override only replaces the value afterward). Like every mock
// fixture, an overridden confidence is a wiring fixture, never evidence of
// real-world model calibration.
// ─────────────────────────────────────────────────────────────────────────────

/** Marker: `[[mock-confidence:0.31]]` — value bounded to [0, 1]. */
export const MOCK_CONFIDENCE_OVERRIDE_RE = /\[\[mock-confidence:(0?\.\d+|1(?:\.0+)?)\]\]/i;

/** The pinned confidence from the marker, or null when the prompt has none. */
export function mockConfidenceOverride(promptText: string): number | null {
  const m = MOCK_CONFIDENCE_OVERRIDE_RE.exec(promptText);
  return m ? Number(m[1]) : null;
}
