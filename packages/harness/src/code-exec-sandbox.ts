// The code-exec sandbox moved to @potion/strategies (R4 exec-pick, 2026-08-24)
// so the SERVING-side fusion and the harness scorer run the exact same
// isolation. This shim keeps every existing harness-side import working.
export {
  activeCodeExecWorkers,
  CODE_EXEC_TIMEOUT_MS,
  CODE_EXEC_WALL_SLACK_MS,
  CODE_EXEC_WORKER_MEMORY_MB,
  CODE_EXEC_WORKER_YOUNG_MEMORY_MB,
  runCodeWithTests,
  scoreCodeExec,
  stripCodeFences,
  type CodeExecReport,
} from '@potion/strategies';
