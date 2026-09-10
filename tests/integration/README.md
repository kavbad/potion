# tests/integration — cross-package integration tests

Why these live here and not beside the code they exercise: each one imports a
package that, in turn, depends on the package the test would otherwise live in.
Declared as devDependencies that reads as harmless — nothing cyclic reaches
production — but `pnpm -r` orders BUILDS over the full graph, devDependencies
included. Three such edges closed seven cycles, pnpm broke them arbitrarily,
and `pnpm build` failed from a clean checkout by compiling `lab-dial` before
its own declared dependencies. It only ever succeeded because every local tree
already had a stale `dist/`; CI, which has none, would have failed on its first
run. (Found 2026-09-03 building in a clean worktree.)

Same reasoning `tests/chaos` already records: a root-level package imports the
others as built workspace deps, so the arrow only ever points one way.

| file | was | imports that closed a cycle |
| --- | --- | --- |
| `src/synthesis.test.ts` | `packages/lab-runtime/src/` | `@potion/server` |
| `src/walkthrough.test.ts` | `packages/lab-runtime/src/` | `@potion/server`, `@potion/lab-dial` |
| `src/mini-eval.test.ts` | `packages/lab-superpowers/src/` | `@potion/lab-runtime` |

Nothing about the tests themselves changed: relative imports became package
imports, and every symbol they need was already on the public index.

**The rule:** a test that imports a package which depends on this package's own
home belongs here, not next to the code. If `pnpm build` starts failing on a
clean tree again, look for a new devDependency edge first.
