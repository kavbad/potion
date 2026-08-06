# Code-Exec Sandbox (M2)

**Component:** `packages/harness/src/code-exec-sandbox.ts` (used by the `code-exec` scorer in
`packages/harness/src/scorers.ts`).
**Status:** shipped in M2-security (ROADMAP §19). Replaces the M1 in-process `node:vm` execution.

## What runs here

The `code-exec` scorer executes **untrusted JavaScript**: model- or benchmark-generated code plus
the eval item's `tests` snippet, which registers `test(name, fn)` cases. Score = `passed / total`;
any structural failure (load error, timeout, crash, no cases) scores 0. This contract is unchanged
from M1 — only the isolation boundary moved.

## Controls

| Control | Mechanism |
|---|---|
| Thread isolation | One fresh `worker_threads` Worker per run; results return via `postMessage` (structured clone, plain data only). |
| Wall-clock timeout | `vm.runInContext({ timeout: 2000ms })` per phase (precision) + a hard wall backstop at `timeoutMs + 500ms` after which the main thread calls `worker.terminate()` (kill guaranteed). |
| Memory cap | V8 `resourceLimits`: `maxOldGenerationSizeMb: 32`, `maxYoungGenerationSizeMb: 8`. A memory bomb kills the worker ("JS heap out of memory"), not the harness process. |
| Stripped worker globals | `process`, `require`, `module`, `exports`, `Buffer`, `fetch`, `XMLHttpRequest`, `WebSocket`, all timers, `queueMicrotask`, `MessageChannel`, `Worker`, etc. are deleted/locked in the worker realm **before** untrusted code runs. |
| No code generation | `vm.createContext({ codeGeneration: { strings: false, wasm: false } })` blocks `eval`/`Function`/`WebAssembly` — including the classic `constructor.constructor('return process')()` escape. |
| Leak safety | The worker is always terminated in a `finally` block; `activeCodeExecWorkers()` is an exported gauge asserted to be 0 after 50 sequential runs in tests. |

## Threat model — what this does and does not stop

**Contained:** infinite loops / hangs (worker kill), memory bombs (heap cap), crashes and fatal
errors (mapped to a structural score-0 report), direct `require('fs')` / `process.exit` /
network / timer access (absent globals), and trivial vm-context escapes (string code generation
is disabled; an escape lands in a featureless stripped realm).

**NOT contained — this is not gVisor:** worker_threads shares the host OS process. A V8 0-day, a
JIT/type-confusion escape, or a supply-chain-compromised native module in the harness process is
**out of scope** for this layer. The 32MB cap is per-worker V8 heap only; it does not bound native
memory, and the wall backstop bounds wall time, not CPU fairness across concurrent runs.

**M3 gap (infra-owned):** container/microVM isolation (gVisor/Firecracker), seccomp/namespace
restrictions, cgroup CPU+memory limits, network-egress deny for sandbox pods, and non-JavaScript
languages (python code-exec items are currently rejected with a documented warning).

## Test evidence

`packages/harness/src/code-exec.test.ts`: passing/partial/syntax-error scoring (contract),
`require('fs')` blocked, `process.env`/`process.exit` blocked, infinite loop → timeout kill
(~2.0s), memory bomb → heap-cap kill, eval/Function blocked, constructor-escape attempt blocked,
50 sequential runs with zero leaked workers.
