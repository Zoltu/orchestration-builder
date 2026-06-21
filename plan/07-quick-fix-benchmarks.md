# Step 07 — Quick-fix benchmarks

## Goal

Author the first batch of quick-fix benchmarks (5–30 minute expected tasks) and validate them against the seed Guild with a real LLM. These are small, self-contained tasks that exercise read/write/run_shell without long-horizon planning.

## Context

Read [`06-benchmark-harness.md`](06-benchmark-harness.md) (the harness is now in place) and `docs/benchmarks.md`. Each benchmark is `benchmarks/<name>/{eval.json, README.md, src|tests|...}`. `eval.json` is **not** copied into the run workspace. Keep tasks genuinely small so the seed Guild can pass them with light prompt iteration.

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

Run the suite against a real OpenAI-compatible endpoint: `bun source/benchmarks/run-suite.ts --suite benchmarks --guild guild --output data/suite-runs/<timestamp>/summary.json` (exact flags per the harness CLI built in step 06). Report back which benchmarks passed/failed and any prompt edits needed; the agent should then iterate prompts in-environment and re-hand off until at least three quick-fix benchmarks pass.

> **Blocking dependency (read before running):** the real-LLM run cannot pass any of these benchmarks until step `01-write-file-tool` lands. The seed Guild's `coder` role has no file-write tool, so today it can only *report* intended file contents in its `finish` summary; the workspace is never actually modified, so every validation that inspects the final workspace fails. Steps `01`–`05` are still pending. Re-run this handoff once `write_file` (step 01) and the `test` tool (step 05) are complete and the CLI entry point (step 02) wires the real `runBenchmark` leaf into `runSuite`. (`run_shell`, step 17, is no longer a blocker for quick-fix benchmarks — the dedicated `test` tool covers test-running without opening the arbitrary-shell surface.) No prompt iteration was performed in this step because it cannot be verified in-environment without a real LLM and a working write capability; defer prompt edits to that handoff.

## Closeout (step 06 — in-environment deliverables complete)

Authored four quick-fix benchmarks under `benchmarks/`, each self-contained, fast, and free of external installs:

- `fix_missing_import` — `src/index.js` re-exports from a misspelled filename; fix the import so `bun test tests/` reports `1 pass`.
- `add_input_validation` — `src/math.js` `divide()` returns `Infinity` for zero; add a guard so it throws, `2 pass`.
- `update_readme_typo` — one spelling typo (`Ths` → `The`) in `README.md`; validated by a `grep` file-content check (portable, no test runner).
- `add_small_test` — create `tests/string-utils.test.js` covering three cases for the untested `capitalize`; `3 pass`.

Each benchmark has a non-developer-friendly `README.md`, a valid `eval.json` (`taskType: "quick_fix"`, `description`, and a `validation` block with `command` / `expectedExitCode` / `expectedStdoutContains` or `expectedFiles` / `timeoutSeconds`), and the initial workspace files. Every benchmark's initial state was verified to fail its validation and its fixed state was verified to pass (in `/tmp` scratch runs, cleaned up).

Added `source/benchmarks/suite.test.ts` — a data-validity guard that discovers every benchmark directory under `benchmarks/`, parses each `eval.json` with `parseEvalConfig`, asserts it is valid, and asserts each benchmark's `README.md` (the task description copied into the run workspace) exists and is non-empty. This mirrors the repo-fixture-reading style of `source/executor/seed-guild.test.ts` and `source/executor/tool-manifests.test.ts`; it runs under `bun test source/` and touches no network.

Deviations from the plan wording (authoritative):

1. **Benchmark workspace files are JavaScript (`.js`), not TypeScript.** The repo `tsconfig.json` includes `benchmarks/**/*.ts`, so deliberately-broken fixtures (a misspelled import in `fix_missing_import`, a missing guard in `add_input_validation`) authored as `.ts` would break `bun run typecheck` at the repo level. Authoring the fixtures as `.js` keeps them out of `tsc --noEmit` (they are not in the `include` glob and `allowJs` is off) while remaining fully runnable by `bun test tests/` and editable by the agent. The only `.ts` file under `benchmarks/` remains the pre-existing `hello_001/tests/test_output.test.ts`, which typechecks cleanly.
2. **`update_readme_typo` carries the precise instruction in `eval.json.description`, not in `README.md`.** Putting the exact corrected sentence in `README.md` would reproduce the typo'd phrase (`Ths service`) inside the instruction text and false-trigger the `! grep -q 'Ths service' README.md` half of the validation. The `README.md` instead gives plain-language context ("one spelling mistake that needs fixing") plus the typo'd line; the precise fix travels in the task text (`eval.json.description`), which is the default user message to the entry role. No `eval.json` validation expectation is leaked into any `README.md`.
3. **No prompt edits were made and the operator-verified "≥3 pass" criterion is deferred.** Per the blocking-dependency note above, real-LLM runs are blocked on step `01` (`write_file`). Prompt iteration is therefore unverifiable in-environment and is left to the operator handoff once `write_file` lands. This is a sequencing dependency on a pending step, not code debt, so it is not tracked in the plan's debt table.

Health: `bun run typecheck` clean; `bun test source/` → 211 pass / 0 fail (11 new from `suite.test.ts`: 1 suite-count test plus 2 per benchmark across 5 benchmarks), full suite ~515ms.

## Correction (applied during step 08 — authoritative, supersedes deviation #1 above)

Deviation #1 above authored the quick-fix fixtures as `.js` to keep "deliberately-broken fixtures" out of `bun run typecheck`. That reasoning was too broad: it conflated *behavioral* bugs (which typecheck fine — the bug is a runtime test failure) with *structural* bugs (a misspelled import that cannot resolve, which genuinely breaks typecheck). Throwing away typechecking for every fixture also threw away the compiler's ability to catch authoring mistakes in the fixtures *and their tests*, which is the whole point of typechecking.

During step 08, the two quick-fix benchmarks whose bugs are behavioral were converted to `.ts` so they are now typechecked:

- `add_input_validation` — `src/math.ts` (`divide(a: number, b: number): number` returns `a / b`, the bug is it does not throw on zero) and `tests/math.test.ts`. The initial state typechecks cleanly; the bug is purely behavioral (`divide(1, 0)` returns `Infinity` instead of throwing). `README.md`/`eval.json` paths updated to `.ts`.
- `add_small_test` — `src/string-utils.ts` (`capitalize`), with `tests/string-utils.test.ts` created by the agent. The initial state typechecks cleanly (no test file yet, source correct). `README.md`/`eval.json` paths (including `expectedFiles`) updated to `.ts`.

`fix_missing_import` is the one quick-fix benchmark that **stays `.js`**: its task *is* a broken import path (`export { add } from './calcultor.js'`), a structural/type error by nature — there is no way to author a misspelled module specifier that resolves, so its initial state cannot typecheck. This is a narrow, documented exception, not the blanket rule. `update_readme_typo` has no code files (only `README.md`), so nothing to convert. `hello_001`'s `tests/test_output.test.ts` was already `.ts`.

After this correction, `bun run typecheck` remains clean (the newly-`.ts` fixtures typecheck) and `bun test source/` stays green; each converted benchmark was re-verified in `/tmp` scratch to still fail in its initial state and pass in its fixed state.
