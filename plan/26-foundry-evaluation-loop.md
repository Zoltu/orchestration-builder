# Step 26 — Foundry evaluation loop

## Goal

Compose the orchestration that evaluates a single branch: for every benchmark in the suite, submit a run to the executor service via the step-25 container orchestration, validate each final workspace, score the branch, and write per-benchmark results under `data/foundry/branches/<branch_id>/results/`. This step is the loop; step 25 is the per-run leaf.

## Context

Read `docs/foundry.md` ("Branches and experiments", "Evaluation") and [`25-foundry-evaluation-orchestration.md`](25-foundry-evaluation-orchestration.md) (the container-orchestration leaf this step composes), [`24-foundry-validation-scoring.md`](24-foundry-validation-scoring.md) (scoring + validation), and [`23-foundry-foundation.md`](23-foundry-foundation.md) (the branch manager).

The Foundry invokes the executor as a black box over the service API. For a single-node deployment the executor service executes one run at a time (its sequential LLM queue), so `FoundryConfig.maxConcurrentExecutorRuns` is interpreted as pipeline parallelism of the optimize-score-decide loop, not parallel run execution: each in-flight branch submits its benchmark runs and the loop waits on their results. If the host runs multiple service containers (one per benchmark, per the deployment model), true parallelism is available at the container level — this step treats the orchestration leaf as the concurrency boundary and does not assume a single shared service.

## Deliverables

1. `source/foundry/evaluate.ts` — orchestration `evaluateBranch(dependencies, { branchId, guildPath, suiteDir, config, repetitions })`:
   - For each benchmark in the suite, submit a run `repetitions` times against the branch Guild via the injected run-submission leaf (step 25's `submitRun` + `awaitRunResult`).
   - After each run completes, validate the final workspace (step 24) and collect a `RunRecord` (status, tokens, ask count, context events, errors, wall time, runId).
   - Aggregate into a `BranchScore` (step 24).
   - Write `data/foundry/branches/<branch_id>/results/<benchmark>.json` and a branch-level `results.json`.
   - Receives its dependencies explicitly: the run-submission leaf (step 25), a validation runner, the branch manager (step 23), persistence. No defaults.
2. `source/foundry/evaluate.test.ts` — in-memory test with a fake run-submission leaf returning scripted outcomes and a fake validation runner. Assert: a branch that passes all benchmarks scores 1.0 and writes the expected result files (in a temp `data/` tree, cleaned up); a branch that fails one benchmark records fail + reasons; regression flags propagate; `repetitions` produces N records per benchmark.
3. The run-submission leaf dependency is the step-25 `createRunSubmitter` — this step does not re-implement container orchestration, only the loop that drives it.

## Module boundaries

- `evaluate.ts` is orchestration; all leaves (run submission, validation runner, persistence) are injected.
- No LLM calls in this step (the executor service uses the small model; the Foundry's big model is steps 26–27).
- Concurrency: this step honors `maxConcurrentExecutorRuns` by limiting how many benchmark runs are in flight against the submission leaf at once. For v1 single-container deployment the cap is 1 (sequential); the leaf serializes anyway. If a future multi-container deployment allows parallel benchmark containers, the cap lifts without changing this step's logic.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] `evaluateBranch` produces correct per-benchmark and branch-level result files (verified with fakes).
- [ ] Repetitions are honored (N runs per benchmark).
- [ ] Temp `data/` trees are cleaned up by tests.
- [ ] No direct `runExecutor` or process-spawn calls in `source/foundry/` — evaluation goes through the injected submission leaf only.

## End-of-step evaluation

Confirm `evaluate.ts` does not reach for globals or `Bun.env` and does not import the executor directly. Ensure the run-submission wrapper from step 25 is the only path to a real run. Re-read against `docs/foundry.md` to confirm all recorded fields match the documented `results/<benchmark>.json` shape. Confirm the concurrency cap is expressed as pure logic over the in-flight set, not as a sleep/poll loop.

## Estimated effort

Medium — orchestration with injected fakes; the hard part (container orchestration) is step 25.

## Operator handoff

None — fully in-memory. A real evaluation run is part of the loop in step 29.
