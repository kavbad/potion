// code-exec sandbox (ROADMAP §19, M2-security): generated JavaScript and the
// item's `tests` snippet now run INSIDE A DEDICATED worker_threads Worker —
// not in the harness process. This replaces the M1 in-process node:vm
// execution (see git history for scorers.ts before this change).
//
// THREAT MODEL (see docs/security/CODE-EXEC.md for the full writeup):
//   Untrusted benchmark/model-generated code is arbitrary attacker JS. The
//   worker boundary gives us, over the old in-process vm context:
//     - hard wall-clock kill: a stuck or hostile run cannot block the harness
//       event loop forever — the main thread terminates the worker;
//     - memory cap: V8 resourceLimits (maxOldGenerationSizeMb 32) kill a
//       memory bomb in the worker instead of OOM-ing the harness process;
//     - crash containment: a fatal error in the worker surfaces as an 'error'/
//       'exit' event here and is mapped to a structural score-0 report;
//     - stripped worker globals: require/process/module/fs/net/timers/fetch
//       are deleted from the worker realm BEFORE untrusted code runs, so even
//       a vm-context escape lands in a featureless realm;
//     - message passing only: results cross the thread boundary as plain data
//       (structured clone), never as live objects.
//   This is NOT gVisor: worker_threads shares the OS process's kernel attack
//   surface, so a V8 0-day or a deliberate native escape is NOT contained.
//   Container/microVM isolation lands with infra in M3 (THREAT-MODEL.md gap
//   list). This layer contains crashes, hangs, memory bombs and trivial
//   sandbox escapes — which is the realistic risk for benchmark code.
//
// Scoring contract is unchanged: score = passed / total registered test
// cases; any structural failure (load error, timeout, crash, no cases) → 0.
import { Worker } from 'node:worker_threads';
import type { ScoringMethod } from '@potion/core';

export const CODE_EXEC_TIMEOUT_MS = 2000;

/** V8 old-generation heap cap for the sandbox worker (mission spec: 32 MB). */
export const CODE_EXEC_WORKER_MEMORY_MB = 32;

/** Young-generation cap: makes fast-growing allocation bombs trip the limit sooner. */
export const CODE_EXEC_WORKER_YOUNG_MEMORY_MB = 8;

/**
 * Backstop slack on top of the per-phase vm timeout. The vm `timeout` option
 * is the precision mechanism (it interrupts synchronous JS at ~timeoutMs);
 * the wall timer is the HARD bound: if the worker has not reported by
 * timeoutMs + slack, it is terminated so nothing can leak or hang the run.
 */
export const CODE_EXEC_WALL_SLACK_MS = 500;

export interface CodeExecReport {
  passed: number;
  total: number;
  /** Names of failed cases (empty on clean pass / structural failure). */
  failures: string[];
  /** Structural error (syntax/timeout/throw outside test fns) → score 0. */
  error?: string;
}

/**
 * Worker source (CJS, loaded with { eval: true } so no on-disk path is needed
 * — the same source runs under tsx/vitest from src/ and from compiled dist/).
 * The phases mirror the pre-worker implementation EXACTLY (same error strings)
 * so scorer behavior is bit-compatible; only the isolation boundary changed.
 */
const WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');

// Strip host globals BEFORE any untrusted code runs. The vm context never
// exposes these in the first place; this is defense-in-depth so that even a
// successful context escape finds no require/process/fs/net/timers/fetch in
// the worker realm. parentPort/vm were captured above and keep working.
(function stripGlobals() {
  const names = [
    'process', 'require', 'module', 'exports', '__filename', '__dirname',
    'global', 'Buffer',
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    'setTimeout', 'setInterval', 'setImmediate',
    'clearTimeout', 'clearInterval', 'clearImmediate',
    'queueMicrotask', 'navigator', 'performance',
    'MessageChannel', 'MessagePort', 'BroadcastChannel', 'Worker',
  ];
  for (const k of names) {
    try { delete globalThis[k]; } catch (_) { /* ignore */ }
    try {
      Object.defineProperty(globalThis, k, {
        value: undefined, writable: false, configurable: false, enumerable: false,
      });
    } catch (_) { /* ignore */ }
  }
})();

function errMsg(e) { return e instanceof Error ? e.message : String(e); }

function run(code, tests, timeoutMs) {
  const sandbox = {};
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  try {
    vm.runInContext(code, context, { timeout: timeoutMs });
  } catch (e) {
    return { passed: 0, total: 0, failures: [], error: 'generated code failed to load: ' + errMsg(e) };
  }
  try {
    vm.runInContext(
      'var __tests = [];\n' +
      'function test(name, fn) { __tests.push({ name: String(name), fn: fn }); }\n' +
      'function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }\n' +
      'function assertDeepEqual(actual, expected) {\n' +
      '  if (JSON.stringify(actual) !== JSON.stringify(expected)) {\n' +
      '    throw new Error("expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));\n' +
      '  }\n' +
      '}',
      context,
      { timeout: timeoutMs },
    );
    vm.runInContext(tests, context, { timeout: timeoutMs });
  } catch (e) {
    return { passed: 0, total: 0, failures: [], error: 'tests snippet failed to load: ' + errMsg(e) };
  }
  let resultsJson;
  try {
    // Return JSON so only plain data crosses the vm/worker realm boundary.
    resultsJson = vm.runInContext(
      '(function () {\n' +
      '  var out = [];\n' +
      '  for (var i = 0; i < __tests.length; i++) {\n' +
      '    try { __tests[i].fn(); out.push({ name: __tests[i].name, passed: true }); }\n' +
      '    catch (e) { out.push({ name: __tests[i].name, passed: false, error: String((e && e.message) || e) }); }\n' +
      '  }\n' +
      '  return JSON.stringify(out);\n' +
      '})()',
      context,
      { timeout: timeoutMs },
    );
  } catch (e) {
    // e.g. infinite loop inside a test function → vm wall-clock timeout.
    return { passed: 0, total: 0, failures: [], error: 'test execution failed: ' + errMsg(e) };
  }
  const results = JSON.parse(resultsJson);
  if (!Array.isArray(results) || results.length === 0) {
    return { passed: 0, total: 0, failures: [], error: 'no test cases registered' };
  }
  const passed = results.filter(function (r) { return r.passed; }).length;
  return {
    passed: passed,
    total: results.length,
    failures: results
      .filter(function (r) { return !r.passed; })
      .map(function (r) { return r.name + ': ' + (r.error || 'failed'); }),
  };
}

let report;
try {
  report = run(workerData.code, workerData.tests, workerData.timeoutMs);
} catch (e) {
  report = { passed: 0, total: 0, failures: [], error: 'sandbox worker failure: ' + errMsg(e) };
}
// Result crosses the thread boundary as plain structured-clone data. The main
// thread terminates the worker (globals here are stripped; we cannot and
// should not exit on our own).
parentPort.postMessage({ report: report });
`;

interface WorkerReply {
  report: CodeExecReport;
}

/** Live worker gauge — exported for leak tests and observability. */
let activeWorkers = 0;
export function activeCodeExecWorkers(): number {
  return activeWorkers;
}

function structuralError(error: string): CodeExecReport {
  return { passed: 0, total: 0, failures: [], error };
}

/**
 * Run `code` + `tests` in a fresh sandbox worker. Exactly one worker per run;
 * it is ALWAYS terminated (success, crash, or wall-timeout kill) before this
 * promise settles, so repeated runs cannot leak threads or handles.
 */
export async function runCodeWithTests(
  code: string,
  tests: string,
  timeoutMs: number = CODE_EXEC_TIMEOUT_MS,
): Promise<CodeExecReport> {
  const wallMs = timeoutMs + CODE_EXEC_WALL_SLACK_MS;
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { code, tests, timeoutMs },
    resourceLimits: {
      maxOldGenerationSizeMb: CODE_EXEC_WORKER_MEMORY_MB,
      maxYoungGenerationSizeMb: CODE_EXEC_WORKER_YOUNG_MEMORY_MB,
    },
  });
  activeWorkers++;
  // NOTE: no worker.unref() — an unref'd worker plus an unref'd timer would
  // leave nothing holding the event loop during the await, so a CLI process
  // could exit mid-run. Leak safety comes from the finally-block terminate,
  // which always runs (success, crash, or wall-timeout).
  try {
    return await new Promise<CodeExecReport>((resolve) => {
      let settled = false;
      const finish = (report: CodeExecReport): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(report);
      };
      // Hard wall-clock backstop: terminate-on-timeout is handled by the
      // finally block below; here we only settle the promise.
      const timer = setTimeout(() => {
        finish(
          structuralError(
            `test execution failed: sandbox worker timed out after ${wallMs}ms wall clock (terminated)`,
          ),
        );
      }, wallMs);
      worker.once('message', (msg: WorkerReply) => finish(msg.report));
      worker.once('error', (err: Error) =>
        // V8 resource-limit breach (memory bomb) and fatal worker errors land here.
        finish(structuralError(`sandbox worker crashed (memory cap or fatal error): ${err.message}`)),
      );
      worker.once('exit', (exitCode: number) => {
        if (exitCode !== 0) {
          finish(
            structuralError(
              `sandbox worker exited with code ${exitCode} before reporting (memory cap or fatal error)`,
            ),
          );
        } else {
          finish(structuralError('sandbox worker exited without reporting a result'));
        }
      });
    });
  } finally {
    // Terminate is idempotent and resolves immediately for a dead worker;
    // awaiting it keeps the active-worker gauge exact for leak detection.
    await worker.terminate().catch(() => 0);
    activeWorkers--;
  }
}

/** Tolerant code extraction (mirrors the field-match scorer's ```json
 * tolerance): strips ONE surrounding markdown fence pair (```/```javascript/
 * ```js, any casing) plus surrounding whitespace. Models sometimes emit
 * fences despite "no markdown fences" prompts (observed live: Sonnet on
 * every humaneval item → structural syntax-error 0s, M1b). Bare code and
 * inner backticks are untouched. */
export function stripCodeFences(answer: string): string {
  return answer
    .trim()
    .replace(/^```(?:javascript|js)?\s*\n?/i, '')
    .replace(/\n?\s*```$/, '')
    .trim();
}

/** code-exec score: fraction of passing test cases (0 on structural failure). */
export async function scoreCodeExec(
  answer: string,
  scoring: Extract<ScoringMethod, { kind: 'code-exec' }>,
): Promise<{ quality: number; report: CodeExecReport }> {
  if (scoring.language !== 'javascript') {
    return {
      quality: 0,
      report: {
        passed: 0,
        total: 0,
        failures: [],
        error: `unsupported language '${scoring.language}' (worker sandbox is JavaScript-only)`,
      },
    };
  }
  const report = await runCodeWithTests(stripCodeFences(answer), scoring.tests);
  if (report.error !== undefined || report.total === 0) return { quality: 0, report };
  return { quality: report.passed / report.total, report };
}
