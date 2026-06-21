# Step 09 — Large benchmark

## Goal

Author one large benchmark (half-day to multi-day expected) that runs to completion without hitting executor safety budgets. This is the first benchmark whose validation exercises the **full toolchain** — typecheck *and* test — so the agent is rewarded for satisfying the compiler as well as the test suite, the natural shape of real TypeScript work. (The isolation problem flagged in `docs/architecture.md` is now addressed by its own step, step 16; this step no longer carries the isolation revisit.)

## Context

Read [`08-medium-benchmarks.md`](08-medium-benchmarks.md) and `docs/architecture.md`. A large task should require multi-step decomposition, cross-file work, and iterative test/build cycles. The seed Guild's budgets already allow multi-hour runs (`maxRunTimeSeconds: 14400`). With the `typecheck` (step 04) and `test` (step 05) tools now available to the `coder` role, the agent can run the full toolchain to verify its work; this benchmark's validation rewards that by requiring both to pass.

## Deliverables

1. One large benchmark, e.g. `project_todo_cli` — build a small command-line todo app from scratch with tests, or `project_static_site` — a small static-site generator. The task must be completable with Bun stdlib only (no installs — isolation is step 16, still pending at this point in the plan), with **full-toolchain validation**: `bun run typecheck && bun test tests/` as the validation command (exit code 0 only when both the typechecker and the test suite are green). Author the benchmark's own `tsconfig.json` so `bun run typecheck` is meaningful against the benchmark workspace.
2. Full data layout; extend the suite-validity test.
3. Prompt iteration as needed (record in closeout). Pay attention to context pressure on long runs — if the run hits `context_budget_exceeded` frequently, the `context_manager` role or `edit_context` usage may need prompt guidance. Confirm the `coder` prompt's combined typecheck/test guidance (from steps 04/05) drives the agent to use both checkers on a long task.

## Module boundaries

- Data only, plus possible `guild/prompts/*.md` edits.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] One large benchmark exists, valid, with a non-developer `README.md`.
- [ ] The large benchmark's validation is `bun run typecheck && bun test tests/` (full toolchain).
- [ ] The large benchmark runs to completion (not cut off by safety budgets) in a real run (operator-verified). Passing is not required for this step — completion without budget exhaustion is the bar.

## End-of-step evaluation

If the large run hit budgets, decide whether to raise budgets (carefully — they are safety limits) or improve prompts. Prefer prompt/context-management fixes over budget raises. Confirm the suite as a whole (quick + medium + large) still typechecks and tests green. Confirm the full-toolchain validation did not make the benchmark impossibly hard for the seed Guild — if the typecheck half is the sole blocker, consider whether the benchmark's types are reasonable or whether the `coder` prompt needs guidance on reading `tsc` diagnostics (the `typecheck` tool surfaces them).

## Estimated effort

Large — authoring a good large benchmark and getting the seed Guild to complete it is the hardest data work so far.

## Operator handoff

Run the large benchmark against a real endpoint and report: did it complete? did it hit any safety budget? what was the final status and partial progress? Provide excerpts of `log.jsonl` around any `context_budget_exceeded` or budget events so the agent can iterate prompts in-environment.

## Closeout (step 09 — in-environment deliverables complete)

Authored one large benchmark, `benchmarks/project_todo_cli`, whose task is to build a small command-line todo app from scratch in TypeScript with the full toolchain (`bun run typecheck && bun test tests/`) as validation. It is the first benchmark whose validation exercises both the typechecker and the test suite.

The app stores todos as a JSON array of `{ id, title, done }` objects and supports nine commands (`add`, `list`, `list --done`, `list --open`, `done`, `open`, `remove`, `edit`, `clear`) plus a no-argument usage path. The project is split across four modules so the task genuinely requires multi-step decomposition rather than a single edit:

- `src/todo.ts` — the `Todo` type plus three pure helpers (`formatTodo`, `nextTodoId`, `parseTodoId`).
- `src/store.ts` — `loadTodos` / `saveTodos` over the JSON store file.
- `src/commands.ts` — `runCommand(storePath, args)` returning `{ stdout, exitCode }`, the command dispatcher that ties the helpers and the store together.
- `src/cli.ts` — the entry point: reads `process.argv`, reads the store path from `TODO_STORE` (default `todos.json`), calls `runCommand`, prints, and exits with its exit code.

The benchmark ships the complete test suite as the spec (`tests/todo.test.ts` 8 tests, `tests/store.test.ts` 2 tests, `tests/commands.test.ts` 20 tests — 30 total) plus the four source modules as **stubs**: correct type signatures that compile cleanly but return placeholder values, so every behavior test fails while the project still typechecks. `src/cli.ts` ships complete (it is thin glue: argv/env → `runCommand` → stdout/exit); the substantive logic the agent must implement lives in `todo.ts`, `store.ts`, and `commands.ts`. Validation is `bun run typecheck && bun test tests/` with `expectedExitCode: 0`, `expectedStdoutContains: "30 pass"`, `expectedFiles` covering all four source modules, and `timeoutSeconds: 120`.

The benchmark carries its own `tsconfig.json` and `package.json` (with a `typecheck` script) so `bun run typecheck` is meaningful inside the run workspace: `tsc` reads the workspace `tsconfig.json` and resolves the `typescript` package via upward `node_modules` resolution from `data/runs/<run_id>/workspace/` to the repo root (valid until per-run isolation lands in step 16). The `tsconfig.json` mirrors the repo's strict options (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noUncheckedIndexedAccess`) so the typecheck half of validation is a real check, not a rubber stamp.

Extended `source/benchmarks/suite.test.ts` with a large-benchmark guard: it counts benchmarks with `taskType === "large"`, asserts at least one exists, and asserts `project_todo_cli` is present. The existing generic per-benchmark checks (valid `eval.json` + non-empty `README.md`) already cover the new directory.

Verification (all in `/tmp` / under-repo scratch, cleaned up afterward):

- **Repo health:** `bun run typecheck` clean; `bun test source/` → 221 pass / 0 fail (3 new from `suite.test.ts`: 1 large-count test plus 2 per-benchmark checks across the new directory), full suite ~570ms.
- **Initial state** (shipped stubs, run in-place under `benchmarks/project_todo_cli/` so `tsc` resolves from the repo `node_modules`): `bun run typecheck` clean; `bun test tests/` → 5 pass / 25 fail (the five stub-accidental passes are the pure-helper cases the placeholders happen to satisfy, e.g. `loadTodos` on a missing file returns `[]`); full validation `bun run typecheck && bun test tests/` fails on the test half.
- **Fixed state** (real implementations of `todo.ts` / `store.ts` / `commands.ts` written in a scratch copy): `bun run typecheck` clean; `bun test tests/` → 30 pass / 0 fail; full validation passes; `"30 pass"` substring present.
- **End-to-end CLI smoke test** (`bun src/cli.ts …` with `TODO_STORE` pointed at a temp file): add / list / list --open / done / edit / remove / clear / unknown-command (exit 1) / no-command usage all behaved as specified; temp store removed.

Sizing check (end-of-step evaluation): the task requires multi-file decomposition (three stubbed modules with distinct concerns — pure helpers, persistence, command dispatch — wired together by a fourth), iterative typecheck/test cycles against 30 tests, and the combined typecheck+test toolchain. It is credibly a half-day-plus task for a small consumer-grade model, which is the step's sizing target. The full-toolchain validation did not make the benchmark impossibly hard: the fixed state satisfies it cleanly with straightforward, idiomatic code, and the `coder` prompt's existing typecheck/test guidance (steps 04/05) is sufficient — no prompt edits were needed (and none were verifiable in-environment, per the blocking dependency below).

Deviations from the plan wording (authoritative):

1. **`src/cli.ts` ships complete rather than as a stub.** The plan example described "build a small command-line todo app from scratch"; the app's substantive logic (the `Todo` helpers, the JSON store, and the nine-command dispatcher) is built from scratch by the agent, while `cli.ts` is five lines of argv/env → `runCommand` → stdout/exit glue. Shipping it complete guarantees the benchmark is a genuinely working CLI when solved (the smoke test above exercises the real entry point) and keeps the test bar deterministic — a subprocess-based CLI test would have violated the fast, in-memory validation ethos. `expectedFiles` still lists `src/cli.ts` so the structure is enforced in the final workspace. The agent's tested, typechecked work is the three stubbed modules.
2. **The benchmark ships its own `tsconfig.json` and `package.json` in the benchmark folder.** The plan explicitly required "Author the benchmark's own `tsconfig.json` so `bun run typecheck` is meaningful against the benchmark workspace"; the `package.json` is the necessary companion so `bun run typecheck` resolves the `typecheck` script locally (otherwise `bun run` walks up to the repo `package.json` and typechecks the whole repo from the repo root, which is not meaningful against the workspace). Both files are inert to the repo-level `bun run typecheck` (the repo `tsconfig.json` `include` glob is `benchmarks/**/*.ts`; `tsc` does not auto-discover nested `tsconfig.json`s), so they do not affect repo health. `tsc` resolves the `typescript` package via upward `node_modules` resolution, which holds while runs live under the repo tree; this is the same no-installs constraint `docs/architecture.md` documents and that step 16 will revisit.
3. **No prompt edits and the operator-verified "runs to completion" criterion is deferred.** Per the blocking-dependency pattern established by steps 07 and 08, real-LLM runs cannot exercise this benchmark until step `01` (`write_file`) and step `05` (`test`) land and the CLI entry point (step 02) wires the real `runBenchmark` leaf into `runSuite`. The seed Guild's `coder` role currently has no file-write or `typecheck`/`test` tools (`guild.json` lists only read/search/fetch tools for `coder`), and its prompt still states "the current tool set does not include a file-write tool." Prompt iteration on long runs (context pressure, `context_manager` / `edit_context` guidance, combined typecheck/test guidance) is therefore unverifiable in-environment and is left to the operator handoff once those steps land. The in-environment deliverable — a valid, full-toolchain large benchmark whose initial state fails and whose fixed state passes — is complete and green. This is a sequencing dependency on pending steps, not code debt, so it is not tracked in the plan's debt table.

Health: `bun run typecheck` clean; `bun test source/` → 221 pass / 0 fail (3 new), full suite ~570ms.
