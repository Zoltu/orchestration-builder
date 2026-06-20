# Phase 3 — Tool Layer

## Goal

Implement all native and built-in tools. By the end of this phase the executor supports the full v1 tool set and can validate tool calls against tool manifests.

## Deliverables

1. `source/executor/tool-dispatch.ts` — orchestration function `dispatchToolCall(dependencies, roleState, toolCall)`:
   - Look up tool by name in the Guild tool registry.
   - Return `unknown_tool` or `invalid_arguments` error if validation fails.
   - Execute the tool and return a `ToolResult`.
   - Apply `contextPolicy.maxToolOutputChars` truncation to success results.

2. `source/executor/tools.ts` — leaf factory returning the tool dispatch table:
   - Built-ins: `agent`, `finish`, `context_info`, `edit_context`, `ask_human`.
   - Native: `list_directory`, `glob_files`, `read_file`, `read_file_partial`, `search_text`, `fetch_url`.

3. `source/executor/loader.ts` — leaf factory `createGuildLoader()` returning a `LoadGuild` function:
   - Read `guild.json`.
   - Validate with `validateGuildConfig`.
   - Resolve and validate all referenced prompt files and tool manifest files.
   - Return a fully loaded `LoadedGuild` object.

4. Native tool implementations (each as a configured leaf function):
   - `list_directory(path)` — list files/directories within the workspace.
   - `glob_files(pattern)` — match files by glob pattern within the workspace.
   - `read_file(path)` — read a full file.
   - `read_file_partial(path, offset, limit)` — read a slice of a file.
   - `search_text(pattern, paths?)` — search file contents by regex within the workspace.
   - `fetch_url(url)` — perform an HTTP GET and return text content.

5. Built-in tool implementations:
   - `agent(role, task, budget?)` — invoke child role via `engine.ts`.
   - `finish(status, summary, artifacts?, error?)` — return a `ResultCard` and end the role.
   - `context_info()` — return current conversation metadata and token usage.
   - `edit_context(operations)` — mutate the role’s message list.
   - `ask_human(question, context?)` — stubbed to return `"use your best judgement"`.

6. `source/executor/human-backend.ts` — leaf factory `createHumanBackend({ mode: 'stub' })`. For now the only mode is stub.

## Security boundaries

- All file paths are resolved relative to `data/runs/<run_id>/workspace/` and canonicalized.
- Any resolved path outside the workspace is rejected with `invalid_arguments`.
- `fetch_url` is the only tool that performs external network egress. It should respect a timeout and return only text content.
- Shell execution is intentionally **not** in the v1 tool set; it can be added later by the Foundry once the safety model is validated.

## Module boundaries

- `tools.ts` is one leaf factory that returns a map of configured tool functions. Each individual tool may be defined in the same file or split into `source/executor/tools/` if the file grows too large.
- `tool-dispatch.ts` is orchestration because it validates and routes; it depends on the tool map from `tools.ts`.
- `loader.ts` depends on `validation.ts` for parsing and `persistence.ts` for reading files.

## Acceptance criteria

- [ ] Each tool manifest in `guild/tools/*.json` matches the implementation in `tools.ts`.
- [ ] `read_file` rejects paths that escape the workspace.
- [ ] `agent` correctly spawns a child role and surfaces its `ResultCard`.
- [ ] `edit_context` supports `drop`, `strip_reasoning`, and `replace` operations.
- [ ] `ask_human` returns the stub answer without blocking.
- [ ] Malformed tool calls produce structured error results.

## Estimated effort

Medium — many small functions with clear specs, but the workspace sandboxing needs careful path handling.

## Phase 3 closeout

The following changed during implementation for AGENTS.md compliance or correctness. Future sessions re-reading the plan should treat the wording above as aspirational and the file inventory below as authoritative.

### Truncation relocated from `dispatchToolCall` to the engine

The plan's deliverable 1 says `dispatchToolCall` "applies `contextPolicy.maxToolOutputChars` truncation to success results." Implementing truncation inside `dispatchToolCall` caused a double-encoding bug: when a result was truncated, `dispatchToolCall` returned the truncated serialized JSON as `data: string`, and the engine then re-serialized it via `JSON.stringify`, wrapping the already-JSON text in quotes and escaping it. The LLM received a double-encoded string.

Truncation now happens once, at the serialization site: `engine.ts`'s `serializeToolResult(result, maxChars)` serializes the result and applies `truncateToolOutput` to the final string. `dispatchToolCall` returns the raw `ToolResult` and its config (`DispatchToolCallConfig`) no longer carries `maxToolOutputChars`. A regression test ("tool output exceeding maxToolOutputChars is truncated without double-encoding" in `engine.test.ts`) locks in the corrected behavior.

### Path resolution no longer throws

`source/executor/tools/shared.ts` previously exported `assertWithinWorkspace`, which THREW a `ToolResult` when a path escaped the workspace; every caller wrapped the call in `try/catch` + `wrapToolError`. This was exceptions-for-control-flow over an expected condition (path validation), prohibited by AGENTS.md. It is replaced by `resolveWithinWorkspace`, which returns a `PathResolution` discriminated union (`{ ok: true; path } | { ok: false; error }`). Callers check `if (!resolution.ok) return resolution.error`.

The `realpathSync` fallback previously used a `try/catch` to detect a non-existent path (existence-as-exception antipattern). It now uses `fs.existsSync` before calling `fs.realpathSync`, leaving the `realpathSync` call to fail only on genuinely exceptional I/O.

### Removed: `resolveWithinWorkspace` (dead) and `wrapToolError`

The original `resolveWithinWorkspace` was exported but never imported (dead code) — removed. `wrapToolError` used typecasts (`as { kind: string }`, `as ToolResult['kind']`) to re-shape thrown errors; with path resolution no longer throwing, the only remaining caller (`glob-files.ts`) needed a one-line `Error`→`ToolResult` conversion, so `wrapToolError` was removed in favor of `wrapIoError` (a cast-free helper) and inline conversion where trivial.

### `edit_context` range validation moved out of a typecast

`builtin-tools.ts` previously parsed `drop.range` / `strip_reasoning.range` with `raw['range'] as [number, number]`, deferring real validation to `applyEditOperations`. The parse step now calls the existing `validateRange` helper and returns `invalid_arguments` immediately on a malformed range, eliminating the typecast without changing observable behavior (the same error kind and message are produced).

### Loader uses `existsSync` for missing files

`loader.ts`'s `readRequiredFile` previously caught `readFileSync`'s `ENOENT` to report a missing referenced file. It now checks `fs.existsSync` first (expected condition) and reserves the `try/catch` for genuine I/O errors after existence is confirmed.

