# Step 09 — Foundry foundation: types, config, branch management

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
- `branches.ts` is a leaf factory (filesystem) — its logic is thin; the "which files to edit" decision belongs to hypothesis generation (step 12).
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
