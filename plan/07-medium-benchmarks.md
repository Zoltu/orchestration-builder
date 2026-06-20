# Step 07 — Medium benchmarks

## Goal

Author 2–3 medium benchmarks (1–3 hour expected tasks) that require decomposition, multiple files, and running tests/builds to iterate. These stress the planner→coder→critic workflow and the `run_shell` loop.

## Context

Read [`06-quick-fix-benchmarks.md`](06-quick-fix-benchmarks.md) (quick-fix suite is green) and `docs/benchmarks.md`. Medium tasks should require the orchestrator to delegate more than once and the coder to run tests with `run_shell` and react to failures. Keep within the no-installs isolation constraint: use Bun/node stdlib or vendored files only.

## Deliverables

1. Two or three medium benchmarks, e.g.:
   - `feature_add_endpoint` — add a small HTTP route to an existing Bun-served app, with a test that hits it.
   - `refactor_extract_module` — split a single-file module into several modules with re-exports, keeping tests green.
   - `add_cli_flag` — extend a small CLI tool with a new flag and a test for it.
   Prefer tasks whose validation is `bun test` on a workspace that needs no install step.
2. Each benchmark has the full data layout (`README.md`, `eval.json`, initial files).
3. Extend the suite-validity test from step 06 to cover the new benchmarks.
4. Prompt iteration on the seed Guild as needed (smallest edits; record in closeout).

## Module boundaries

- Data only, plus possible `guild/prompts/*.md` edits.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] At least two medium benchmarks exist, valid, with non-developer `README.md`.
- [ ] At least two medium benchmarks pass **or** produce meaningful partial progress (e.g. tests partially passing, correct files created) in a real run (operator-verified).
- [ ] No benchmark requires an external package install to validate.

## End-of-step evaluation

Check that medium tasks genuinely need delegation (if a single `coder` call solves one, it is mis-sized — move it to quick-fix or enlarge it). Ensure prompt edits did not over-fit. Re-run one quick-fix benchmark to confirm no regression.

## Estimated effort

Medium to large — medium benchmarks are harder to author and the seed Guild will need iteration.

## Operator handoff

Run the suite (or the medium subset) against a real endpoint and report pass/fail/partial per benchmark plus any failing-test output. The agent iterates prompts in-environment and re-hands off until the acceptance bar is met.
