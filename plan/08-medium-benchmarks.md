# Step 08 — Medium benchmarks

## Goal

Author 2–3 medium benchmarks (1–3 hour expected tasks) that require decomposition, multiple files, and running tests/builds to iterate. These stress the planner→coder→critic workflow and the `test`-tool iteration loop.

## Context

Read [`07-quick-fix-benchmarks.md`](07-quick-fix-benchmarks.md) (quick-fix suite is green) and `docs/benchmarks.md`. Medium tasks should require the orchestrator to delegate more than once and the coder to run tests with the `test` tool and react to failures. Keep within the no-installs isolation constraint: use Bun/node stdlib or vendored files only.

## Deliverables

1. Two or three medium benchmarks, e.g.:
   - `feature_add_endpoint` — add a small HTTP route to an existing Bun-served app, with a test that hits it.
   - `refactor_extract_module` — split a single-file module into several modules with re-exports, keeping tests green.
   - `add_cli_flag` — extend a small CLI tool with a new flag and a test for it.
   Prefer tasks whose validation is `bun test` on a workspace that needs no install step.
2. Each benchmark has the full data layout (`README.md`, `eval.json`, initial files).
3. Extend the suite-validity test from step 07 to cover the new benchmarks.
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

> **Blocking dependency (read before running):** like step 07, the real-LLM run cannot pass any of these benchmarks until step `01-write-file-tool` (and ideally step `05-test-tool`) lands and the CLI entry point (step 02) wires the real `runBenchmark` leaf into `runSuite`. Medium tasks in particular need the `test` tool so the coder can run `bun test tests/`, read the failure output, and iterate. (`run_shell`, step 29, is deferred and is not a blocker for these no-install benchmarks — the dedicated `test` tool covers test-running.) No prompt iteration was performed in this step because it cannot be verified in-environment without a real LLM and working write/test capabilities; defer prompt edits to that handoff.

## Closeout (step 08 — in-environment deliverables complete)

Authored three medium benchmarks under `benchmarks/`, each self-contained, multi-file, validated by `bun test tests/` with no external installs:

- `refactor_extract_module` — split the single-file `src/string-utils.ts` (four functions) into one module per function (`capitalize.ts`, `reverse.ts`, `vowel-count.ts`, `kebab-case.ts`) and re-export from the original so the existing `tests/string-utils.test.ts` keeps passing. Validation enforces the structural split via `expectedFiles` plus a self-enforcing re-export: an empty new module breaks the named `export { ... } from './x.js'` at import time, so the tests fail unless the function bodies actually move. Initial state: tests already pass (4 pass) but the four new module files are absent → validation fails on missing files; fixed state: 4 pass + all four files present → pass.
- `feature_add_endpoint` — add a `GET /greeting?name=...` route returning `{ "greeting": "Hello, <name>" }` with a `"world"` default for missing/empty names, to a small request-handling app (`src/server.ts`) that already serves `/health`. The route handler must live in a new `src/routes/greeting.ts` wired into the router. `tests/greeting.test.ts` (three cases) ships failing; `tests/health.test.ts` (two cases) ships passing. Initial: 2 pass / 3 fail + missing file → fail; fixed: 5 pass + file present → pass.
- `add_cli_flag` — add a `--reverse` flag to a small task-printer CLI, requiring coordinated edits to two modules: `src/args.ts` (`parseArgs` must set `options.reverse`) and `src/printer.ts` (`formatLines` must reverse when `options.reverse` is true). `tests/args.test.ts` and `tests/printer.test.ts` ship three failing cases among five passing ones. Initial: 5 pass / 3 fail → fail; fixed: 8 pass → pass.

Each benchmark has a non-developer-friendly `README.md`, a valid `eval.json` (`taskType: "medium"`, `description`, and a `validation` block), and the initial workspace files. The `README.md` files give plain-language task context plus the target file names (the task itself, not the validation secret); no `eval.json` expectation (exit code, pass-count substring) is leaked into any `README.md`. Every benchmark's initial state was verified to fail its validation and its fixed state was verified to pass (in `/tmp` scratch runs, cleaned up afterward).

Extended `source/benchmarks/suite.test.ts` with a medium-benchmark guard: it reads every benchmark's `eval.json`, counts those with `taskType === "medium"`, asserts at least two exist, and asserts the three step-08 names (`add_cli_flag`, `feature_add_endpoint`, `refactor_extract_module`) are present. The existing generic per-benchmark checks (valid `eval.json` + non-empty `README.md`) already cover the new directories, so the suite data stays guarded without running the executor.

Sizing check (end-of-step evaluation): each medium task genuinely requires decomposition and a `test`-tool iteration loop rather than a single edit — `refactor_extract_module` touches five files (four new + one rewrite), `feature_add_endpoint` adds a new module plus router wiring and query/default logic across three failing test cases, and `add_cli_flag` requires two coordinated module edits (parse + format) to turn three failing tests green. No prompt edits were made (unverifiable in-environment; see blocking dependency), so there is no over-fitting risk. Re-verified one quick-fix benchmark (`fix_missing_import`: initial fails, fixed reports `1 pass`) to confirm no regression, and re-ran the suite-validity test over all benchmarks.

Deviations from the plan wording (authoritative):

1. **Benchmark workspace files are TypeScript (`.ts`) and are typechecked.** This corrects the opposite decision recorded in step 07's deviation #1, which authored fixtures as `.js` to keep "deliberately-incomplete fixtures" out of `bun run typecheck`. That reasoning conflated two cases: *behavioral* bugs (wrong return value, missing route logic, an ignored flag) typecheck fine — the bug is a runtime test failure, not a type error — while only *structural* bugs (a misspelled import path that cannot resolve) genuinely break typecheck. Authoring the behavioral-bug fixtures as `.ts` brings them under the repo `tsconfig.json` `include` glob (`benchmarks/**/*.ts`) so the fixtures *and their tests* are typechecked, letting the compiler catch authoring mistakes (it already caught one: `formatLines`'s intentionally-ignored `options` parameter trips `noUnusedParameters`, resolved with the TS-sanctioned `_options` underscore prefix that signals "accepted but not yet honored" — which is precisely the bug). The committed *initial* state of every step-08 benchmark typechecks cleanly; the agent's *fixed* state lands in `data/runs/<run_id>/workspace/` and is not repo-typechecked (it is validated only by `bun test tests/`). The one benchmark that cannot follow this rule is step 07's `fix_missing_import`, whose task *is* a broken import path — a structural/type error by nature; it stays `.js` as a documented narrow exception (see step 07's correction note). `update_readme_typo` and `hello_001` have no convertible code or are already `.ts`.
2. **`feature_add_endpoint` models the "Bun-served app" as an in-process `handleRequest(request)` function, not a live `Bun.serve` socket.** Tests construct synthetic `Request` objects and assert on the returned `Response`, so validation runs in milliseconds with no port binding and no special permissions. This stays within the no-installs/no-network isolation constraint from `docs/architecture.md` while faithfully exercising routing, query-parameter parsing, and the default-name branch. The plan's "test that hits it" is satisfied by requests flowing through the real router/handler, not a TCP socket. (`Request`/`Response`/`URL` types are available via `@types/bun`, already used by `source/executor/tools/fetch-url.ts` and `source/executor/llm.ts`.)
3. **`add_cli_flag` validates through pure-function tests, not a CLI subprocess.** `tests/args.test.ts` and `tests/printer.test.ts` call `parseArgs` and `formatLines` directly; `src/cli.ts` wires the two together for real use but is not loaded by the validation tests. This keeps the validation fast, deterministic, and free of process-spawning flakiness while still requiring the two coordinated module edits that make the task medium-sized. `parseArgs` iterates with `argv.entries()` so the loop variable is typed `string` (not `string | undefined` from bracket access under `noUncheckedIndexedAccess`); the only bracket access, `argv[index + 1]` for the `--count` value, is intentionally `string | undefined` and passed straight to `Number(...)`, matching the original `NaN`-on-missing-value behavior.
4. **`refactor_extract_module` is validated structurally.** Its tests already pass in the initial state (the single file is correct); the validation gap is the absence of the four split modules, enforced by `expectedFiles`. The re-export mechanism makes the structure self-enforcing (empty modules break the named `export { ... } from './x.js'` at import time), so the task cannot be gamed by creating empty files. This is a faithful "refactor: keep behavior, change structure" framing.
5. **No prompt edits and the operator-verified "≥2 pass or partial" criterion is deferred.** Per the blocking-dependency note above, real-LLM runs are blocked on step `01` (`write_file`) and step `05` (`test`). Prompt iteration is unverifiable in-environment and is left to the operator handoff once those steps land. This is a sequencing dependency on pending steps, not code debt, so it is not tracked in the plan's debt table.

Health: `bun run typecheck` clean (the benchmark fixtures now typecheck for the first time); `bun test source/` → 218 pass / 0 fail (7 new from `suite.test.ts`: 1 medium-count test plus 2 per benchmark across the 3 new benchmarks), full suite ~477ms.
