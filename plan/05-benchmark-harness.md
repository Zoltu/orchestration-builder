# Step 05 — Benchmark suite harness + authoring guide

## Goal

Build the harness that runs the executor over a suite of benchmarks, validates each final workspace against its `eval.json`, and emits a machine-readable summary. Also document how to author and run benchmarks. This is the foundation for steps 06–08, which add the actual benchmarks.

## Context

Read `docs/benchmarks.md` (the `eval.json` schema and validation rules) and `docs/architecture.md` ("Benchmark isolation and environments"). Validation runs a shell command in the final workspace and checks expected files / exit code / stdout. Note the **unsolved isolation** caveat in `docs/architecture.md`: until per-benchmark container isolation is solved, the suite is constrained to tasks Bun can validate directly with no external installs. Step 08's closeout should revisit this.

## Deliverables

1. `source/benchmarks/validation.ts` — **pure** validation helpers (the testable surface):
   - `parseEvalConfig(unknown): EvalConfig` — validate an `eval.json` object with a type guard; reject malformed input with a clear `ValidationError`.
   - `evaluateValidation(validation, runOutput): ValidationResult` — given the parsed `validation` block and a `runOutput` (expected-files existence booleans, exit code, stdout), return `{ status: 'pass' | 'fail', reasons: string[] }`. No shell execution here; this is pure decision logic.
   - Type definitions for `EvalConfig`, `ValidationSpec`, `BenchmarkRunOutput`, `ValidationResult`.
2. `source/benchmarks/validation.test.ts` — in-memory tests: passing validation; missing expected file → fail with reason; wrong exit code → fail; missing stdout substring → fail; timeout is an operator-reported input, not computed here.
3. `source/benchmarks/run-validation.ts` — a **leaf** that, given a workspace path and a `ValidationSpec`, runs the validation command under the configured timeout and returns a `BenchmarkRunOutput` (exit code, stdout, expected-file existence). This is the thin shell-execution leaf; not unit-tested.
4. `source/benchmarks/run-suite.ts` — orchestration that, for each benchmark directory in a suite:
   - Reads `eval.json`, parses it with `parseEvalConfig`.
   - Invokes the executor (via `runExecutor` with assembled dependencies — for operator runs a real LLM; for any in-memory test a fake is injected) and obtains the run's final workspace.
   - Calls `run-validation` then `evaluateValidation`.
   - Records `{ benchmark, status, tokens, wallTimeSeconds, runId, reasons }`.
   - Writes a `summary.json` to a configured output path.
   This is testable orchestration: it receives its dependencies (an executor runner and a validation runner) via a `dependencies` object with no defaults.
5. `source/benchmarks/run-suite.test.ts` — in-memory test using a fake executor runner and a fake validation runner to assert the summary is assembled correctly (pass/fail/error aggregation, token/walltime passthrough).
6. `benchmarks/README.md` — how to add a benchmark, the `eval.json` schema (reference `docs/benchmarks.md`), how to run a single benchmark via `bun source/main.ts`, and how to run the suite via `bun source/benchmarks/run-suite.ts`.

## Module boundaries

- `validation.ts` is pure (decision logic) — tested.
- `run-validation.ts` is a leaf (spawns a process) — not tested.
- `run-suite.ts` is orchestration receiving deps explicitly — tested with fakes.
- `main.ts`/CLI integration of the suite runner can wait or be a thin wrapper; do not put orchestration logic in the CLI.

## Acceptance criteria

- [ ] `bun run typecheck` passes.
- [ ] `bun test source/` passes, including `validation.test.ts` and `run-suite.test.ts`.
- [ ] `parseEvalConfig` rejects malformed `eval.json` with a clear error.
- [ ] `run-suite.ts` produces a `summary.json` with per-benchmark pass/fail/error and aggregate counts (verified with fakes).
- [ ] `benchmarks/README.md` documents authoring and running.

## End-of-step evaluation

Confirm the split between pure `validation.ts`, leaf `run-validation.ts`, and orchestration `run-suite.ts` is clean and matches the AGENTS.md three-tier pattern. Ensure `run-suite.ts` does not read `Bun.env` or `process.argv` (that belongs in a CLI wrapper). Re-read `docs/benchmarks.md` and confirm `parseEvalConfig` covers every documented field, including `humanResponses`.

## Estimated effort

Medium — the validation pure-logic and the suite orchestration are the bulk.

## Operator handoff

None for code. Running the suite against a real LLM is operator work and is the subject of steps 06–08's handoffs.
