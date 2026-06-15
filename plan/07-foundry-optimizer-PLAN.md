# Phase 7 — Foundry Meta-Optimizer

## Goal

Build the offline optimization loop that improves the Guild by proposing hypotheses, running experiments against the benchmark suite, scoring branches, and merging validated improvements.

## Deliverables

1. `src/foundry/index.ts` — public Foundry API.

2. `src/foundry/git.ts` — branch management:
   - Copy baseline Guild into `data/foundry/branches/<branch_id>/`.
   - Apply hypothesis changes (file edits) to create a branch.
   - Archive promoted baselines into `data/foundry/history/<timestamp>/`.

3. `src/foundry/hypothesize.ts` — hypothesis generation:
   - Prompt a large model with recent run logs and the baseline Guild.
   - Parse hypotheses with motivation, mechanism, predicted impact, and file changes.
   - Validate each hypothesis produces a loadable Guild.

4. `src/foundry/evaluate.ts` — branch evaluation:
   - For each branch, run every benchmark through the executor.
   - Respect `maxConcurrentExecutorRuns`.
   - Record per-benchmark results under `data/foundry/branches/<branch_id>/results/<benchmark>.json`.

5. `src/foundry/validate.ts` — result validation:
   - Run each benchmark’s `eval.json` validation command in the final workspace.
   - Check expected files and stdout contents.
   - Return `pass`, `fail`, or `error`.

6. `src/foundry/score.ts` — scoring:
   - Compute pass rate, error rate, average tokens, context pressure, ask frequency.
   - Apply `humanQuestionPenalty` if `ask_human` was used.
   - Repeat each benchmark N times to account for stochasticity.

7. `src/foundry/merge.ts` — merge conflicting branches:
   - Detect branches that edit the same files as accepted branches.
   - Prompt the large model with diffs and results to produce a merged version.
   - Re-evaluate the merged candidate against the full suite.

8. `src/foundry/report.ts` — human-readable reports:
   - Write `data/foundry/reports/<timestamp>/summary.json`.
   - Write `data/foundry/reports/<timestamp>/index.html`.
   - Include diffs, scores, accepted/rejected/merged status.

9. `src/foundry/main.ts` — CLI entry point:
   - `bun src/main.ts foundry optimize --suite benchmarks/ --cycles 5`.
   - Honor cost, cycle, and plateau budgets.

## Module boundaries

- The Foundry never runs inside the executor process.
- The Foundry invokes the executor via its CLI, treating it as a black box.
- The large model used by the Foundry is configured separately from the executor’s small model.
- `ask_human` during Foundry runs is answered by the large model simulating a persona, not a real human.

## Safeguards

- Maximum optimization cycles.
- Maximum wall-clock time or big-model token budget.
- Plateau detection: terminate if no improvement for N cycles.
- Only promote a new baseline after full-suite regression testing.

## Acceptance criteria

- [ ] The Foundry can propose at least one hypothesis from a set of failing run logs.
- [ ] A branch can be created, evaluated, and scored automatically.
- [ ] A branch that clearly improves pass rate is accepted and promoted.
- [ ] Reports are generated and contain all required sections.

## Estimated effort

Large — this is the most complex component and depends on stable executor and benchmark suite.
