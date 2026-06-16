# Phase 2 — Executor Runtime

## Goal

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
