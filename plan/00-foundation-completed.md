# Completed Foundation (Phases 1–4)

This document is the authoritative record of the foundational work that is already complete. It consolidates the closeout notes from the original Phases 1–4 so that future plan executors have the design-decision context they need without re-deriving it. Treat the original phase wording (preserved only in git history) as aspirational; the file inventory and notes below describe reality.

The forward plan in [`README.md`](README.md) begins where this foundation ends.

## Phase 1 — Foundation (complete)

Shared contracts, runtime validation, persistence primitives, the guild loader, tool dispatch, and the first smoke benchmark.

Deliverables delivered:

- `source/shared/types.ts` — TypeScript interfaces for `GuildConfig`, `ModelConfig`, `ExecutorConfig`, `ContextPolicy`, `RoleDefinition`, `ToolManifest`, `ToolParameter`, `Message`, `AssistantResponse`, `ToolCall`, `ToolResult`, `ResultCard`, `RunOptions`, `RunMeta`, `LogEvent`, `ErrorKind`.
- `source/shared/errors.ts` — shared error/result shapes, the `ErrorKind` union, and `ERROR_KINDS`.
- `source/shared/validation.ts` — runtime type guards (`isGuildConfig`, `isToolManifest`, `isMessage`, `isToolCall`, `isResultCard`, etc.) and `validateGuildConfig` / `validateToolManifest` wrappers that surface `ValidationError`.
- `source/shared/validation.test.ts` — in-memory tests for the guards and validators.
- `source/executor/persistence.ts` — four leaf factories: `createRunDirectory`, `createCopyWorkspace`, `createAppendLog`, `createWriteMeta`. (A fifth, `createSnapshotWorkspace`, was added in Phase 3.)
- `source/executor/tool-dispatch.ts` — pure orchestration factory `createToolDispatch(handlers)`; parses tool-call arguments, validates they form an object, invokes the handler, and returns `ToolResult` errors (`unknown_tool`, `invalid_arguments`) instead of throwing.
- `source/executor/tool-dispatch.test.ts` — in-memory tests.
- `source/executor/loader.ts` — leaf factory `createGuildLoader()` returning a `LoadGuild` function that reads `guild.json`, resolves every role's `systemPrompt` Markdown file, validates every referenced tool-manifest JSON file, and validates that every role tool references a declared tool manifest. Returns a `LoadedGuild` (`{ config, prompts, tools }`).
- `benchmarks/hello_001/` — smoke benchmark (`README.md`, `eval.json`, `tests/test_output.py`).
- `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `.editorconfig`, root `README.md`.

The `test` script is scoped to `source/` so the smoke benchmark (which expects an agent-produced `output.txt`) is not run as a unit test; `bench:smoke` runs it manually.

## Phase 2 — Executor Runtime (complete)

The core executor loop: load a Guild, invoke the entry role, call the configured LLM endpoint, enforce budgets, persist the run.

Files: `source/executor/llm.ts`, `budgets.ts`, `context-builder.ts`, `context-policy.ts`, `engine.ts`, `executor.ts`, plus tests for each.

Deviations from the original plan wording (authoritative):

1. `runRole(deps, context)` takes `roleName` and `task` folded into the `context` object so `depth`, `startMs`, and `loadedGuild` travel with them. Behaviorally identical to the plan's `(deps, context, roleName, task)`.
2. `createLlmCaller(model)` returns `{ call }` (an object), matching the codebase's leaf-factory shape (`createToolDispatch`, the persistence factories, etc. all return objects).
3. `checkRoleBudgets(state, config, roleConfig?)` is classified as a pure helper per AGENTS.md, so config is passed explicitly rather than closed over.
4. `createPersistence` is split into the four factories listed above (plus `createSnapshotWorkspace`).
5. `createGuildLoader()` returns a `LoadGuild` function (same factory-shape refactor).
6. `ExecutorDependencies` lists each field explicitly rather than `extends EngineDependencies`; the executor passes the accumulated dependencies object down without destructuring (structural typing).

Notable behaviors:

- The engine calls `checkRoleBudgets` twice per iteration: before the LLM call (catches accumulated overruns across iterations) and after updating token counts from the LLM response (catches within-iteration overruns). The `role_budget_exceeded` log event carries a `phase` field to distinguish the two.
- `roleState.promptTokens` and `roleState.completionTokens` accumulate across iterations via `+=`. The budget check sums the accumulated totals. A regression test ("token budget accumulates across iterations") exercises two-iteration accumulation against `maxTokensPerRole`.
- `engine.ts` splits the role loop into two private helpers (`handleLlmResult`, `dispatchAndRecord`) that are not exported and not separately tested; they are covered by the engine tests.
- `loader.ts` wraps missing-prompt and missing-tool-manifest file reads in `ValidationError` with path-based messages, and uses `fs.existsSync` for missing files rather than catching `ENOENT`.
- `runExecutor` does not write a "final workspace" snapshot of its own beyond the Phase 3 `createSnapshotWorkspace` call before `writeMeta`.

## Phase 3 — Tool Layer (complete)

All native and built-in tools, the canonical v1 tool manifests, and a conformance test.

Files: `source/executor/tools.ts` plus `source/executor/tools/` (per-tool modules and `shared.ts`), `source/executor/builtin-tools.ts`, `source/executor/human-backend.ts`, `source/executor/tool-manifests.test.ts`, `source/executor/tools.test.ts`, `source/executor/builtin-tools.test.ts`, `source/executor/human-backend.test.ts`, and the eleven `guild/tools/*.json` manifests.

The v1 tool set (canonical):

- Built-ins: `agent`, `finish`, `context_info`, `edit_context`, `ask_human`.
- Native (read-only): `list_directory`, `glob_files`, `read_file`, `read_file_partial`, `search_text`, `fetch_url`.

There is intentionally **no** `write_file` and **no** `run_shell` in v1. The smoke benchmark cannot materialize `output.txt` end-to-end until a write capability is added; that is the first forward step (`01-write-file-tool`).

Deviations / decisions (authoritative):

- **Truncation lives in the engine, not in dispatch.** `dispatchToolCall` returns the raw `ToolResult`; `engine.ts`'s `serializeToolResult(result, maxChars)` serializes and applies `truncateToolOutput` once. Putting truncation in dispatch caused a double-encoding bug. `DispatchToolCallConfig` no longer carries `maxToolOutputChars`. A regression test locks this in.
- **Path resolution returns a union, never throws.** `tools/shared.ts` exports `resolveWithinWorkspace` returning `{ ok: true; path } | { ok: false; error }`. Callers guard with `if (!resolution.ok) return resolution.error`. `realpathSync` is preceded by `fs.existsSync` so the exception path is reserved for genuine I/O errors.
- **No typecasts.** `wrapToolError` (which cast thrown errors) was removed in favor of `wrapIoError` and inline conversion. `edit_context` range parsing uses `validateRange` and returns `invalid_arguments` immediately rather than `as [number, number]`.
- **Tool manifests belong to the tool layer.** The canonical v1 manifests ship as `guild/tools/*.json` and are conformance-tested (`tool-manifests.test.ts`) against the handler tables. Phase 4 does not author tool manifests; it only references them.
- `agent` honors the `budget` parameter; `edit_context` tracks `recentCompactionPromptTokens`; the loader validates that role `tools` reference declared manifests; `createSnapshotWorkspace` exists and is called by `executor.ts` before `writeMeta`.

## Phase 4 — Seed Guild (complete)

The hand-written seed Guild: `guild/guild.json`, six `guild/prompts/*.md` (`orchestrator`, `planner`, `coder`, `critic`, `context_manager`, `recovery`), referencing the eleven Phase 3 tool manifests. Covered by `source/executor/seed-guild.test.ts`.

Decisions (authoritative):

- Paths in `guild.json` are relative to the **Guild directory** (e.g. `"prompts/orchestrator.md"`, `"tools/agent.json"`), because the loader resolves them with `path.join(guildDir, ...)`. `docs/guild.md`'s example uses the `guild/` prefix because it assumes the repo root as the guild dir.
- Tool assignments per role:
  - `orchestrator`: `agent`, `ask_human`, `finish`.
  - `planner`: read-only tools + `finish`.
  - `coder`: read-only tools + `fetch_url` + `finish`.
  - `critic`: read-only tools + `finish`.
  - `context_manager`: `context_info`, `edit_context`, `finish`.
  - `recovery`: `agent`, `ask_human`, `finish`.
- `executor.maxRunTimeSeconds` is `14400` (4 hours); `maxAgentDepth` 8; `maxToolCallsPerRole` 50; `contextPolicy.maxToolOutputChars` 8000. Model defaults mirror `docs/guild.md`'s example; the real endpoint and key are supplied at runtime.
- Because v1 has no file-write tool, the `coder` prompt instructs the role to produce the exact, complete intended file contents in its `finish` summary rather than calling a nonexistent write tool. The orchestrator relays these to the user. This constraint is removed once `write_file` lands in step `01`.

## Current health

- `bun run typecheck` passes cleanly.
- `bun test source/` passes (168 tests across 18 files at the time of writing).
- The smoke benchmark is excluded from `bun test` and is run manually via `bun run bench:smoke` (or the suite runner once it exists).

## Known gaps carried into the forward plan

- No `write_file` tool → smoke benchmark cannot materialize `output.txt` end-to-end. Addressed by step `01-write-file-tool`.
- No `run_shell` tool → the agent cannot run tests or builds to iterate on real coding benchmarks. Addressed by step `30-run-shell-tool`; containment comes from the deployment environment, with per-run environment isolation addressed as part of the Foundry (step `33`) because it runs arbitrary model-chosen commands.
- No checker tools → the agent cannot run a typechecker or test suite to verify its work. The safe, fixed-command `typecheck` (step `04`) and `test` (step `05`) tools ship first; they cover the coding-critical checkers without the arbitrary-shell surface that gates `run_shell`.
- No per-run environment isolation → the suite is constrained to no-install, Bun-validatable tasks. Addressed as part of the Foundry (step `31`), where per-run environment isolation for benchmark evaluation is designed and implemented (an operator-collaboration step — the agent proposes approaches and works with the operator; it does not implement isolation unilaterally).
- No CLI entry point (`source/main.ts`) yet → the executor cannot be invoked end-to-end. Addressed by step `02-cli-entry-point`.
