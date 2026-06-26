# Reference

Detailed reference for the executor runtime, Guild format, HTTP API, and benchmark workspaces. For the high-level architecture, see [`docs/architecture.md`](architecture.md).

## Executor runtime

The executor is the minimal runtime that runs the small target model against the Guild. It loads the Guild, invokes the entry role, dispatches tool calls, enforces safety budgets, and persists what happened. It makes no domain decisions — it does not understand "planner," "coder," or "compaction agent." Those are roles in the Guild.

### Run lifecycle

1. **Initiation.** The executor creates `<workspace>/.orchestration/runs/<run_id>/` for bookkeeping, loads the Guild, and starts the entry role with the task as the initial user message. The workspace is modified in place — no copy is made.

2. **Role execution loop.** For the active role, the executor repeats:
   - Assemble context: system prompt, user task, prior assistant/tool messages, child result cards.
   - Call the model endpoint (`POST /v1/chat/completions`).
   - If the prompt exceeds the context window, append a `context_budget_exceeded` tool result and let the role compact rather than crashing.
   - Parse content, reasoning, and tool calls.
   - Log the request/response to `log.jsonl`.
   - Dispatch each tool call (validate against the role's allowed tools, execute, append the result).
   - If the role calls `finish`, finalize and return the result card to the parent.
   - If the response has no tool calls, treat it as an implicit `finish`.

3. **Completion.** The run ends when the entry role calls `finish` or a root-level error occurs that no parent can handle. The executor does not enforce a wall-clock or tool-call cap; run termination is the deployment container's job (see [`docs/architecture.md`](architecture.md) "Run termination"). The executor writes `meta.json` and `log.jsonl`.

### Messages and context

Each role invocation has its own message list. A role does not automatically see its ancestors' conversations — parents may include summaries or result cards when delegating via `agent`. Messages have `role` (`system`/`user`/`assistant`/`tool`), `content`, optional `reasoning`, and tool-call fields. Reasoning is stored separately and excluded from the prompt by default; a role opts in with `includeReasoning: true`.

The executor does not estimate token counts before sending. It trusts only the `usage` fields returned by the API, exposed via `context_info`. There is no pre-send token estimator and no automatic compaction threshold — compaction strategy belongs to the Guild.

### Context budget exceeded

If the endpoint rejects a request because the prompt is too long, the executor appends a synthetic tool result:

```json
{ "tool": "context_budget_exceeded", "currentPromptTokens": 34000, "contextWindow": 32768 }
```

The role may then use `context_info` and `edit_context` to compact, or delegate to a `context_manager` role via `agent`. If a role calls `edit_context` repeatedly without reducing tokens, the executor terminates it after `executor.maxCompactionAttempts`.

### Error handling

Every failure is translated into a structured result the current or parent role can act on. The executor never halts unless the entry role itself cannot recover.

| Failure | Behavior | Surface |
|---|---|---|
| LLM HTTP error | Retry with backoff | If retries fail: `{status: "error", error: {kind: "llm_unavailable"}}` |
| Context budget exceeded | Synthetic tool result | Role can compact or delegate |
| Malformed tool call | Do not execute | `{kind: "invalid_tool_call"}` |
| Unknown tool | Do not execute | `{kind: "unknown_tool"}` |
| Invalid arguments | Do not execute | `{kind: "invalid_arguments"}` |
| Tool timeout | Abort tool | `{kind: "timeout"}` |
| Agent recursion depth exceeded | Terminate child | Parent receives error result card |
| Compaction stuck | Terminate role | `{kind: "compaction_failed"}` |

Recovery is implemented in the Guild, not the executor. A parent that receives an error may retry, call a different role, call a recovery role, or escalate with `finish`.

### Run termination

The executor does not enforce a wall-clock timeout or a per-role tool-call/token cap. Those caps were removed because a wall-clock limit is hardware-dependent (it fires on healthy slow-hardware runs or never fires on fast hardware) and cumulative token/tool-call budgets fired on healthy long-horizon work long before the context window filled. The real context-window guardrail is the endpoint's `context_budget_exceeded` path, which is unchanged.

Run termination is the deployment container's responsibility: `docker stop` (or the orchestrator's own timeout) is the outer boundary that ends a stuck or runaway run. A proper in-band overseer — an interrupt/inspect platform with a loop-detector agent and an operator/API interrupt — is planned work; until it lands, a runaway role that does not overflow its context window runs until the container is stopped. See [`docs/architecture.md`](architecture.md) "Run termination".

### Sequential scheduling

The executor maintains a single queue of pending LLM requests. At most one is in flight at a time. A run is a depth-first traversal of the role tree: when `agent` is called, the child runs to completion before the parent continues.

### Log events

`log.jsonl` is append-only and carries one JSON object per line. Each event has `timestamp`, `type`, and a `payload` whose shape depends on the type. The role-tree and per-turn detail events are:

- `role_start` — `{ role, depth, task, parent? }`. Emitted when a role begins, after its definition is confirmed to exist. `parent` is the calling role's name, omitted for the entry role at depth 0. A refused `agent` call (depth exceeded or unknown child) emits no `role_start` for the never-run child.
- `effort_set` — `{ effort }`. Emitted once at run start, before the entry role begins, recording the run's chosen effort level (see "Effort channel").
- `role_finished` — `{ role, depth, status, summary?, error?, parent? }`. Emitted when a role returns a final card. `status` is the `ResultCard` status; `summary` is the role's own explanation of its result (so a reviewer reading only the log can see why a role errored, rather than only that it did); `error` is the structured `{ kind, message?, details? }` when the card carried one; `parent` is omitted for the entry role. Every `role_start` is paired with exactly one `role_finished`.
- `agent_call` — `{ parent, child, depth }`. Emitted when the `agent` tool is invoked, before the child runs, carrying the parent→child edge even for callers that do not read `role_start`.
- `llm_call` — emitted only on success paths (a turn that returned content/tool calls or finished). Payload: `{ role, messageCount, sent, received, usage, finishReason? }`. `sent` is the message list sent for the turn (each message's `role` and `content`; reasoning omitted; `tool_calls` on assistant messages included). `received` is the assistant response actually received: `content`, `reasoning` (if any), and the parsed `toolCalls` (each call's `id`, `function.name`, and `function.arguments`). `usage` carries `promptTokens`, `completionTokens`, `totalTokens`, and `cachedPromptTokens` (when the endpoint reports a cached share). `finishReason` is the OpenAI `choices[0].finish_reason` (e.g. `stop`, `length`, `tool_calls`, `content_filter`), absent when the endpoint omits it so "absent" is distinguishable from "model stopped". The `llm_unavailable` and `context_budget_exceeded` paths log their own dedicated events and do not emit a misleading `llm_call`.
- `tool_call` — `{ role, tool, arguments }`. `arguments` is the raw JSON-arguments string the model passed, so the exact parameters are recoverable.
- `tool_result` — `{ role, tool, kind, result }`. `result` is the full un-truncated `ToolResult` (`{ kind: 'success', data }` or `{ kind, message, details }`). Truncation still applies only to what is appended to the conversation; the log records the un-truncated result so a reviewer is not flying blind on what a tool returned.
- `depth_exceeded` — `{ parent, child, depth, error }` when an `agent` call is refused for exceeding `maxAgentDepth`.
- `role_not_found` — `{ roleName }` for an unknown entry role, or `{ parent, roleName }` when a child role name is invalid.
- `role_budget_exceeded`, `global_budget_exceeded`, `llm_unavailable`, `context_budget_exceeded`, `implicit_finish`, `unknown_tool`, `invalid_tool_call` — failure and lifecycle events carrying the role and the relevant detail.

## Built-in tools

Built-in tools are listed in the Guild like any other tool but are implemented by the executor.

### `agent`

Delegates to another role. Parameters: `role` (string, required), `task` (string, required). The child runs to completion; its `finish` result card is returned as the tool result. If the child fails due to a safety budget, an error result card is returned. This makes the system recursive: roles are invoked through the same tool-calling mechanism as file reads.

### `finish`

Ends the current role and returns a result card. Parameters: `status` (`"success"`/`"error"`/`"needs_clarification"`), `summary` (string), `artifacts` (array, optional), `error` (object, optional). The entry role's `finish` ends the run.

### `context_info`

Returns metadata about the current role's conversation: context window, current prompt tokens, budget remaining, per-message token counts.

### `edit_context`

Mutates the current role's conversation. Operations: `drop` (range), `strip_reasoning` (range), `replace` (index + content). Returns the updated `context_info`.

### `ask_human`

Asks a human for clarification. Parameters: `question` (string), `context` (string, optional). The question surfaces in the web UI and the run pauses until the operator answers. The web backend is the only backend — the Foundry (when it exists) answers as an HTTP client posting to `/api/answer`, but the tool schema is identical regardless of who answers.

## Native tools

Native tools are implemented in the executor and operate against the mounted workspace. Paths are canonicalized and rejected if they resolve outside the workspace. A typical seed Guild includes:

- `read_file` — read file contents (supports partial reads)
- `write_file` — write or overwrite a file
- `list_directory` — list directory entries
- `run_shell` — run a shell command (lands after per-run environment isolation)

Each tool manifest in the Guild declares the name, description, and parameter schema. The executor validates calls against that schema.

## Guild format

The Guild is the entire behavior of the orchestrator described as JSON. It contains the model endpoint, budgets, context policy, role definitions, tool manifests, and the entry role name. There is no workflow graph — workflows emerge from roles calling `agent` to invoke other roles.

### Files

```
guild/
├── guild.json           # top-level configuration
├── prompts/             # role system prompts (Markdown)
└── tools/               # tool manifests (JSON)
```

System prompts and tool manifests are plain files so the Foundry can rewrite them independently.

### Top-level schema

```json
{
  "schemaVersion": 1,
  "model": { ... },
  "executor": { ... },
  "contextPolicy": { ... },
  "entryRole": "orchestrator",
  "roles": { ... },
  "tools": [ ... ]
}
```

### `model`

```json
{
  "name": "qwen2.5-coder:32b",
  "apiBase": "http://localhost:11434/v1",
  "contextWindow": 32768,
  "reasoningField": "reasoning",
  "generation": { "temperature": 0.2, "maxTokens": 4096 }
}
```

- `name`: arbitrary label for logs.
- `apiBase`: OpenAI-compatible chat/completions endpoint.
- `apiKey`: optional; usually injected from `ORCHESTRATOR_API_KEY` at runtime, not stored in the Guild.
- `contextWindow`: context window size in tokens.
- `reasoningField`: API response field containing reasoning content (e.g. `reasoning`, `reasoning_content`). Omit if the endpoint doesn't expose reasoning.
- `generation`: default sampling parameters (`temperature`, `maxTokens`) applied to every role. There is no per-role generation override.

### `executor`

```json
{
  "maxAgentDepth": 8,
  "defaultToolTimeoutSeconds": 30,
  "maxCompactionAttempts": 5
}
```

Safety budgets enforced by the executor. `maxAgentDepth` guards unbounded agent recursion; `defaultToolTimeoutSeconds` aborts a hung tool subprocess; `maxCompactionAttempts` terminates a `context_manager` that is not reducing tokens. The executor no longer enforces a wall-clock run timeout or per-role tool-call/token caps — run termination is the deployment container's job (see "Run termination" above and [`docs/architecture.md`](architecture.md) "Run termination").

### `contextPolicy`

```json
{ "maxToolOutputChars": 4000 }
```

Tool results longer than this are truncated inline. There is no automatic compaction threshold — roles use `context_info` and `edit_context` to manage context.

### `entryRole`

The role that receives the user's goal. Conventionally a high-level orchestrator, but can be any defined role.

### `roles`

A map from role name to definition:

```json
{
  "orchestrator": {
    "systemPrompt": "guild/prompts/orchestrator.md",
    "tools": ["agent", "finish", "ask_human"]
  }
}
```

Role fields:
- `systemPrompt` (string, required): path to a Markdown file.
- `tools` (array, required): tool names this role may call.
- `includeReasoning` (boolean, optional): include reasoning from prior turns. Default `false`.

### `tools`

A list of tool-manifest file paths. Each manifest declares `name`, `description`, and `parameters` (JSON Schema). The executor validates calls against the schema and exposes the tools to the model in the chat/completions request.

### Tool availability

The set of tools a role may call is part of the Guild. The executor does not hide tools conditionally — the same Guild is used during Foundry optimization and in production, so the small model always sees the same tool names and schemas.

### Workflows

There is no separate graph or playbook file. A workflow is a role calling `agent` multiple times and combining results before calling `finish`. If the Foundry wants a different workflow, it rewrites the orchestrator prompt or adds/removes roles.

## HTTP API

The web UI is the primary interface. The HTTP API exists for programmatic access (e.g. the Foundry). All endpoints return JSON. The server runs one task at a time; there is no queue.

### `POST /api/runs`

Starts a run. **Body:** `{ "task": "...", "effort"?: 0|1|2|3|4|5 }`. `effort` is optional; when omitted the project default (see `GET|PUT /api/settings`) is applied, falling back to `3` when no default is set. An out-of-range or non-integer `effort` returns `400 invalid_body`. **201:** `{ "runId": "..." }`. **409:** `{ "ok": false, "error": "run_in_progress" }`.

### `GET /api/settings`

Returns the project-wide settings. **200:** `{ "effort": 0|1|2|3|4|5 | null }`. `effort` is `null` when no default has been set.

### `PUT /api/settings`

Updates the project-wide settings. **Body:** `{ "effort": 0|1|2|3|4|5 }` (required). The file is written atomically (write-temp + rename). **200:** `{ "effort": ... }`. **400:** `{ "ok": false, "error": "invalid_body" }` for a missing or invalid `effort`.

### `GET /api/runs`

Lists known runs (read from `<workspace>/.orchestration/runs/`), newest first.

### `GET /api/runs/:id`

Full run view: status, role activity, recent log.

### `GET /api/run`

Convenience alias for the most recent run (active or last completed).

### `GET /api/questions`

Returns pending `ask_human` questions from the active run.

### `POST /api/answer`

Submits an answer. **Body:** `{ "id": "...", "answer": "..." }`.

### Lifecycle

The server outlives every run. `SIGINT`/`SIGTERM` trigger graceful shutdown: the active run finishes, the server stops, and the process exits (`130` if interrupted mid-run, `0` if idle).

## Benchmarks

A benchmark is a self-contained folder that defines an initial workspace and a validation rule. The executor treats the folder as a workspace; the Foundry uses the `eval.json` file to validate the final state.

### Folder layout

```
benchmarks/
└── <benchmark_name>/
    ├── eval.json          # validation spec; not seen by the executor
    ├── README.md          # task description
    ├── src/
    └── tests/
```

The executor modifies the workspace in place. `eval.json` should be kept out of the workspace given to the executor so the agent cannot read the validation rules. The Foundry hands the executor a throwaway copy of each benchmark with `eval.json` omitted.

### `eval.json` schema

```json
{
  "taskType": "coding",
  "description": "Implement factorial in src/factorial.py.",
  "validation": {
    "command": "python -m pytest tests/",
    "expectedExitCode": 0,
    "expectedFiles": ["src/factorial.py"],
    "timeoutSeconds": 60
  },
  "humanResponses": {
    "What language should I use?": "TypeScript."
  }
}
```

Fields:
- `taskType`: label for grouping and regression analysis.
- `description`: human-readable description; also the default task text.
- `validation`: how to determine success.
  - `command` (required): shell command run in the final workspace.
  - `expectedExitCode` (optional, default `0`).
  - `expectedFiles` (optional): files that must exist after the run.
  - `expectedStdoutContains` (optional): text that must appear in stdout.
  - `timeoutSeconds` (optional).
- `humanResponses` (optional): deterministic answers to expected `ask_human` questions. The Foundry simulator returns these on near-exact matches.

### Validation

Validation is deterministic: check expected files exist, run the command, check exit code and stdout. A benchmark fails if any step fails. The validation command can be any shell command, not just a test runner — a writing benchmark could use `diff`, for example.

### Suite

A suite is a directory of benchmarks. The Foundry runs every benchmark against each branch Guild and aggregates scores. Suites should include easy, medium, and hard tasks.

## Persistence

Run bookkeeping lives alongside the project under `.orchestration/runs/`:

```
<workspace>/.orchestration/
├── runs/<run_id>/
│   ├── meta.json      # run id, guild path, start/end time, status, effort, final result
│   └── log.jsonl      # one JSON object per line: effort_set, llm calls, tool calls, errors
└── settings.json      # project-wide settings (currently the default effort)
```

The workspace itself holds the final filesystem state (mutated in place). `log.jsonl` is append-only — the executor logs every role start/finish, the parent→child agent-call edges, every LLM turn (sent messages, received response, finish reason, per-call usage), and every tool call/result (raw arguments and the full un-truncated result) so a reviewer can reconstruct exactly what happened from the log alone.

## Effort channel

The effort channel is a per-run, project-wide speed-vs-quality setting: an integer `0`–`5` where `0` is fastest and `5` is highest quality. The executor provides the **channel only** — it accepts, persists, logs, and injects the value; it makes no decision about what each level *means*. The mapping from effort to concrete behavior (generation overrides, critic-skip rules, retry thresholds) lives entirely in the Guild prompts and is tunable by the Foundry, so hardcoding it in the executor would conflict with the Foundry's job.

### Resolution

Effort is resolved once at run submission and is not adjustable mid-run (a second submit while a run is active is rejected as `run_in_progress`):

1. A per-run `effort` in `POST /api/runs` wins.
2. Otherwise the project default from `.orchestration/settings.json` (set via `PUT /api/settings`) is used.
3. Otherwise the default `3` is applied.

### Injection

The entry role (and only the entry role) receives the effort as a system message inserted between its system prompt and the task, so prompts can branch on it. Child roles do **not** receive a global effort directive — the parent decides how to translate effort into delegation instructions. The directive string is a stable contract the Guild prompts depend on:

```
Quality level: <N> of 5 (higher = more careful, slower, more thorough; lower = faster, more direct).
```

### Surfaces

- `RunMeta.effort` and `GET /api/runs/:id` carry the run's effort.
- An `effort_set` event `{ effort }` is logged once at run start.
- `GET|PUT /api/settings` read/write `.orchestration/settings.json` atomically; a malformed file is treated as absent (a torn read mid-write must not crash submission).
- The Foundry sets effort per benchmark and ignores the project setting, so benchmark runs are comparable.
