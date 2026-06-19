# Phase 1 — Foundation

## Goal

Establish the project skeleton, shared contracts, runtime validation, persistence primitives, and a tiny smoke benchmark. By the end of this phase the repository compiles with `bun tsc` and a benchmark directory exists, but the executor cannot yet run end-to-end.

## Deliverables

1. `src/shared/types.ts` — TypeScript interfaces for:
   - `GuildConfig`, `ModelConfig`, `ExecutorConfig`, `ContextPolicy`
   - `RoleDefinition`
   - `ToolManifest`, `ToolParameter`
   - `Message`, `AssistantResponse`, `ToolCall`, `ToolResult`
   - `RunOptions`, `RunMeta`, `ResultCard`

2. `src/shared/validation.ts` — runtime type guards for every external JSON object:
   - `isGuildConfig(value: unknown): value is GuildConfig`
   - `isToolManifest(value: unknown): value is ToolManifest`
   - `isMessage(value: unknown): value is Message`
   - `isToolCall(value: unknown): value is ToolCall`
   - `isResultCard(value: unknown): value is ResultCard`
   - Each guard must validate type, required fields, and field types.

3. `src/shared/errors.ts` — shared error/result shapes:
   - `ToolResult` union: success vs error with `kind`
   - Error kinds: `invalid_tool_call`, `unknown_tool`, `invalid_arguments`, `timeout`, `llm_unavailable`, `context_budget_exceeded`, `tool_budget_exceeded`, `token_budget_exceeded`, etc.
   - `ResultCard` shape for `finish` tool output.

4. `source/executor/persistence.ts` — four leaf factories, each returning a single configured function:
   - `createRunDirectory(runId, baseDir?)` → `() => string`
   - `createCopyWorkspace(runId, baseDir?)` → `(sourcePath: string) => void`
   - `createAppendLog(runId, baseDir?)` → `(event: LogEvent) => void`
   - `createWriteMeta(runId, baseDir?)` → `(meta: RunMeta) => void`

5. `benchmarks/hello_001/` — first smoke benchmark:
   - `README.md` with a one-sentence task.
   - `eval.json` validating via `python -m pytest tests/`.
   - `tests/test_output.py` checking a simple output file produced by an agent.

6. `package.json` (or `bun` project metadata) and `tsconfig.json` so the project typechecks.

## Module boundaries

- `source/shared/*` are pure helpers and may be imported anywhere.
- `source/executor/persistence.ts` is a leaf factory: it touches the filesystem using Bun's runtime APIs (including Node's built-in `fs`/`path` modules, which Bun fully supports), and all configuration is closed over at construction time.
- No orchestration is written yet. This phase is purely contracts and I/O wrappers.

## Acceptance criteria

- [ ] `bun tsc --noEmit` passes cleanly.
- [ ] Every shared type has a corresponding runtime type guard that rejects malformed input with a clear message.
- [ ] `createRunDirectory` and `createCopyWorkspace` can create a run directory and copy a benchmark workspace.
- [ ] `benchmarks/hello_001/eval.json` is syntactically valid and its validation command runs successfully when run manually against a hand-created output.

## Estimated effort

Small — mostly scaffolding and validation logic.

## Phase 1 closeout additions

The following were added during phase 1 closeout to prepare a solid foundation for phase 2 without enlarging phase 2's scope:

- `source/executor/loader.ts` — leaf factory `createGuildLoader()` that returns a `LoadGuild` function reading and validating a Guild folder (`guild.json` + prompt Markdown files + tool-manifest JSON files). Not in the original deliverables list; built here so phase 2's executor does not have to.
- `source/executor/tool-dispatch.ts` — pure orchestration `createToolDispatch(handlers)` that parses tool-call arguments and invokes handlers. Not in the original deliverables list; built here so phase 2's engine can compose against it without waiting for phase 3.
- `source/shared/validation.test.ts` and `source/executor/tool-dispatch.test.ts` — in-memory unit tests covering the pure helpers and the dispatch mechanism.
- `AGENTS.md` extended with an "In-memory tests only" subsection and a "Tool Dispatch" / "Guild Loader" top-level sections.
- `PLAN.md` extended with a "Phase 1 closeout" section so future sessions have context for these additions.
- `README.md` quickstart section; `package.json` `test` script scoped to `source/`; `.gitignore` covers `data/`.

## Persistence and loader factory shape

Each leaf function has its own factory that returns a single configured function (per `AGENTS.md`). The persistence module is split into four factories:

- `createRunDirectory(runId, baseDir?)` → `RunDirectory = () => string`
- `createCopyWorkspace(runId, baseDir?)` → `CopyWorkspace = (sourcePath: string) => void`
- `createAppendLog(runId, baseDir?)` → `AppendLog = (event: LogEvent) => void`
- `createWriteMeta(runId, baseDir?)` → `WriteMeta = (meta: RunMeta) => void`

The loader is a single factory returning a single function:

- `createGuildLoader()` → `LoadGuild = (guildDir: string) => LoadedGuild`
