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

4. `src/executor/persistence.ts` — leaf factory `createPersistence(runId)` returning:
   - `createRunDirectory()`
   - `copyWorkspace(sourcePath: string)`
   - `appendLog(event: LogEvent)`
   - `writeMeta(meta: RunMeta)`

5. `benchmarks/hello_001/` — first smoke benchmark:
   - `README.md` with a one-sentence task.
   - `eval.json` validating via `python -m pytest tests/`.
   - `tests/test_output.py` checking a simple output file produced by an agent.

6. `package.json` (or `bun` project metadata) and `tsconfig.json` so the project typechecks.

## Module boundaries

- `src/shared/*` are pure helpers and may be imported anywhere.
- `src/executor/persistence.ts` is a leaf factory: it touches the filesystem only through Bun APIs, and all configuration is closed over at construction time.
- No orchestration is written yet. This phase is purely contracts and I/O wrappers.

## Acceptance criteria

- [ ] `bun tsc --noEmit` passes cleanly.
- [ ] Every shared type has a corresponding runtime type guard that rejects malformed input with a clear message.
- [ ] `createPersistence` can create a run directory and copy a benchmark workspace.
- [ ] `benchmarks/hello_001/eval.json` is syntactically valid and its validation command runs successfully when run manually against a hand-created output.

## Estimated effort

Small — mostly scaffolding and validation logic.
