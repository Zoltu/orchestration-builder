# Step 16 — Foundry branch evaluation

## Goal

Add the orchestration that evaluates a single branch: run every benchmark in the suite through the executor (respecting `maxConcurrentExecutorRuns`, which is 1 for a single local model), validate each final workspace, score the branch, and write per-benchmark results under `data/foundry/branches/<branch_id>/results/`.

## Context

Read `docs/foundry.md` ("Branches and experiments", "Evaluation") and [`15-foundry-validation-scoring.md`](15-foundry-validation-scoring.md). The Foundry invokes the executor as a black box. For sequential mode (`maxConcurrentExecutorRuns: 1`) this is a simple loop. Parallelism across big-model requests (step 17/18) is separate and not in scope here.

## Deliverables

1. `source/foundry/evaluate.ts` — orchestration `evaluateBranch(dependencies, { branchId, guildPath, suiteDir, config, repetitions })`:
   - For each benchmark in the suite, run the executor `repetitions` times against the branch Guild.
   - After each run, validate the final workspace (step 15) and collect a `RunRecord` (status, tokens, ask count, context events, errors, wall time, runId).
   - Aggregate into a `BranchScore` (step 15).
   - Write `data/foundry/branches/<branch_id>/results/<benchmark>.json` and a branch-level `results.json`.
   - Receives its dependencies explicitly: an executor runner (so tests inject a fake), a validation runner, the branch manager (step 14), persistence. No defaults.
2. `source/foundry/evaluate.test.ts` — in-memory test with a fake executor runner returning scripted outcomes and a fake validation runner. Assert: a branch that passes all benchmarks scores 1.0 and writes the expected result files (in a temp `data/` tree, cleaned up); a branch that fails one benchmark records fail + reasons; regression flags propagate.
3. The executor-runner dependency is a thin wrapper that calls `runExecutor` with assembled leaf factories — this wrapper is **not** unit-tested (it is integration glue); only the orchestration is tested.

## Module boundaries

- `evaluate.ts` is orchestration; all leaves (executor runner, validation runner, persistence) are injected.
- No LLM calls in this step (the executor uses the small model; the Foundry's big model is steps 17–18).
- `maxConcurrentExecutorRuns` is honored: for v1 it is 1 (sequential). If a parallel path is added later, it becomes a separate step.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] `evaluateBranch` produces correct per-benchmark and branch-level result files (verified with fakes).
- [ ] Repetitions are honored (N runs per benchmark).
- [ ] Temp `data/` trees are cleaned up by tests.

## End-of-step evaluation

Confirm `evaluate.ts` does not reach for globals or `Bun.env`. Ensure the executor-runner wrapper is genuinely thin (calls `runExecutor` + assembles deps, nothing more). Re-read against `docs/foundry.md` to confirm all recorded fields match the documented `results/<benchmark>.json` shape.

## Estimated effort

Medium — orchestration with injected fakes.

## Operator handoff

None — fully in-memory. A real evaluation run is part of the loop in step 19.
