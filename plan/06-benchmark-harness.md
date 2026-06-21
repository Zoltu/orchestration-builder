# Step 06 — Benchmark suite harness + authoring guide

## Goal

Build the harness that runs the executor over a suite of benchmarks, validates each final workspace against its `eval.json`, and emits a machine-readable summary. Also document how to author and run benchmarks. This is the foundation for steps 07–09, which add the actual benchmarks.

## Context

Read `docs/benchmarks.md` (the `eval.json` schema and validation rules) and `docs/architecture.md` ("Benchmark isolation and environments"). Validation runs a shell command in the final workspace and checks expected files / exit code / stdout. Note the **unsolved isolation** caveat in `docs/architecture.md`: until per-benchmark isolation is solved, the suite is constrained to tasks Bun can validate directly with no external installs. The isolation problem is now addressed by its own step, step 16.

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

None for code. Running the suite against a real LLM is operator work and is the subject of steps 07–09's handoffs.

## Closeout (step 05 complete)

Implemented in `source/benchmarks/`:

- `validation.ts` — pure: `EvalConfig`, `ValidationSpec`, `BenchmarkRunOutput`, `ValidationResult` types; `parseEvalConfig` (type-guard validation, throws path-based `ValidationError`); `evaluateValidation` (pure pass/fail decision with reasons). Covers every documented `eval.json` field, including `humanResponses`.
- `validation.test.ts` — 23 in-memory tests covering accepted/rejected configs and every evaluateValidation branch (pass, missing file, wrong exit code, missing stdout, timeout, default exit code 0, array stdout substrings, no-expectation pass, null exit code).
- `run-validation.ts` — leaf factory `createRunValidation(defaultTimeoutSeconds)` spawning the validation command under a timeout via `Bun.spawn`, reporting `BenchmarkRunOutput`. Workspace existence is a guard clause; stream reads wrap genuine I/O errors only. Not unit-tested.
- `run-suite.ts` — orchestration `runSuite(deps, options)` receiving five leaf dependencies explicitly (`listBenchmarkDirectories`, `readEvalConfig`, `runBenchmark`, `runValidation`, `writeSummary`) with no defaults. Writes `summary.json` with per-benchmark `pass`/`fail`/`error` status plus aggregate totals. Reads no `Bun.env`/`process.argv`.
- `run-suite.test.ts` — 7 in-memory tests with fakes asserting aggregation, fail/error handling, validation skip on error runs, token/walltime passthrough, task/humanResponses forwarding, task override + run-id prefix, and the empty-suite case.
- `benchmarks/README.md` — authoring guide, `eval.json` schema summary (references `docs/benchmarks.md`), the three-tier validation model, and running instructions.

Health: `bun run typecheck` clean; `bun test source/` → 200 pass / 0 fail (32 new), full suite ~530ms.

Deviations from the plan wording (authoritative):

1. **run-suite invokes an injected `runBenchmark` leaf, not `runExecutor` directly.** The plan said run-suite "invokes the executor (via `runExecutor` with assembled dependencies…)." Per `AGENTS.md` ("main is the only place that assembles real dependencies"), orchestration must not assemble executor dependencies, so the real executor-runner leaf is assembled by the CLI entry point (step 02) / the benchmark steps (07–09) and injected here. This keeps run-suite fully testable with a fake runner (the plan's stated intent) and matches the three-tier pattern. The operator handoff (real-LLM runs) is unchanged.
2. **run-suite takes three additional injected leaves** (`listBenchmarkDirectories`, `readEvalConfig`, `writeSummary`) so it touches no filesystem directly, matching `AGENTS.md`'s rule that orchestration receives leaf functions via `dependencies`. The plan named only "an executor runner and a validation runner"; the extra leaves are the honest three-tier application.
3. **No real `runBenchmark` producer is shipped in this step**, consistent with the operator handoff deferring real-LLM runs to steps 07–09 and the CLI entry point to step 02. The harness, pure validation, and the validation leaf are complete and verified in-memory; `benchmarks/README.md` documents that end-to-end suite execution is wired by step 02 / 07–09.

Forward note for the step that wires the real runner (step 02 / 07–09): the real `runBenchmark` leaf must source `tokens` for the summary. The executor does not currently aggregate token counts into `RunMeta` or the `llm_call` log event, so that step will need to surface token totals (e.g. accumulate usage in `RunMeta` or sum from the log). The harness itself only passes tokens through, so this is not step-06 debt; it is an executor-surfacing task for the real-runner step.
