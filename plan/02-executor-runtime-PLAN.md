# Phase 2 — Executor Runtime

## Goal:

Build the core executor loop: load a Guild, invoke the entry role, call the configured LLM endpoint, enforce budgets, and persist the run. By the end of this phase the executor can run a minimal role that only uses the `finish` tool.

## Deliverables

1. `src/executor/llm.ts` — leaf factory `createLlmCaller(config: ModelConfig)` returning a function that:
   - POSTs to `/v1/chat/completions`.
   - Sends `messages` and `tools` in OpenAI-compatible format.
   - Handles retries with exponential backoff for transient HTTP errors.
   - Parses `content`, `reasoning` (from `config.reasoningField`), `tool_calls`, and `usage`.
   - Returns `ContextBudgetExceeded` when the endpoint rejects the prompt for exceeding the context window.

2. `src/executor/budgets.ts` — orchestration helper `checkRoleBudgets(state)` and `checkGlobalBudgets(state)`:
   - Track depth, per-role tool-call count, per-role token count, run wall-clock time.
   - Detect repeated tool calls with identical arguments beyond `maxRepeatedToolCalls`.
   - Detect repeated context compaction with no token reduction.
   - Return structured error results, never throw.

3. `src/executor/context-builder.ts` — pure helper that builds the message list for a role:
   - System prompt as first message.
   - Initial user task.
   - Prior assistant/tool messages for this role.
   - Child result cards as tool results.

4. `src/executor/context-policy.ts` — pure helpers:
   - `truncateToolOutput(text, maxChars)` — truncate tool results to `contextPolicy.maxToolOutputChars`.
   - `stripReasoning(messages, range)` — strip reasoning blocks from a range of messages.

5. `src/executor/engine.ts` — orchestration function `runRole(dependencies, context, roleName, task)`:
   - The role execution loop described in `docs/executor.md`.
   - Calls LLM, dispatches tool calls, recurses via `agent`.
   - Handles implicit `finish` when a response has no tool calls.
   - Returns a `ResultCard`.

6. `src/executor/executor.ts` — orchestration function `runExecutor(dependencies, options)`:
   - Create run directory, copy workspace, load and validate Guild.
   - Invoke entry role.
   - Write `meta.json` and final workspace.
   - Return run result.

## Module boundaries

- `llm.ts` is the only file that performs HTTP requests.
- `budgets.ts` contains only budget logic; it does not call the LLM or filesystem.
- `engine.ts` is the main orchestration and depends on `llm`, `tool-dispatch` (defined in phase 1 closeout, see `source/executor/tool-dispatch.ts`), `budgets`, and `persistence`.
- `executor.ts` is the top-level orchestration and depends on `loader` (defined in phase 1 closeout, see `source/executor/loader.ts`), `engine`, and `persistence`.

## Dependencies note

No default `dependencies` arguments. `main.ts` will eventually supply real leaf factories. Tests supply fakes.

## Acceptance criteria

- [ ] A role with only the `finish` tool can be invoked and writes a `ResultCard`.
- [ ] A role with only the `agent` and `finish` tools can spawn a child role and receive its result card.
- [ ] Hard budgets are enforced: depth, tool calls, tokens, time, and repeated calls terminate the child with the correct error kind.
- [ ] `log.jsonl` contains every LLM call, tool call, and error event.
- [ ] `meta.json` records run id, guild path, status, and final result.

## Estimated effort

Medium — this is the core of the executor and requires careful error surfacing.

## Phase 2 closeout

The following changed during implementation for AGENTS.md compliance, clarity, or a wider refactor. Future sessions re-reading the plan should treat the wording above as aspirational and the file inventory below as authoritative.

### Deviations from the plan wording

1. `runRole(deps, context)` (vs. plan's `(deps, context, roleName, task)`) — `roleName` and `task` were folded into the `context` object so `depth`, `startMs`, and `loadedGuild` could travel with them. Behaviorally identical.
2. `createLlmCaller(model)` returns `{ call }` (vs. plan's "returning a function") — matches the codebase's leaf-factory shape (`createToolDispatch`, `createPersistence`, etc. all return objects).
3. `checkRoleBudgets(state, config, roleConfig?)` (vs. plan's `(state)`) — the plan called `budgets.ts` an "orchestration helper"; we classified it as a pure helper per AGENTS.md, which requires the config to be passed explicitly.
4. `createPersistence` was split into 4 factories: `createRunDirectory`, `createCopyWorkspace`, `createAppendLog`, `createWriteMeta`. Each closes over `runId`/`baseDir` independently. See `plan/01-foundation-PLAN.md` "Persistence and loader factory shape". The Phase 2 `executor.ts` was refactored to consume these four functions directly.
5. `createGuildLoader()` returns a `LoadGuild` function (vs. a `GuildLoader` object) — same factory-shape refactor.
6. `ExecutorDependencies` lists each field explicitly rather than `extends EngineDependencies` — AGENTS.md "list each dependency explicitly". The executor destructures the engine deps inline at the `runRole` call site.

### Post-LLM token budget check

The engine calls `checkRoleBudgets` twice per iteration: once before the LLM call (catches accumulated overruns across iterations), once after updating `promptTokens`/`completionTokens` from the LLM response (catches within-iteration overruns where the LLM call plus a `finish` tool call together exceed the budget). The `role_budget_exceeded` log event includes a `phase` field to distinguish.

### Token accumulation

`roleState.promptTokens` and `roleState.completionTokens` both accumulate across iterations via `+=`. OpenAI's `prompt_tokens` is per-request, so multi-turn runs legitimately consume more total tokens than the latest prompt size. The budget check sums the accumulated totals. A regression test (`engine.test.ts` "token budget accumulates across iterations") exercises two-iteration accumulation against `maxTokensPerRole`.

### Engine decomposition

`engine.ts` splits the role loop into two private helpers (not exported, not separately tested — covered via existing engine tests):

- `handleLlmResult(llmResult, roleState, deps, roleDefinition, context, config)` — returns `{ kind: 'continue' } | { kind: 'finished'; card } | { kind: 'tool_calls'; toolCalls }`. Encapsulates the LLM-result kind switching, token update, post-LLM budget check, assistant-message push, and implicit-finish detection.
- `dispatchAndRecord(deps, roleState, roleName, allowedTools, dispatch, toolCall)` — returns `ResultCard | null`. Encapsulates one tool call's validation, dispatch, history append, recent-tool-call tracking, and finish detection.

`runRole` itself becomes ~100 lines: setup, while loop with three short blocks (budgets, build+LLM, dispatch loop).

### Loader error wrapping

`source/executor/loader.ts` wraps missing-prompt and missing-tool-manifest file reads in `ValidationError` with path-based messages (`roles.<name>.systemPrompt`, `tools[<path>]`). This matches the error format produced by `validateGuildConfig`.

### `runExecutor` does not write a "final workspace" snapshot

The plan's deliverable 6 says "write `meta.json` and final workspace". Phase 2 has no native tool that mutates the workspace, so the initial `copyWorkspace` is the final state. When Phase 3 adds file-write tools, add a `createSnapshotWorkspace(runId)` factory and call it before `writeMeta`.

### Phase 3 readiness

These Phase 2 items Phase 3 must address:
- Honor the `budget` parameter passed to the `agent` tool handler (currently ignored).
- Track `recentCompactionPromptTokens` when `edit_context` is implemented.
- Loader should validate that role `tools` reference declared tool manifests (current code silently skips missing manifests in the LLM request).
- Add a workspace-snapshot factory once tools mutate the workspace.
