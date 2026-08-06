# tasks/lessons.md — patterns from corrections

Reviewed at session start (CLAUDE.md working conventions). One entry per
correction: what happened, the pattern to apply next time.

## 2026-08-06 — an enforcement cap is itself a behavior change

While fixing the cost estimator (projections must dominate actuals), the fix
enforced `max_tokens=1024` on the openai-shaped transport — correct for the
bound, but I was ready to mark the item done without checking what the new cap
would do to the measurements themselves. Owner caught it: recorded M1b answers
reached 1501 tokens, and analysis showed the >1024 answers were the HIGHEST
quality ones (0.942 vs 0.828 mean), all on agentic-tool-use. A dominating
projection achieved by silently truncating the best answers would have been a
worse defect than the one being fixed — it degrades measured quality exactly
where the product's differentiation story lives.

**Pattern**: when a fix adds an enforcement bound (cap, timeout, limit,
validation), before marking done, check the recorded/production distribution
of the quantity being bounded — specifically the tail ABOVE the new bound and
what that tail correlates with (quality, revenue, latency). If the tail is
real, the bound must be configurable with the dependent calculation bound to
the configured value, not a constant. "The invariant now holds" is not done;
"the invariant holds and nothing it governs silently changed meaning" is done.

## 2026-08-06 — commit hygiene: history starts before the work does

The repo arrived as a zip with no .git; I built a session's worth of changes
on top before version control existed, and reconstructing a reviewable
baseline → fix history required stash/restore gymnastics (possible only
because the zip still existed). **Pattern**: on first contact with any repo
that has no .git, `git init` + baseline commit BEFORE touching anything —
a reviewable diff is part of the deliverable, not an afterthought.
