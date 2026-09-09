// Workers-only vitest config: the root config, plus serial execution on CI.
//
// WHY ONLY HERE. src/lab-run.test.ts boots a REAL sandbox — a Python server
// that forks a shell, which forks git — while the rest of this package's
// files hold PGlite instances. On a 2-vCPU runner that is right at the edge:
// the same commit passed once and then failed with
//   __potion_main__.sh: fork: retry: Resource temporarily unavailable
//   exitCode 254, timedOut false, filesWritten []
// which is the runner out of headroom, surfacing on whichever test happens
// to fork at the wrong moment. Marginal, not broken — hence more room rather
// than a skip.
//
// One package pays for it instead of all twenty-one. The root config already
// caps workers at 2 on CI; this takes the package that actually forks
// subprocesses down to one file at a time, and leaves local runs untouched.
import { defineConfig, mergeConfig } from 'vitest/config';
import root from '../../vitest.config.js';

export default mergeConfig(
  root,
  defineConfig({
    test: {
      ...(process.env.CI ? { maxWorkers: 1, minWorkers: 1, fileParallelism: false } : {}),
    },
  }),
);
