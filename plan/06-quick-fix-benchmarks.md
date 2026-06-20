# Step 06 — Quick-fix benchmarks

## Goal

Author the first batch of quick-fix benchmarks (5–30 minute expected tasks) and validate them against the seed Guild with a real LLM. These are small, self-contained tasks that exercise read/write/run_shell without long-horizon planning.

## Context

Read [`05-benchmark-harness.md`](05-benchmark-harness.md) (the harness is now in place) and `docs/benchmarks.md`. Each benchmark is `benchmarks/<name>/{eval.json, README.md, src|tests|...}`. `eval.json` is **not** copied into the run workspace. Keep tasks genuinely small so the seed Guild can pass them with light prompt iteration.

## Deliverables

1. At least four quick-fix benchmarks under `benchmarks/`, e.g.:
   - `fix_missing_import` — a tiny project with a broken import; fix it so tests pass.
   - `add_input_validation` — add a guard to an existing function so a test passes.
   - `update_readme_typo` — fix a deliberate error in a README and assert the corrected text.
   - `add_small_test` — add a test file for an existing untested function.
   Pick tasks whose validation command is portable and fast (e.g. `bun test` or a node/bun script, or a plain file-content check via `diff`/`grep`). Avoid benchmarks that need `npm install`/`pip install` (the isolation caveat from `docs/architecture.md`).
2. Each benchmark has: `README.md` (non-developer task description), `eval.json` (`taskType`, `description`, `validation` with `command`/`expectedExitCode`/`expectedFiles`/`expectedStdoutContains`/`timeoutSeconds`), and the initial workspace files.
3. `source/benchmarks/suite.test.ts` (or extend the harness test) — an in-memory test that loads every benchmark's `eval.json` with `parseEvalConfig` and asserts each is valid and each referenced initial file exists. This guards the suite data without running the executor.
4. If prompt iteration on the seed Guild is needed to pass these, make the smallest prompt edits that fix the failure and record them in the step closeout. Do not over-fit prompts to specific benchmarks.

## Module boundaries

- Benchmarks are data. No executor code changes expected.
- Any prompt edits touch only `guild/prompts/*.md`; record them in the closeout.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass (including the suite-validity test).
- [ ] At least four benchmarks exist, each with valid `eval.json` and existing initial files.
- [ ] Each benchmark `README.md` is understandable by a non-developer.
- [ ] At least three of the quick-fix benchmarks pass against the seed Guild in a real run (operator-verified — see handoff).

## End-of-step evaluation

Re-read each benchmark's task text as a non-developer would. Confirm no benchmark leaks its `eval.json` expectations into the `README.md` (that would let the model optimize for the test). If prompt edits were made, ensure they generalize (re-run a previously-passing benchmark to check for regressions).

## Estimated effort

Medium — authoring good benchmarks and prompt iteration take time.

## Operator handoff

Run the suite against a real OpenAI-compatible endpoint: `bun source/benchmarks/run-suite.ts --suite benchmarks --guild guild --output data/suite-runs/<timestamp>/summary.json` (exact flags per the harness CLI built in step 05). Report back which benchmarks passed/failed and any prompt edits needed; the agent should then iterate prompts in-environment and re-hand off until at least three quick-fix benchmarks pass.
