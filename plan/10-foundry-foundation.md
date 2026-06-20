# Step 10 — Foundry foundation: types, config, branch management

## Goal

Establish the Foundry's data model, configuration, and branch-management leaf. This is the first Foundry step; subsequent steps add validation/scoring, evaluation, hypothesis generation, merging/reporting, and the CLI loop. No optimization loop runs yet.

## Context

Read `docs/foundry.md` in full. The Foundry is an offline process using a **large** model to improve the Guild. It never runs inside the executor; it invokes the executor as a black box. Key data: branches under `data/foundry/branches/<branch_id>/`, history under `data/foundry/history/<timestamp>/`, baseline copy under `data/foundry/baseline/`. Read [`00-foundation-completed.md`](00-foundation-completed.md) for the Guild loader/validator the Foundry will reuse to validate branch Guilds.

## Deliverables

1. `source/foundry/types.ts` — Foundry types: `FoundryConfig` (mode, `maxConcurrentExecutorRuns`, `maxConcurrentBigRequests`, `bigModel`, `humanSimulator`, `humanQuestionPenalty`, cycle/cost/plateau budgets), `Hypothesis` (id, motivation, mechanism, predictedImpact, changes), `BranchResult`, `BranchScore`, `OptimizationCycleReport`.
2. `source/foundry/config.ts` — pure `parseFoundryConfig(unknown): FoundryConfig` with a type guard; reject malformed config with `ValidationError`. Mirrors the Guild validation pattern.
3. `source/foundry/config.test.ts` — in-memory tests for the guard.
4. `source/foundry/branches.ts` — leaf factory `createBranchManager(baseDir)` returning functions for: copying the baseline Guild into a branch dir, applying a hypothesis's file edits to produce a branch Guild, archiving a promoted baseline into history, and restoring a historical baseline. All filesystem ops use `existsSync`-before-read patterns; no exceptions-for-control-flow.
5. `source/foundry/branches.test.ts` — in-memory tests using a temp `os.tmpdir()` guild tree (cleaned up). Cover: creates a branch with applied edits; archives a baseline; a malformed edit (e.g. invalid JSON result) is surfaced as a clear error, not a crash; restoring history overwrites the baseline correctly.
6. Branch Guild validation: after applying edits, validate the resulting `guild.json` with the existing `createGuildLoader()` (throw `ValidationError` on failure — this is a genuine failure to produce a usable branch, not an expected control-flow path).

## Module boundaries

- `types.ts`/`config.ts` are pure helpers.
- `branches.ts` is a leaf factory (filesystem) — its logic is thin; the "which files to edit" decision belongs to hypothesis generation (step 13).
- No LLM calls in this step.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the new Foundry tests.
- [ ] `parseFoundryConfig` rejects malformed config with a clear error.
- [ ] `createBranchManager` can create, edit, archive, and restore branches in a temp tree without leaking temp files.
- [ ] A branch whose applied edits produce an invalid Guild is rejected with `ValidationError`.

## End-of-step evaluation

Confirm the branch manager reuses the Guild loader/validator rather than re-implementing validation. Ensure `FoundryConfig` covers every field documented in `docs/foundry.md`. Confirm no `as` casts were introduced.

## Estimated effort

Medium — data model + filesystem leaf.

## Operator handoff

None — fully in-memory.

## Closeout (step 10 — complete)

Established the Foundry data model, configuration, and branch-management leaf. No optimization loop runs yet; this step only lays the foundation steps 11–15 compose against.

Deliverables delivered:

- `source/foundry/types.ts` — the Foundry data model: `FoundryMode`, `BigModelConfig`, `HumanSimulatorConfig`, `FoundryBudgets`, `FoundryEvaluationConfig`, `FoundryConfig`, `HypothesisChange`, `Hypothesis`, `BenchmarkOutcome`, `BenchmarkBranchResult`, `BenchmarkScoreEntry`, `BranchScore`, `BranchResult`, `FoundryTerminationReason`, `OptimizationCycleReport`. Pure types, no behavior.
- `source/foundry/config.ts` — pure boolean guards (`isFoundryMode`, `isBigModelConfig`, `isHumanSimulatorConfig`, `isFoundryBudgets`, `isFoundryEvaluationConfig`, `isFoundryConfig`, `isHypothesisChange`, `isHypothesis`) and `parseFoundryConfig(unknown): FoundryConfig` that throws path-based `ValidationError`s. Mirrors the Guild validation pattern in `source/shared/validation.ts` exactly.
- `source/foundry/config.test.ts` — 29 in-memory tests covering the guards and every `parseFoundryConfig` rejection path.
- `source/foundry/branches.ts` — `createBranchManager(baseDir)` leaf factory returning `copyBaselineIntoBranch`, `applyHypothesisToBranch`, `archiveBaselineIntoHistory`, `restoreHistoricalBaseline`. Reuses `createGuildLoader()` to validate resulting branch Guilds end-to-end rather than re-implementing validation.
- `source/foundry/branches.test.ts` — 14 in-memory tests over a temp guild tree under `os.tmpdir()` (cleaned up in `afterEach`): copy/apply/archive/restore, malformed-JSON-edit → clear `ValidationError`, invalid-resulting-Guild → `ValidationError`, path-escape confinement, branch isolation, and missing-baseline / missing-branch / missing-history preconditions.

Verification (in-environment):

- `bun run typecheck` clean; `bun test source/` → 269 pass / 0 fail (48 new), full suite ~590ms.
- No temp directories leaked (`/tmp/orchestrator-foundry-*` count is 0 after the run).

End-of-step evaluation:

- The branch manager reuses the Guild loader/validator (`createGuildLoader`) for branch validation; it does not re-implement Guild validation.
- `FoundryConfig` covers every config field documented in `docs/foundry.md`: `mode`, `maxConcurrentExecutorRuns`, `maxConcurrentBigRequests`, `bigModel`, `humanSimulator` (optional), `humanQuestionPenalty`, the cycle/cost/plateau budgets, and the statistical knobs (`repetitionsPerBenchmark`, `improvementMargin`). See deviation 4 below for the one documented guardrail that is intentionally a behavior, not a config field.
- No `as` typecasts were introduced (the three `as` occurrences in the new files are the English word inside comments).

Deviations from the plan wording (authoritative):

1. **Hypothesis `edit` is a full-content replacement, not a diff.** The plan did not specify the edit format; `docs/foundry.md` only shows `"edit": "..."`. A full-replacement edit needs no patch engine and therefore no dependency (AGENTS.md "No dependencies"), and keeps branch application auditable (write-then-validate). `HypothesisChange.edit` is the complete new file content. Step 13 (hypothesis generation) must instruct the large model to produce full-file contents, and the change `path` is relative to the Guild directory (matching guild.json's own path convention).
2. **`humanSimulator` is optional in `FoundryConfig`.** `docs/foundry.md` says the simulator is used "when `ask_human` is included in the Guild"; a Foundry run against a Guild without `ask_human` has no need for it. `humanQuestionPenalty` remains required (it is always part of the scoring formula).
3. **An `evaluation` block carries the statistical knobs.** The plan's deliverable 1 enumerated the named FoundryConfig fields plus "cycle/cost/plateau budgets" but did not list the margin/repetitions explicitly. The end-of-step evaluation requires covering every field in `docs/foundry.md`, and the improvement margin and per-benchmark repetitions are documented config knobs, so they live in `FoundryConfig.evaluation` (`repetitionsPerBenchmark`, `improvementMargin`) for step 11's scoring to consume.
4. **No-op detection is deferred.** `docs/foundry.md` lists no-op detection under guardrails, but it is a behavior ("hypotheses that only shuffle wording without changing scores are discarded") with no documented config knob, and the plan scopes the Foundry budgets to "cycle/cost/plateau". `FoundryTerminationReason` is therefore `'cycle_budget' | 'cost_budget' | 'plateau'`. No-op filtering lands in step 13 (hypothesis generation) / step 15 (the loop); this is planned scope, not debt, so it is not tracked in the plan's debt table.
5. **`copyRecursively` is now exported from `source/executor/persistence.ts`.** The branch manager needs a recursive directory copy; Phase 1's `persistence.ts` already had one as a private helper. Exporting it (additive, no behavior change to the persistence factories) removes what would otherwise be a duplicated 12-line recursive copy. This is the only change to a foundation file in this step.

Health: `bun run typecheck` clean; `bun test source/` → 269 pass / 0 fail (48 new), full suite ~590ms.
