// code-exec sandbox tests (SPEC §5 + ROADMAP §19 M2-security): execution now
// happens in an isolated worker_threads Worker (2s wall timeout + terminate,
// 32MB heap cap, stripped globals). Scoring semantics are unchanged from the
// in-process node:vm era: score = passed / total registered cases.
import { describe, expect, it } from 'vitest';
import { activeCodeExecWorkers, runCodeWithTests, scoreCodeExec } from './scorers.js';
import { stripCodeFences } from './code-exec-sandbox.js';

const ADD = 'function add(a, b) {\n  return a + b;\n}';
const ADD_TESTS =
  "test('positives', () => assert(add(2, 3) === 5));\n" +
  "test('negatives', () => assert(add(-4, 4) === 0));";

describe('code-exec scorer', () => {
  it('passing code scores 1', async () => {
    const { quality, report } = await scoreCodeExec(ADD, { kind: 'code-exec', language: 'javascript', tests: ADD_TESTS });
    expect(quality).toBe(1);
    expect(report).toMatchObject({ passed: 2, total: 2 });
  });

  it('partial credit = passed/total registered cases', async () => {
    const buggy = 'function add(a, b) {\n  return a + b + (a < 0 ? 1 : 0);\n}'; // fails only 'negatives'
    const { quality, report } = await scoreCodeExec(buggy, { kind: 'code-exec', language: 'javascript', tests: ADD_TESTS });
    expect(quality).toBe(0.5);
    expect(report.failures).toHaveLength(1);
  });

  it('syntax-broken code scores 0 with a load error', async () => {
    const { quality, report } = await scoreCodeExec('function add( {', { kind: 'code-exec', language: 'javascript', tests: ADD_TESTS });
    expect(quality).toBe(0);
    expect(report.error).toMatch(/failed to load/);
  });

  it("BLOCKS require('fs') (no Node globals in the sandbox)", async () => {
    const code = "const fs = require('fs');\nfunction add(a, b) { return a + b; }";
    const { quality, report } = await scoreCodeExec(code, { kind: 'code-exec', language: 'javascript', tests: ADD_TESTS });
    expect(quality).toBe(0);
    expect(report.error).toMatch(/require/);
  });

  it('BLOCKS process/io access from test-called code', async () => {
    const code = 'function steal() { return process.env.SECRET; }';
    const tests = "test('no process', () => assert(steal() === undefined));";
    const { quality, report } = await scoreCodeExec(code, { kind: 'code-exec', language: 'javascript', tests });
    expect(quality).toBe(0); // ReferenceError inside the test fn → case fails
    expect(report.passed).toBe(0);
  });

  it('BLOCKS process.exit (stripped in the worker realm too)', async () => {
    const { quality, report } = await scoreCodeExec('process.exit(1);', {
      kind: 'code-exec',
      language: 'javascript',
      tests: ADD_TESTS,
    });
    expect(quality).toBe(0);
    expect(report.error).toMatch(/failed to load|process/);
  });

  it('TIMES OUT on an infinite loop (worker killed at the wall bound)', { timeout: 15_000 }, async () => {
    const code = 'function hang() { while (true) {} }';
    const tests = "test('hangs', () => assert(hang() === undefined));";
    const start = Date.now();
    const { quality, report } = await scoreCodeExec(code, { kind: 'code-exec', language: 'javascript', tests });
    const elapsed = Date.now() - start;
    expect(quality).toBe(0);
    expect(report.error).toMatch(/test execution failed|timed? ?out/i);
    expect(elapsed).toBeLessThan(10_000);
    expect(activeCodeExecWorkers()).toBe(0); // terminated, not leaked
  });

  it('CAPS a memory bomb via the worker heap limit', { timeout: 20_000 }, async () => {
    const code =
      'function bomb() {\n  const a = [];\n  for (let i = 0; i < 1e7; i++) { a.push(new Array(100000).fill(i)); }\n  return a.length;\n}';
    const tests = "test('bomb', () => assert(bomb() > 0));";
    const { quality, report } = await scoreCodeExec(code, { kind: 'code-exec', language: 'javascript', tests });
    expect(quality).toBe(0);
    expect(report.error).toMatch(/memory|crashed|terminated|exited|timed? ?out/i);
    expect(activeCodeExecWorkers()).toBe(0);
  });

  it('BLOCKS eval/Function code generation', async () => {
    const code = "function sneaky() { return eval('1 + 1'); }";
    const tests = "test('no eval', () => assert(sneaky() === 2));";
    const { quality } = await scoreCodeExec(code, { kind: 'code-exec', language: 'javascript', tests });
    expect(quality).toBe(0);
  });

  it('BLOCKS context-escape attempts via Function constructors', async () => {
    // Classic node:vm escape: reach the host realm's process via a built-in's
    // constructor. codeGeneration.strings=false blocks it in the vm context;
    // even a successful escape would find `process` stripped from the worker.
    const code =
      'function escapeHatch() {\n' +
      "  const F = Object.getPrototypeOf(function () {}).constructor;\n" +
      "  return F('return process')();\n" +
      '}';
    const tests = "test('no escape', () => assert(typeof escapeHatch() === 'object'));";
    const { quality } = await scoreCodeExec(code, { kind: 'code-exec', language: 'javascript', tests });
    expect(quality).toBe(0);
  });

  it('runs 50 sequential executions without leaking workers/handles', { timeout: 60_000 }, async () => {
    expect(activeCodeExecWorkers()).toBe(0);
    for (let i = 0; i < 50; i++) {
      const { quality, report } = await scoreCodeExec(ADD, { kind: 'code-exec', language: 'javascript', tests: ADD_TESTS });
      expect(report.error).toBeUndefined();
      expect(quality).toBe(1);
    }
    expect(activeCodeExecWorkers()).toBe(0);
  });

  it('scores 0 when the tests snippet registers no cases', async () => {
    const report = await runCodeWithTests(ADD, 'var x = 1;');
    expect(report.error).toMatch(/no test cases/);
    const { quality } = await scoreCodeExec(ADD, { kind: 'code-exec', language: 'javascript', tests: 'var x = 1;' });
    expect(quality).toBe(0);
  });

  it('rejects non-JavaScript languages with a documented error', async () => {
    const { quality, report } = await scoreCodeExec('print(1)', { kind: 'code-exec', language: 'python', tests: '' });
    expect(quality).toBe(0);
    expect(report.error).toMatch(/JavaScript-only/);
  });
});

describe('stripCodeFences (M1b live fix: fenced answers scored structural 0)', () => {
  it('strips a ```javascript fence pair', async () => {
    const fenced = '```javascript\nfunction f(x) { return x + 1; }\n```';
    const { quality } = await scoreCodeExec(fenced, {
      kind: 'code-exec',
      language: 'javascript',
      tests: 'test("inc", () => assert(f(1) === 2));',
    });
    expect(quality).toBe(1);
  });
  it('strips a bare ``` fence pair', async () => {
    const fenced = '```\nfunction f(x) { return x * 2; }\n```';
    const { quality } = await scoreCodeExec(fenced, {
      kind: 'code-exec',
      language: 'javascript',
      tests: 'test("dbl", () => assert(f(2) === 4));',
    });
    expect(quality).toBe(1);
  });
  it('leaves bare code and inner template literals untouched', () => {
    const bare = 'function f() { return `a```b`; }';
    expect(stripCodeFences(bare)).toBe(bare);
  });
});
