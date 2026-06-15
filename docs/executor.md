# Executor Runtime

## Purpose

The executor is the minimal runtime that runs the small target model against the Guild. It makes no domain decisions. Its only job is to load the Guild, invoke the entry role, dispatch tool calls, enforce safety budgets, and persist what happened.

## Responsibilities

1. Load `guild.json` and the referenced prompt and tool files.
2. Start the configured entry role with the user’s goal and a fresh workspace.
3. For the active role:
   - Build the conversation from the role’s own session plus tool results and child result cards.
   - Call the single configured chat/completions endpoint.
   - Parse content, reasoning, and tool calls.
   - Dispatch each tool call.

The executor does not estimate token counts before sending. It relies on actual `usage` numbers from the API response. If a request fails because the prompt exceeds the model’s context window, the error is surfaced to the active role as a `context_budget_exceeded` tool result, and the role or a parent must decide how to compact.
4. Detect and surface failures without halting the process whenever possible.
5. Enforce hard safety budgets (depth, tool calls, tokens, time, repeated calls).
6. Persist run artifacts to disk.

The executor does not understand "planner," "coder," "compaction agent," or "orchestrator." Those are roles in the Guild.

## Run lifecycle

### 1. Initiation

A run is started with:

- A Guild path.
- A benchmark workspace path.
- A task description.

The executor:

- Creates `data/runs/<run_id>/`.
- Copies everything from the benchmark workspace into `data/runs/<run_id>/workspace/`, except `eval.json`.
- Loads the Guild.
- Creates a root invocation of the configured `entryRole` with the task description as the initial user message.

### 2. Role execution loop

For the currently active role, the executor repeats:

1. **Assemble context.** Collect all messages belonging to this role: system prompt, user task, prior assistant/tool messages, and child result cards.
2. **LLM call.** POST to `/v1/chat/completions` with the messages and the role’s allowed tools.
3. **Handle context errors.** If the endpoint rejects the request because the prompt exceeds the model context window, append a synthetic tool result `context_budget_exceeded` and return to step 1 instead of crashing. This gives the role (or a parent) a chance to compact.
4. **Parse response.** Extract `content`, `reasoning` (from the configured `reasoningField`), and `tool_calls`.
5. **Log.** Append the raw request/response to `log.jsonl`.
6. **Tool dispatch.** For each tool call:
   - If the tool name is not in the role’s allowed list, return an `invalid_tool_call` error result for that call.
   - Execute the tool.
   - Append the tool result as a `tool` role message.
   - If the tool is `finish`, finalize this role and return its result card to the parent.
7. **End-of-turn.** If the response has no tool calls, treat it as if the role attempted an implicit `finish` with the response content as the summary.

Only one role is actively waiting for an LLM call at a time. The executor is strictly sequential.

### 3. Completion

A run ends when:

- The entry role calls `finish`.
- A root-level error occurs that no parent can handle.
- The run exceeds a hard global budget (time, tokens, depth, total agents).

The executor writes:

- `data/runs/<run_id>/meta.json` — run metadata, status, final status, and final result.
- `data/runs/<run_id>/log.jsonl` — complete event stream.
- `data/runs/<run_id>/workspace/` — final filesystem state.

## Messages and context

Each role invocation has its own message list. The role does not automatically see the entire conversation of its ancestors. Parents may include summaries or result cards when they delegate via the `agent` tool.

A message in the executor has these fields internally:

- `role`: `system`, `user`, `assistant`, or `tool`.
- `content`: string.
- `reasoning`: string or null. Captured from the API response field configured as `model.reasoningField`.
- `tool_call_id`: string, for tool result messages.
- `tool_calls`: array, for assistant messages that requested tool calls.

By default, subsequent prompts include only `content`. A role may opt-in to receiving reasoning by setting `includeReasoning: true` in its role configuration.

## Built-in tools

The executor provides these tools. They are listed in the Guild like any other tool but are implemented by the executor.

### `agent`

Delegates to another role.

Parameters:

- `role` (string, required): the role to invoke.
- `task` (string, required): description or input for the sub-role.
- `budget` (object, optional): overrides for max tool calls, max tokens, timeout.

Behavior:

1. The executor creates a child role invocation.
2. The child may call tools and may recursively call `agent`.
3. When the child calls `finish`, the result card is returned as the result of the `agent` tool call in the parent.
4. If the child fails due to a safety budget, the failure is returned as an error result card.

### `finish`

Returns a result card and ends the current role.

Parameters:

- `status`: `"success"`, `"error"`, or `"needs_clarification"`.
- `summary` (string, required).
- `artifacts` (array of strings, optional): paths to files produced.
- `error` (object, optional): structured error information.

### `context_info`

Returns metadata about the current role’s conversation.

Example result:

```json
{
  "contextWindow": 32768,
  "currentPromptTokens": 25120,
  "budgetRemaining": 7648,
  "messages": [
    { "index": 0, "role": "system", "contentChars": 1200, "reasoningChars": 0 },
    { "index": 1, "role": "user", "contentChars": 300, "reasoningChars": 0 },
    { "index": 2, "role": "assistant", "contentChars": 400, "reasoningChars": 900 }
  ]
}
```

### `edit_context`

Mutates the current role’s conversation.

Parameters:

- `operations` (array of operation objects).

Supported operations:

- `{ "op": "drop", "range": [start, end] }`
- `{ "op": "strip_reasoning", "range": [start, end] }`
- `{ "op": "replace", "index": n, "content": "..." }`

The executor applies the operations and returns the updated `context_info`.

### `ask_human`

Asks a human for clarification. The role provides a `question` and optional `context`. The tool schema does not change between environments; only the backend that answers changes.

Supported human backends:

- **`foundry`** (used during optimization): the question is sent to the large model running the Foundry, which answers as a simulated human persona.
- **`web`** (used in the final product): the question is surfaced in the executor’s web UI. The run pauses and waits indefinitely until the user provides an answer.

The executor writes the pending question to the run state and resumes with the answer as a `tool` result when one is available. The small model sees exactly the same tool name and parameters in both cases.

## Native domain tools

The executor also implements file and shell tools. These are declared in the Guild and may be given to any role.

Examples include:

- `read_file`
- `write_file`
- `list_directory`
- `run_shell`

Each tool manifest in the Guild describes the name, description, and parameter schema. The executor validates calls against that schema. Native tools execute against the run workspace under the configured sandbox policy (by default, only within `data/runs/<run_id>/workspace/`).

## Context management

The executor deliberately does not estimate token counts before sending. It exposes the token usage returned by the model endpoint and provides tools to edit the conversation, but the strategy for when and how to compact belongs to the Guild.

### Context budget exceeded

If the endpoint rejects a request because the prompt is too long for the model context window, the executor appends a synthetic tool result instead of crashing:

```json
{
  "tool": "context_budget_exceeded",
  "currentPromptTokens": 34000,
  "contextWindow": 32768
}
```

The active role may then use `context_info` and `edit_context` to compact, or it may call a dedicated `context_manager` role via `agent`. The Foundry is responsible for discovering compaction strategies that work for the target model.

### Token counts

The only token counts the executor trusts are the `usage.prompt_tokens` and `usage.completion_tokens` fields returned by the API. These are stored in the run log and exposed via `context_info` so roles can observe recent usage. There is no pre-send token estimator.

### Compaction loop prevention

If a role calls `edit_context` repeatedly and `currentPromptTokens` does not decrease, the executor counts the attempts. After a configured maximum, it treats the role as stuck and returns an error result to the parent.

### Reasoning blocks

Reasoning is stored separately and is not included in the active prompt by default. A role can opt-in with `includeReasoning: true`. The `edit_context` tool can strip reasoning from older messages to save space.

## Error handling

The executor translates every failure into a structured result that the current or parent role can act on. The design goal is to never halt the run unless the entry role itself cannot recover.

### Failure modes and surfaces

| Failure | Executor behavior | How it surfaces |
|---|---|---|
| LLM HTTP error | Retry with exponential backoff up to a limit. | If retries fail, the `agent` call that invoked this role returns `{status: "error", error: {kind: "llm_unavailable"}}`. |
| Context budget exceeded | If the LLM API rejects the prompt for exceeding the context window, append `context_budget_exceeded` tool result. | The active role receives a tool result and can compact or call a helper role. |
| Malformed tool call | Do not execute. | Tool result with `{status: "error", error: {kind: "invalid_tool_call", details: "..."}}`. |
| Unknown tool | Do not execute. | Tool result with `{status: "error", error: {kind: "unknown_tool"}}`. |
| Tool argument validation failure | Do not execute. | Tool result with `{status: "error", error: {kind: "invalid_arguments"}}`. |
| Native tool timeout | Abort the tool. | Tool result with `{status: "error", error: {kind: "timeout", afterSeconds: 30}}`. |
| Native tool non-zero exit or I/O error | Complete the tool call. | Tool result JSON includes `status: "error"` plus stdout/stderr/exit code. |
| Agent exceeds tool-call budget | Terminate the child. | Parent receives `{status: "error", error: {kind: "tool_budget_exceeded"}}` from the `agent` call. |
| Agent exceeds token budget | Terminate the child. | Parent receives `{status: "error", error: {kind: "token_budget_exceeded"}}`. |
| Agent exceeds depth budget | Refuse the `agent` call. | Same as above. |
| Agent exceeds wall-clock budget | Terminate the child. | Parent receives `{status: "error", error: {kind: "timeout"}}`. |
| Agent loop detected | Terminate the child. | Parent receives `{status: "error", error: {kind: "loop_detected"}}`. |
| Repeated context compaction with no reduction | Terminate the child. | Parent receives `{status: "error", error: {kind: "compaction_failed"}}`. |

### Recovery

Recovery is implemented in the Guild, not the executor. A parent role that receives an error result from `agent` may:

- Retry with different wording.
- Call a different role.
- Call a dedicated recovery role.
- Escalate by calling `finish` with an error status.

If the entry role escalates to an error status, the run ends with `status: "error"` in `meta.json`.

## Loop detection

The executor detects a stuck agent by tracking tool calls made within a role:

- If the same tool is called with the same arguments more than `executor.maxRepeatedToolCalls` times, the role is terminated.
- If a role performs a sequence of tool calls that repeats exactly, the role is terminated.

This protects against infinite loops without the executor needing to understand what the agent is trying to do.

## Human-in-the-loop backend

The executor does not decide whether a question is real or simulated. The active backend is selected at runtime, usually from the command line or a config file:

```bash
# Optimization: questions answered by the Foundry's large model
bun src/main.ts executor --human-backend foundry ...

# Final product: questions surfaced in the web UI
bun src/main.ts executor --serve 8080 --human-backend web ...
```

A role can only call `ask_human` if the Guild includes it in that role’s tool list. The tool name, schema, and in-context description are identical in both environments, so the small model does not need to know which backend is active.

## Web UI

When run with `--serve <port>`, the executor starts a small local HTTP server (`Bun.serve`) that displays the active run and its history:

- Current role and message tree.
- Tailed `log.jsonl` showing LLM calls, tool calls, and errors.
- Pending `ask_human` questions with an input field for the user to answer.

The UI is plain HTML/JS and has no external dependencies. It is the only human input channel in the final product.

## Persistence

Every run is a self-contained folder:

```
data/runs/<run_id>/
├── meta.json      # run id, guild path, start/end time, status, final result
├── log.jsonl      # one JSON object per line: llm calls, tool calls, errors
└── workspace/     # the benchmark workspace as mutated during the run
```

`log.jsonl` is append-only. The executor logs every LLM call, tool call, and error event so that the Foundry and a human reviewer can reconstruct what happened.

## Sequential scheduling

The executor maintains a single queue of pending LLM requests. At most one request is in flight at a time. This queue accepts new requests from the currently active role, but they are processed in order. A run is a depth-first traversal of the role tree: when an `agent` call is made, the child runs to completion before the parent continues.
