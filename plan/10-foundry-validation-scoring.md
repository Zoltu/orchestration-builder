# Step 10 — Foundry validation + scoring

## Goal

Add the pure logic that (a) validates a completed run's final workspace against a benchmark's `eval.json` (reusing step 05's validation helpers) and (b) scores a branch across its benchmark results, including the `ask_human` penalty and stochasticity handling.

## Context

Read `docs/foundry.md` ("Evaluation", "Statistical evaluation", "Human simulation and question penalty") and [`05-benchmark-harness.md`](05-benchmark-harness.md). Scoring inputs: per-benchmark pass/fail/error, tokens, context-pressure events, error events, `ask_human` count, wall time. `adjustedScore = (pass ? 1.0 : 0.0) - humanQuestionPenalty * askHumanCount`. Each benchmark is run N times (default 3–5) and pass rate is computed across repetitions; a branch is "better" only if it exceeds baseline by a configured margin.

## Deliverables

1. `source/foundry/score.ts` — pure helpers:
   - `scoreRun(runRecord, penalty): RunScore` — pass/fail, adjusted score, tokens, ask count, context-pressure count, error count.
   - `aggregateBranch(perBenchmarkRuns, penalty, baselinePassRates, margin): BranchScore` — per-benchmark win/loss/partial counts, overall pass rate, adjusted score, regression flag (did any baseline-passing benchmark regress?), improvement flag (does adjusted pass rate exceed baseline by `margin`?).
   - Pure decision logic only; no I/O.
2. `source/foundry/score.test.ts` — in-memory tests: a clean pass scores 1.0; an `ask_human` call reduces the score by the penalty; a branch that regresses on a baseline-passing benchmark is flagged; a branch within the margin is not flagged as improved; win/loss/partial aggregation across repetitions.
3. `source/foundry/validate-run.ts` — thin orchestration that takes a run's final workspace path + an `EvalConfig` and the step-05 validation leaf, returns a `ValidationResult`. Receives the validation leaf via `dependencies` (no defaults). Tested with a fake leaf.
4. Reuse `source/benchmarks/validation.ts` (`parseEvalConfig`, `evaluateValidation`) — do not duplicate.

## Module boundaries

- `score.ts` is pure — heavily tested.
- `validate-run.ts` is thin orchestration depending on the step-05 validation leaf.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] `scoreRun` and `aggregateBranch` behave exactly per the formulas in `docs/foundry.md`.
- [ ] Regression detection flags a branch that loses a baseline-passing benchmark.
- [ ] No duplication of step-05 validation logic.

## End-of-step evaluation

Re-read `score.ts` against `docs/foundry.md` and confirm every documented metric is computed. Ensure the margin/stochasticity logic is expressed as pure functions with obvious inputs/outputs.

## Estimated effort

Medium — pure logic, but the scoring rules are nuanced.

## Operator handoff

None — fully in-memory.
