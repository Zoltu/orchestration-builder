# Phase 3 — Tool Layer

## Goal

Implement all native and built-in tools. By the end of this phase the executor supports the full v1 tool set and can validate tool calls against tool manifests.

## Deliverables

1. `src/executor/tool-dispatch.ts` — orchestration function `dispatchToolCall(dependencies, roleState, toolCall)`:
   - Look up tool by name in the Guild tool registry.
   - Return `unknown_tool` or `invalid_arguments` error if validation fails.
   - Execute the tool and return a `ToolResult`.
   - Apply `contextPolicy.maxToolOutputChars` truncation to success results.

2. `src/executor/tools.ts` — leaf factory returning the tool dispatch table:
   - Built-ins: `agent`, `finish`, `context_info`, `edit_context`, `ask_human`.
   - Native: `list_directory`, `glob_files`, `read_file`, `read_file_partial`, `search_text`, `fetch_url`.

3. `src/executor/loader.ts` — leaf factory `createGuildLoader()` returning a `LoadGuild` function:
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

6. `src/executor/human-backend.ts` — leaf factory `createHumanBackend({ mode: 'stub' })`. For now the only mode is stub.

## Security boundaries

- All file paths are resolved relative to `data/runs/<run_id>/workspace/` and canonicalized.
- Any resolved path outside the workspace is rejected with `invalid_arguments`.
- `fetch_url` is the only tool that performs external network egress. It should respect a timeout and return only text content.
- Shell execution is intentionally **not** in the v1 tool set; it can be added later by the Foundry once the safety model is validated.

## Module boundaries

- `tools.ts` is one leaf factory that returns a map of configured tool functions. Each individual tool may be defined in the same file or split into `src/executor/tools/` if the file grows too large.
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
