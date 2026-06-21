# Step 23 — Foundry foundation re-verification

## Status: re-opened (was complete as the original step 14; re-opened by the plan realignment)

This step was previously completed as the original step 14 (Foundry foundation: types, config, branch management). A plan realignment moved the Foundry block to run *after* the executor is fully complete (steps 13–22) and re-scoped the Foundry to be an API client of the executor service (steps 25–26) plus a standalone entry point (step 29), rather than spawning executor processes in-process. The existing scaffolding (`source/foundry/{types,config,branches}.ts`) was written against the old in-process model and may no longer be appropriate or correct. This step re-verifies and, where necessary, rewrites that scaffolding against the realigned architecture before subsequent Foundry steps (23–28) build on it.

The prior closeout is preserved verbatim at the end of this file as historical context. It is **not** authoritative for the current state; the re-verification is.

## Goal

Re-verify the existing Foundry data model, configuration, and branch-management leaf against the realigned architecture (service-API executor, per-benchmark containers, standalone Foundry entry point). Where the existing scaffolding fits, keep it; where it does not, rewrite it. After this step, steps 24–29 compose against a correct foundation.

## Context

Read `docs/foundry.md` in full, the realigned `plan/README.md` ("Implementation order"), [`13-long-running-service-mode.md`](13-long-running-service-mode.md) (the service API the Foundry now talks to), and [`25-foundry-evaluation-orchestration.md`](25-foundry-evaluation-orchestration.md) (the per-run container leaf). Key data unchanged: branches under `data/foundry/branches/<branch_id>/`, history under `data/foundry/history/<timestamp>/`, baseline copy under `data/foundry/baseline/`. Read [`00-foundation-completed.md`](00-foundation-completed.md) for the Guild loader/validator the Foundry reuses to validate branch Guilds.

What changed in the realignment that this step must absorb:

- **The Foundry no longer imports `runExecutor` or spawns executor processes.** Evaluation (steps 25–26) submits runs to the executor service over HTTP. Any type or config field that assumed in-process execution must be re-examined.
- **`FoundryConfig.maxConcurrentExecutorRuns` is reinterpreted.** It no longer means "parallel in-process executor calls" (the service is sequential per container); it means pipeline parallelism of the optimize loop, with the per-benchmark container leaf (step 25) as the concurrency boundary. The type may stay, but its documentation and any logic that consumed it must be re-verified.
- **The Foundry is a standalone entry point (step 29), not a `main.ts` subcommand.** Any scaffolding that assumed CLI-subcommand wiring is stale.
- **The big-model caller and human simulator (originally step 17 / now step 27 scope) remain Foundry-internal** and are unchanged in shape, but their config types live in this foundation step and must still match `docs/foundry.md`.

## Deliverables

1. Audit `source/foundry/types.ts` against the realigned architecture. For each type, decide: keep as-is, revise, or remove. Pay particular attention to `FoundryConfig` (the `maxConcurrentExecutorRuns` reinterpretation), `BranchResult`/`RunRecord` (must match what step 25's run-submitter returns, not an in-process `runExecutor` result), and `OptimizationCycleReport` (must reflect API-submitted runs).
2. Audit `source/foundry/config.ts` and its guards. If types changed, the guards and `parseFoundryConfig` change with them. Re-verify every rejection path against `docs/foundry.md`.
3. Audit `source/foundry/branches.ts`. Branch management (copy baseline, apply hypothesis edits, archive, restore) is filesystem-only and likely unchanged, but re-confirm it does not import the executor or assume in-process execution. Confirm the Guild loader/validator reuse still holds.
4. Update `source/foundry/config.test.ts` and `source/foundry/branches.test.ts` to match any revised types/behavior. If a type was removed, remove its tests; if a field's meaning changed, add a test pinning the new meaning.
5. **Significant changes are expected and permitted.** This is not a rubber-stamp re-verification: if the in-process assumptions are baked deeply into the types, rewrite them. The prior closeout's deviations (full-content edit, optional `humanSimulator`, the `evaluation` block, deferred no-op detection, `copyRecursively` export) carry forward only insofar as they still fit the realigned architecture — re-evaluate each.
6. Update `docs/foundry.md` if the realignment changed any documented contract (e.g. the meaning of `maxConcurrentExecutorRuns`). The doc outlives the plan and is the reference for the Foundry contract.

## Module boundaries

- `types.ts`/`config.ts` are pure helpers.
- `branches.ts` is a leaf factory (filesystem) — its logic is thin; the "which files to edit" decision belongs to hypothesis generation (step 27).
- No LLM calls in this step. No HTTP calls in this step (the run-submitter leaf is step 25; this step only defines the types/config the submitter's results must conform to).

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the revised Foundry tests.
- [ ] `parseFoundryConfig` rejects malformed config with a clear error and accepts every valid shape per `docs/foundry.md` (as revised).
- [ ] `createBranchManager` can create, edit, archive, and restore branches in a temp tree without leaking temp files.
- [ ] A branch whose applied edits produce an invalid Guild is rejected with `ValidationError`.
- [ ] No `source/foundry/` file imports the executor (`runExecutor`, `createLlmCaller`, etc.) — the Foundry is a client of the service, not a peer of the executor.
- [ ] The prior closeout's deviations are each re-evaluated; carried-forward ones are noted, superseded ones are struck or removed.

## End-of-step evaluation

Confirm the branch manager still reuses the Guild loader/validator rather than re-implementing validation. Confirm `FoundryConfig` covers every field documented in `docs/foundry.md` (as revised) and that every field's documented meaning matches its consumption in later steps (23–28). Confirm no `as` casts were introduced. Re-read the whole `source/foundry/` tree and confirm nothing assumes in-process executor execution.

## Estimated effort

Medium — the audit is the work; the scaffolding may need substantial revision or may need little. The step is sized for the substantial-revision case.

## Operator handoff

None — fully in-memory. Real Foundry execution is exercised in step 29.

---

## Prior closeout (historical — from the original step 14, NOT authoritative for the current state)

This closeout is preserved as historical context for what the scaffolding originally was. The re-verification above is authoritative for the current state.

Established the Foundry data model, configuration, and branch-management leaf. No optimization loop runs yet; this step only lays the foundation the subsequent steps compose against.

Deliverables delivered (original):

- `source/foundry/types.ts` — the Foundry data model: `FoundryMode`, `BigModelConfig`, `HumanSimulatorConfig`, `FoundryBudgets`, `FoundryEvaluationConfig`, `FoundryConfig`, `HypothesisChange`, `Hypothesis`, `BenchmarkOutcome`, `BenchmarkBranchResult`, `BenchmarkScoreEntry`, `BranchScore`, `BranchResult`, `FoundryTerminationReason`, `OptimizationCycleReport`. Pure types, no behavior.
- `source/foundry/config.ts` — pure boolean guards (`isFoundryMode`, `isBigModelConfig`, `isHumanSimulatorConfig`, `isFoundryBudgets`, `isFoundryEvaluationConfig`, `isFoundryConfig`, `isHypothesisChange`, `isHypothesis`) and `parseFoundryConfig(unknown): FoundryConfig` that throws path-based `ValidationError`s. Mirrors the Guild validation pattern in `source/shared/validation.ts` exactly.
- `source/foundry/config.test.ts` — 29 in-memory tests covering the guards and every `parseFoundryConfig` rejection path.
- `source/foundry/branches.ts` — `createBranchManager(baseDir)` leaf factory returning `copyBaselineIntoBranch`, `applyHypothesisToBranch`, `archiveBaselineIntoHistory`, `restoreHistoricalBaseline`. Reuses `createGuildLoader()` to validate resulting branch Guilds end-to-end rather than re-implementing validation.
- `source/foundry/branches.test.ts` — 14 in-memory tests over a temp guild tree under `os.tmpdir()` (cleaned up in `afterEach`): copy/apply/archive/restore, malformed-JSON-edit → clear `ValidationError`, invalid-resulting-Guild → `ValidationError`, path-escape confinement, branch isolation, and missing-baseline / missing-branch / missing-history preconditions.

Verification (original, in-environment):

- `bun run typecheck` clean; `bun test source/` → 269 pass / 0 fail (48 new), full suite ~590ms.
- No temp directories leaked (`/tmp/orchestrator-foundry-*` count is 0 after the run).

Original deviations from the plan wording (carry forward only if they still fit the realigned architecture — re-evaluate each):

1. **Hypothesis `edit` is a full-content replacement, not a diff.** A full-replacement edit needs no patch engine and therefore no dependency (AGENTS.md "No dependencies"), and keeps branch application auditable (write-then-validate). `HypothesisChange.edit` is the complete new file content. Hypothesis generation (step 27) must instruct the large model to produce full-file contents, and the change `path` is relative to the Guild directory.
2. **`humanSimulator` is optional in `FoundryConfig`.** `docs/foundry.md` says the simulator is used "when `ask_human` is included in the Guild"; a Foundry run against a Guild without `ask_human` has no need for it. `humanQuestionPenalty` remains required (it is always part of the scoring formula).
3. **An `evaluation` block carries the statistical knobs.** The improvement margin and per-benchmark repetitions are documented config knobs, so they live in `FoundryConfig.evaluation` (`repetitionsPerBenchmark`, `improvementMargin`) for scoring (step 24) to consume.
4. **No-op detection is deferred.** `docs/foundry.md` lists no-op detection under guardrails, but it is a behavior with no documented config knob. `FoundryTerminationReason` is therefore `'cycle_budget' | 'cost_budget' | 'plateau'`. No-op filtering lands in step 27 (hypothesis generation) / step 29 (the loop); this is planned scope, not debt.
5. **`copyRecursively` is exported from `source/executor/persistence.ts`.** The branch manager needs a recursive directory copy; exporting the existing private helper removes what would otherwise be a duplicated 12-line recursive copy. (Re-verify the Foundry no longer imports from `source/executor/` at all under the realigned "Foundry is a client, not a peer" rule — if so, this export's Foundry justification disappears and the helper may need to move to a neutral module or be duplicated.)
