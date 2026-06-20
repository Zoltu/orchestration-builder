# Step 08 — Large benchmark + isolation revisit

## Goal

Author one large benchmark (half-day to multi-day expected) that runs to completion without hitting executor safety budgets, and revisit the unsolved benchmark-isolation problem flagged in `docs/architecture.md`.

## Context

Read [`07-medium-benchmarks.md`](07-medium-benchmarks.md) and `docs/architecture.md` ("Benchmark isolation and environments (unsolved)"). A large task should require multi-step decomposition, cross-file work, and iterative test/build cycles. The seed Guild's budgets already allow multi-hour runs (`maxRunTimeSeconds: 14400`).

## Deliverables

1. One large benchmark, e.g. `project_todo_cli` — build a small command-line todo app from scratch with tests, or `project_static_site` — a small static-site generator. The task must be completable with Bun stdlib only (no installs), with `bun test` as validation.
2. Full data layout; extend the suite-validity test.
3. Prompt iteration as needed (record in closeout). Pay attention to context pressure on long runs — if the run hits `context_budget_exceeded` frequently, the `context_manager` role or `edit_context` usage may need prompt guidance.
4. An **isolation revisit** section added to `docs/architecture.md` (update the existing "unsolved" section) recording the current decision: v1 ships with no per-benchmark container isolation; the suite is constrained to no-install, Bun-validatable tasks; a concrete proposal (Docker Sandbox trimmed down, or an alternative) is deferred to a future step. If a concrete proposal is ready, **insert a new step** (e.g. `08a-benchmark-isolation.md`) and renumber; otherwise leave the deferral documented.

## Module boundaries

- Data + `docs/architecture.md` update + possible `guild/prompts/*.md` edits.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] One large benchmark exists, valid, with a non-developer `README.md`.
- [ ] The large benchmark runs to completion (not cut off by safety budgets) in a real run (operator-verified). Passing is not required for this step — completion without budget exhaustion is the bar.
- [ ] `docs/architecture.md` isolation section is updated with the current decision and explicit deferral (or a new isolation step is inserted).

## End-of-step evaluation

If the large run hit budgets, decide whether to raise budgets (carefully — they are safety limits) or improve prompts. Prefer prompt/context-management fixes over budget raises. Confirm the suite as a whole (quick + medium + large) still typechecks and tests green.

## Estimated effort

Large — authoring a good large benchmark and getting the seed Guild to complete it is the hardest data work so far.

## Operator handoff

Run the large benchmark against a real endpoint and report: did it complete? did it hit any safety budget? what was the final status and partial progress? Provide excerpts of `log.jsonl` around any `context_budget_exceeded` or budget events so the agent can iterate prompts in-environment.
