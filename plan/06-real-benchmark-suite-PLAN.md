# Phase 6 — Real Benchmark Suite

## Goal

Expand beyond the smoke benchmark to a diverse suite that exercises the executor and seed Guild across task scales and types. This suite becomes the training/evaluation target for the eventual Foundry.

## Deliverables

1. Benchmark taxonomy:
   - **Quick fixes (5–30 minutes expected):** small bug fixes, tiny feature additions, README updates.
   - **Medium tasks (1–3 hours expected):** implement a small feature end-to-end, refactor a module, add tests.
   - **Large tasks (half-day to multi-day expected):** build a small application from scratch, perform cross-file refactoring, integrate an external library.

2. Initial benchmark set (8–12 benchmarks):
   - `bugfix_missing_import` — fix a Python import error.
   - `feature_add_validation` — add input validation to an existing function.
   - `feature_add_endpoint` — add a small HTTP endpoint to an existing app.
   - `project_todo_cli` — build a small command-line todo app from scratch.
   - `project_static_site` — build a small static website generator.
   - `refactor_extract_module` — split a large file into modules.
   - `maintenance_dependency_update` — update a dependency and fix breaking changes.
   - `maintenance_test_repair` — fix failing tests after a behavior change.

3. `benchmarks/README.md` — documentation:
   - How to add a benchmark.
   - `eval.json` schema expectations.
   - How to run a single benchmark.
   - How to run the full suite with a summary script.

4. `scripts/run-suite.ts` — simple suite runner:
   - Run the executor against each benchmark.
   - Run each benchmark’s validation command.
   - Produce a JSON summary: pass/fail/error per benchmark, token usage, wall time.

## Long-horizon diversity

Because the final agent must handle both quick fixes and multi-day builds, the suite must include both extremes. During this phase we deliberately avoid biasing prompts toward quick tasks. Each benchmark is described to the agent as a real user request, not as a time-boxed challenge.

## Module boundaries

- The benchmark workspace files are data, not source code.
- `scripts/run-suite.ts` is a thin orchestration layer; the executor still performs all runs.
- Validation logic is defined in each benchmark’s `eval.json`.

## Acceptance criteria

- [ ] At least 3 quick-fix benchmarks pass against the seed Guild.
- [ ] At least 2 medium benchmarks pass or produce meaningful partial progress.
- [ ] At least 1 large benchmark runs to completion without hitting executor safety budgets.
- [ ] The suite runner produces a machine-readable summary.
- [ ] Every benchmark has a clear `README.md` task description suitable for a non-developer.

## Estimated effort

Medium to large — creating good benchmarks is time-consuming and the seed Guild will need prompt iteration to pass them.
