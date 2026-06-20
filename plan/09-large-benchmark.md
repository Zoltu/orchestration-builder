# Step 09 — Large benchmark

## Goal

Author one large benchmark (half-day to multi-day expected) that runs to completion without hitting executor safety budgets. This is the first benchmark whose validation exercises the **full toolchain** — typecheck *and* test — so the agent is rewarded for satisfying the compiler as well as the test suite, the natural shape of real TypeScript work. (The isolation problem flagged in `docs/architecture.md` is now addressed by its own step, step 20, at the end of the plan; this step no longer carries the isolation revisit.)

## Context

Read [`08-medium-benchmarks.md`](08-medium-benchmarks.md) and `docs/architecture.md`. A large task should require multi-step decomposition, cross-file work, and iterative test/build cycles. The seed Guild's budgets already allow multi-hour runs (`maxRunTimeSeconds: 14400`). With the `typecheck` (step 04) and `test` (step 05) tools now available to the `coder` role, the agent can run the full toolchain to verify its work; this benchmark's validation rewards that by requiring both to pass.

## Deliverables

1. One large benchmark, e.g. `project_todo_cli` — build a small command-line todo app from scratch with tests, or `project_static_site` — a small static-site generator. The task must be completable with Bun stdlib only (no installs — isolation is step 20, still pending at this point in the plan), with **full-toolchain validation**: `bun run typecheck && bun test tests/` as the validation command (exit code 0 only when both the typechecker and the test suite are green). Author the benchmark's own `tsconfig.json` so `bun run typecheck` is meaningful against the benchmark workspace.
2. Full data layout; extend the suite-validity test.
3. Prompt iteration as needed (record in closeout). Pay attention to context pressure on long runs — if the run hits `context_budget_exceeded` frequently, the `context_manager` role or `edit_context` usage may need prompt guidance. Confirm the `coder` prompt's combined typecheck/test guidance (from steps 04/05) drives the agent to use both checkers on a long task.

## Module boundaries

- Data only, plus possible `guild/prompts/*.md` edits.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] One large benchmark exists, valid, with a non-developer `README.md`.
- [ ] The large benchmark's validation is `bun run typecheck && bun test tests/` (full toolchain).
- [ ] The large benchmark runs to completion (not cut off by safety budgets) in a real run (operator-verified). Passing is not required for this step — completion without budget exhaustion is the bar.

## End-of-step evaluation

If the large run hit budgets, decide whether to raise budgets (carefully — they are safety limits) or improve prompts. Prefer prompt/context-management fixes over budget raises. Confirm the suite as a whole (quick + medium + large) still typechecks and tests green. Confirm the full-toolchain validation did not make the benchmark impossibly hard for the seed Guild — if the typecheck half is the sole blocker, consider whether the benchmark's types are reasonable or whether the `coder` prompt needs guidance on reading `tsc` diagnostics (the `typecheck` tool surfaces them).

## Estimated effort

Large — authoring a good large benchmark and getting the seed Guild to complete it is the hardest data work so far.

## Operator handoff

Run the large benchmark against a real endpoint and report: did it complete? did it hit any safety budget? what was the final status and partial progress? Provide excerpts of `log.jsonl` around any `context_budget_exceeded` or budget events so the agent can iterate prompts in-environment.
