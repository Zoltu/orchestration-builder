# Reference

Detailed reference for the executor runtime, Guild format, HTTP API, and benchmark workspaces. For the high-level architecture, see [`docs/architecture.md`](architecture.md).

## Executor runtime

The executor is the minimal runtime that runs the small target model against the Guild. It loads the Guild, invokes the entry role, dispatches tool calls, enforces safety budgets, and persists what happened. It makes no domain decisions — it does not understand "planner," "coder," or "compaction agent." Those are roles in the Guild.

### Run lifecycle

1. **Initiation.** The executor creates `<workspace>/.orchestration/runs/<run_id>/` for bookkeeping, loads the Guild, and starts the entry role with the task as the initial user message. The workspace is modified in place — no copy is made.

2. **Role execution loop.** For the active role, the executor repeats:
   - Assemble context: system prompt, user task, prior assistant/tool messages, child result cards.
   - Call the model endpoint (`POST /v1/chat/completions`).
   - If reported usage crosses the context-pressure threshold, append a one-shot handoff notice at the next turn boundary (see "Context pressure and handoff" below).
   - If the prompt exceeds the context window, compact the conversation in place (bounded attempts; see "Context budget exceeded" below) and resume with a platform notice; if it cannot be made to fit, finish the role with `context_budget_exceeded`.
   - Parse content, reasoning, and tool calls.
   - Log the request/response to `log.jsonl`.
   - Dispatch each tool call (validate against the role's allowed tools, execute, append the result).
   - If the role calls `finish`, finalize and return the result card to the parent.
   - If the response has no tool calls, treat it as an implicit `finish`.

3. **Completion.** The run ends when the entry role calls `finish` or a root-level error occurs that no parent can handle. The executor does not enforce a wall-clock or tool-call cap; run termination is the deployment container's job (see [`docs/architecture.md`](architecture.md) "Run termination"). The executor writes `meta.json` and `log.jsonl`.

### Messages and context

Each role invocation has its own message list. A role does not automatically see its ancestors' conversations — parents may include summaries or result cards when delegating via `agent`. Messages have `role` (`system`/`user`/`assistant`/`tool`), `content`, optional `reasoning`, and tool-call fields. Reasoning is stored separately and excluded from the prompt by default; a role opts in with `includeReasoning: true`.

The executor does not estimate token counts before sending. It trusts only the `usage` fields returned by the API, exposed via `context_info`; there is no char-based token estimator in the proactive path. Reported usage drives the context-pressure trigger (see "Context pressure and handoff" below), which asks the role to hand off before the wall — self-managed compaction strategy still belongs to the Guild. (The post-rejection compaction described below is a safety backstop calibrated from the endpoint's own rejection report, not a pre-send estimate.)

### Context pressure and handoff

The primary defense against context-window overflow is proactive: a role under pressure hands its work off to a fresh instance *while requests still succeed*, so the common path never prunes history and never busts the endpoint's prefix cache with a mid-history edit.

**The trigger reads real reported usage only.** Every successful LLM call stores the endpoint-reported `usage.promptTokens`. When it reaches `executor.contextPressureThreshold` (a fraction in (0, 1), default `0.8`) of the *effective budget*, the engine logs a `context_pressure` event and sets a one-shot flag on the role. The response fires once per role instance, at the top of the next turn — after the turn's tool results, never between an assistant `tool_calls` message and its results, which would be a malformed request on strict endpoints.

**The response depends on depth.** A *child* role gets an append-only `[Platform notice — context pressure]` user message asking it to hand off (below). The *entry role* has no parent to hand off to, so when `executor.contextHandlerRole` is set the platform instead suspends it and invokes the context handler (the seed Guild's `context_manager`) against its frozen, registered state — the same preempt-and-resume interlude as the interrupt platform's loop-check handler, logged with the same `interrupt`/`interrupt_resolved` pair (trigger `context_pressure`). The handler prunes the suspended role's history from the outside with the cross-role `edit_context`/`context_info` (see "Built-in tools"), the role resumes with a `[Platform notice — context compacted]` message, and the run continues. If the handler fails, the role falls back to the handoff notice; without a configured handler, depth 0 always gets the notice.

**Effective budget.** `effectiveBudget = min(contextWindow − generation.maxTokens, learnedCeiling)`. The static term reserves the completion budget up front (llama-server rejects a prompt when `prompt ≥ n_ctx − n_predict`). The learned ceiling is a per-run record of the minimum endpoint-reported `promptTokens` across the run's `context_budget_exceeded` rejections (only rejections that report a count teach anything): one role's wall-hit is ground truth that tightens every role's threshold for the rest of the run.

**The handoff protocol.** The notice asks the role to stop starting new work and call `finish` with `status: "error"` and `error.kind: "context_handoff"`, writing the summary as a handoff brief for the fresh agent that will replace it — what is done, what remains, key file paths, decisions made, and the immediate next step. The working agent is the best-qualified summarizer of its own work, and it summarizes best while it still has its full context. The `context_handoff` kind routes differently from `context_budget_exceeded`: the parent re-delegates a fresh instance of the same role with the brief verbatim, rather than splitting the work smaller (splitting is the wall path's response). The executor treats the card like any other finish — the routing convention lives in the Guild prompts. An entry role that receives the notice (no configured handler, or a failed compaction) wraps the run toward a resumable checkpoint and finishes with a checkpoint summary the operator can resume from.

The reactive backstop below is unchanged: by the time it fires, the proactive protocol has already given the model its chance to hand off cleanly.

### Context budget exceeded

If the endpoint rejects a request because the prompt is too long, the role cannot recover on its own: any notification appended to the conversation would ride along on the next, equally oversized request, so the model would never see it and the executor would retry forever. With `executor.contextHandlerRole` configured, the executor therefore defers the answer to the next turn boundary (the rejection details park on the role's state): the role is suspended and the context handler (the seed Guild's `context_manager`) is invoked against its frozen, registered state — logged as an `interrupt`/`interrupt_resolved` pair with trigger `context_budget_exceeded`. The handler runs on a fresh, small conversation of its own, so it can work even while the target is over the limit: it reads the target's history through the bounded inspection tools, prunes it surgically with cross-role `edit_context`, and the target resumes with a `[Platform notice — context compacted]` message carrying the handler's own summary of what was removed.

When no handler is configured — or the handler fails — the executor falls back to compacting the conversation itself before retrying:

1. Reasoning is stripped from all messages.
2. The oldest turns are dropped (the system prompt, the original task, and the most recent turn are always kept), never splitting an assistant tool call from its tool-result messages — an unmatched pair is a malformed request on OpenAI-compatible endpoints.
3. Surviving tool results that are still oversized are truncated.

The token estimate is calibrated with the prompt-token count the endpoint reported in its rejection (falling back to ~4 chars/token when it reports none) and the compaction target is 70% of the context window, leaving headroom for estimator error and the completion reservation. The compaction is logged as a `context_compacted` event, and the role resumes with a `[Platform notice — context window exceeded]` user message describing what was removed, so it can re-read what it needs or finish honestly.

Recovery is bounded either way: after 3 consecutive rejections — or immediately, when even the undeletable remainder cannot fit — the role finishes with `{status: "error", error: {kind: "context_budget_exceeded"}}` and the parent recovers (the seed Guild re-delegates the work in smaller pieces via `recovery`). A successful call resets the counter.

Separately, a role may manage its own context ahead of the limit with `context_info` and `edit_context`. If a role calls `edit_context` repeatedly without reducing tokens, the executor terminates it after `executor.maxCompactionAttempts`.

### Error handling

Every failure is translated into a structured result the current or parent role can act on. The executor never halts unless the entry role itself cannot recover.

| Failure | Behavior | Surface |
|---|---|---|
| LLM HTTP error | Retry with backoff | If retries fail: `{status: "error", error: {kind: "llm_unavailable"}}` |
| Context budget exceeded | Context handler compacts the conversation (naive in-place backstop as fallback), bounded retries | Role resumes with a platform notice, or finishes `{kind: "context_budget_exceeded"}` |
| Context pressure threshold crossed | Child roles: one-shot handoff notice at the next turn boundary; the role writes a handoff brief and finishes. Entry role (with a configured context handler): suspended and compacted by the handler, then resumed | Child: `{kind: "context_handoff"}`; the parent re-delegates a fresh instance with the brief |
| Malformed tool call | Do not execute | `{kind: "invalid_tool_call"}` |
| Unknown tool | Do not execute | `{kind: "unknown_tool"}` |
| Invalid arguments | Do not execute | `{kind: "invalid_arguments"}` |
| Tool timeout | Abort tool | `{kind: "timeout"}` |
| Agent recursion depth exceeded | Terminate child | Parent receives error result card |
| Compaction stuck | Terminate role | `{kind: "compaction_failed"}` |
| Loop-check handler aborts a role | Finish role with error | `{kind: "loop_detected"}` |
| Operator plan modification | Abort chain below the plan owner | `{kind: "interrupted"}` |

Recovery is implemented in the Guild, not the executor. A parent that receives an error may retry, call a different role, call a recovery role, or escalate with `finish`.

### Run termination

The executor does not enforce a wall-clock timeout or a per-role tool-call/token cap. Those caps were removed because a wall-clock limit is hardware-dependent (it fires on healthy slow-hardware runs or never fires on fast hardware) and cumulative token/tool-call budgets fired on healthy long-horizon work long before the context window filled. The real context-window guardrail is the endpoint's `context_budget_exceeded` path (see "Context budget exceeded" above).

Run termination is the deployment container's responsibility: `docker stop` (or the orchestrator's own timeout) is the outer boundary that ends a stuck or runaway run. The in-band layer is the interrupt platform (see "Interrupt platform" below): the loop-check cadence invokes a handler role that can abort a stuck role with `loop_detected`, and the operator can preempt a run with an inquiry or plan modification. See [`docs/architecture.md`](architecture.md) "Run termination".

### Sequential scheduling

The executor maintains a single queue of pending LLM requests. At most one is in flight at a time. A run is a depth-first traversal of the role tree: when `agent` is called, the child runs to completion before the parent continues.

### Interrupt platform

The interrupt platform lets the Guild define agents that interrupt running work and inspect other roles' activity, without the executor hard-coding any particular overseer. It is agent-agnostic machinery; the loop detector (`loop_detector` in the seed Guild) is one guild role using it, and other interrupt-use agents (on-task checks, post-hoc reviewers) are prompt-only additions on the same tools.

**Role-instance registry.** Every role that starts registers in a run-level registry under a stable role-instance id (`<role>-<depth>-<counter>`, e.g. `coder-1-4`), so multiple instances of one role are distinguishable and targetable. The registry holds the instance's live `RoleState` and is not persisted. The id is logged on `role_start` and `role_finished` as `roleId`, and every instance records its parent's instance id, so the live delegation chain is walkable.

**The safe point.** The engine is synchronous: an interrupt can only be applied by the role currently executing, between turns. At the top of every `executeRoleLoop` iteration — never during an in-flight LLM call — the role drains the interrupt state in a fixed order: marks set by an earlier routing, then the loop-check cadence, then one queued operator request.

**Triggers.** Three sources: (1) every N tool calls, (2) every N generated (completion) tokens — both configured in `executor.interruptTriggers` and scaled by effort (`threshold × (effort + 1)`, so high-effort runs are checked less often), and (3) the operator/API interrupt. A cadence crossing suspends the active role (its registered state stays frozen) and invokes the configured `handlerRole` with a generated task naming the target instance id. The handler investigates with the inspection tools, decides via `trigger_interrupt`, and finishes like any role. The engine then applies the recorded action: `continue` resumes unchanged, `redirect` resumes with the handler's message already injected into the target's history, `abort` finishes the target with a `loop_detected` error card. The handler role is itself exempt from the cadence and never consumes operator requests.

**Operator interrupts.** `POST /api/runs/:id/interrupt` queues a request. `kind: "inquiry"` injects a marked user message (`[Operator inquiry …]`) into the **chain root's** (the entry role's) history at the next safe point, so the answer comes from the role that owns the run-wide picture — the active leaf keeps working undisturbed, and the entry role answers when control next returns to it, delegating to a fresh sub-agent first if the answer needs detail from in-flight work. The run view pairs each inquiry with that answer (the entry role's first content-bearing response after the injection) and both views draw the question and answer as `inquiry` operations. `kind: "plan_modification"` marks every live chain member below the plan owner (the rootmost chain instance of `executor.interruptTriggers.planOwnerRole`, else the chain root) to abort with an `interrupted` error card, and the owner to receive the modification as a marked user message (`[Operator plan modification …]`). The abort then unwinds one safe point at a time through the existing `agent`-call result-card propagation — no separate control-flow mechanism — and the plan owner resumes and re-plans.

**Graceful shutdown.** On `SIGINT`/`SIGTERM` with an active run, the service submits a wind-down inquiry through the same queue and waits under a bounded timeout (`30s`) before exiting, so a run can finish at a safe point instead of being abandoned mid-turn.

### Log events

`log.jsonl` is append-only and carries one JSON object per line. Each event has `timestamp`, `type`, and a `payload` whose shape depends on the type. The role-tree and per-turn detail events are:

- `role_start` — `{ role, roleId, depth, task, parent? }`. Emitted when a role begins, after its definition is confirmed to exist and the instance is registered. `roleId` is the role-instance id (see "Interrupt platform"); `parent` is the calling role's name, omitted for the entry role at depth 0. A refused `agent` call (depth exceeded or unknown child) emits no `role_start` for the never-run child.
- `effort_set` — `{ effort }`. Emitted once at run start, before the entry role begins, recording the run's chosen effort level (see "Effort channel").
- `role_finished` — `{ role, roleId, depth, status, summary?, error?, parent? }`. Emitted when a role returns a final card. `status` is the `ResultCard` status; `summary` is the role's own explanation of its result (so a reviewer reading only the log can see why a role errored, rather than only that it did); `error` is the structured `{ kind, message?, details? }` when the card carried one; `parent` is omitted for the entry role. Every `role_start` is paired with exactly one `role_finished`.
- `agent_call` — `{ parent, child, depth }`. Emitted when the `agent` tool is invoked, before the child runs, carrying the parent→child edge even for callers that do not read `role_start`.
- `llm_call_start` — `{ role }`. Emitted immediately before the LLM request is dispatched, on every turn (including the paths that later fail: `llm_unavailable` and `context_budget_exceeded`). It marks the turn in flight the moment the request is sent, so the flow view can end the call's transit phase (flowing edge → solid) when the callee begins working rather than when the response completes. Only the role is carried; the full turn (message list, response, usage) lands in the succeeding `llm_call`.
- `llm_call` — emitted only on success paths (a turn that returned content/tool calls or finished). Payload: `{ role, messageCount, sent, received, usage, finishReason? }`. `sent` is the message list sent for the turn (each message's `role` and `content`; reasoning omitted; `tool_calls` on assistant messages included). `received` is the assistant response actually received: `content`, `reasoning` (if any), and the parsed `toolCalls` (each call's `id`, `function.name`, and `function.arguments`). `usage` carries `promptTokens`, `completionTokens`, `totalTokens`, and `cachedPromptTokens` (when the endpoint reports a cached share). `finishReason` is the OpenAI `choices[0].finish_reason` (e.g. `stop`, `length`, `tool_calls`, `content_filter`), absent when the endpoint omits it so "absent" is distinguishable from "model stopped". The `llm_unavailable` and `context_budget_exceeded` paths log their own dedicated events and do not emit a misleading `llm_call`.
- `tool_call` — `{ role, tool, arguments }`. `arguments` is the raw JSON-arguments string the model passed, so the exact parameters are recoverable.
- `tool_result` — `{ role, tool, kind, result }`. `result` is the full un-truncated `ToolResult` (`{ kind: 'success', data }` or `{ kind, message, details }`). Truncation still applies only to what is appended to the conversation; the log records the un-truncated result so a reviewer is not flying blind on what a tool returned.
- `depth_exceeded` — `{ parent, child, depth, error }` when an `agent` call is refused for exceeding `maxAgentDepth`.
- `role_not_found` — `{ roleName }` for an unknown entry role, or `{ parent, roleName }` when a child role name is invalid.
- `interrupt` — `{ trigger, handler, target }`. Emitted when the engine suspends the active role to invoke a handler role: `trigger` is the source (`loop_check` for the cadence, `context_pressure` when the entry role is compacted at the threshold, `context_budget_exceeded` when a rejection is answered by the context handler), `handler` the handler role name, `target` the suspended role-instance id. A fresh interrupt instance preempts the active call stack in the interaction model: it becomes its own participant and the root of a new stack, pausing the previous stack. Subsequent `role_start`/`role_finished`/`llm_call`/`tool_call`/`tool_result` events (the handler's) belong to the interrupt stack until its root call closes, at which point control returns to the preempted stack.
- `interrupt_resolved` — `{ trigger, handler, target, action }`. Emitted after the handler finishes. For `loop_check`, `action` is the applied `trigger_interrupt` decision (`continue`, `redirect`, or `abort`; `continue` also when the handler finished without deciding). For the context-compaction triggers, `action` is `compacted` when the handler succeeded and `failed` otherwise (the role then falls back to the handoff notice or the naive backstop).
- `operator_inquiry` — `{ role, roleId, message }`. An operator inquiry was injected as a marked user message into the history of the named role (always the chain root — the entry role).
- `plan_modification` — `{ target, targetRole, message, aborted }`. An operator plan modification was routed: `target`/`targetRole` are the instance id and role name of the plan owner that received the modification, `aborted` the instance ids unwound below it (each finishes with an `interrupted` error card).
- `observe` — `{ role, details? }`. A read-only cross-stack reference in the interaction model: `role` names the open call being read on a paused stack; the adapter sources the observe at the tool emitting it and points it at the matched paused node. It never affects activity. *(Adapter-supported; no current executor tool emits this — the inspection tools read the registry directly rather than logging an observe.)*
- `terminate` — `{ role, details? }`. A rewind reference in the interaction model: `role` names the open call being reverted on a paused stack; the terminate closes that call immediately (no separate return) so the node is removed right away. *(Adapter-supported; no current executor tool emits this.)*
- `context_compacted` — `{ role, droppedMessages, truncatedToolMessages, strippedReasoningMessages, estimatedPromptTokens, contextWindow }`. The executor compacted the role's conversation after a context-window rejection (see "Context budget exceeded" above).
- `context_pressure` — `{ role, promptTokens, effectiveBudget }`. The role's reported prompt size crossed the pressure threshold; the one-shot handoff notice is appended at the next turn boundary (see "Context pressure and handoff" above).
- `role_budget_exceeded`, `global_budget_exceeded`, `llm_unavailable`, `context_budget_exceeded`, `implicit_finish`, `unknown_tool`, `invalid_tool_call` — failure and lifecycle events carrying the role and the relevant detail.

## Built-in tools

Built-in tools are listed in the Guild like any other tool but are implemented by the executor.

### `agent`

Delegates to another role. Parameters: `role` (string, required), `task` (string, required). The child runs to completion; its `finish` result card is returned as the tool result. If the child fails due to a safety budget, an error result card is returned. This makes the system recursive: roles are invoked through the same tool-calling mechanism as file reads.

### `finish`

Ends the current role and returns a result card. Parameters: `status` (`"success"`/`"error"`/`"needs_clarification"`), `summary` (string), `artifacts` (array, optional), `error` (object, optional). The entry role's `finish` ends the run.

### `context_info`

Returns metadata about a conversation: context window, current prompt tokens, budget remaining, per-message token counts. Optional `targetRole` (a role-instance id): when present, the metadata describes that suspended instance's conversation instead of the caller's own.

### `edit_context`

Mutates a conversation. Operations: `drop` (range `[start, end)`), `strip_reasoning` (range), `replace` (index + content). Returns the updated `context_info`. Optional `targetRole` (a role-instance id): when present, the operations apply to that instance's history instead of the caller's own. A cross-role target must be registered (hence suspended — a finished role is unregistered and cannot be compacted) and must not be the caller itself, which is active rather than suspended. In every operation, message index 0 (system prompt) and index 1 (original task) are protected — a batch that touches them is rejected without applying anything. This is the write half of the cross-role compaction primitive: the context handler (see "Context budget exceeded" and "Context pressure and handoff") combines it with the read-only inspection tools to prune a suspended role's history from the outside.

### `ask_human`

Asks a human for clarification. Parameters: `question` (string), `context` (string, optional). The question surfaces in the web UI and the run pauses until the operator answers. The web backend is the only backend — the Foundry (when it exists) answers as an HTTP client posting to `/api/answer`, but the tool schema is identical regardless of who answers.

### `trigger_interrupt`

Applies an interrupt decision to a suspended role instance (see "Interrupt platform"). Parameters: `targetRole` (string, the role-instance id), `action` (`"continue"`/`"redirect"`/`"abort"`), `reason` (string). `redirect` injects `reason` as a user message into the target's history before resuming it; `abort` finishes the target with a `loop_detected` error; `continue` resumes unchanged.

### Inspection tools

Four read-only tools give a handler bounded, windowed access to another role instance's conversation — never the full text. All take `targetRole` (a role-instance id):

- `list_role_messages` — a compact index: per-message `index`, `role`, `contentChars`, `reasoningChars`, `toolCallCount`.
- `read_message_window` — a bounded character slice (`index`, `field` ∈ `content`/`reasoning`, `start`, `end`) of one message; the window is hard-capped.
- `search_role_blocks` — substring/regex search across a role's `content` and/or `reasoning`, returning match offsets with short surrounding windows, capped at `maxMatches`.
- `recent_role_tool_calls` — a structured trace of the last N tool calls (tool name, argument hash, result kind); consecutive identical entries are the loop signature.

## Native tools

Native tools are implemented in the executor and operate against the mounted workspace. Paths are canonicalized and rejected if they resolve outside the workspace. A typical seed Guild includes:

- `read_file` — read file contents (supports partial reads)
- `write_file` — write or overwrite a file
- `list_directory` — list directory entries
- `run_shell` — run a shell command (via `sh -c`, with the workspace as the working directory)

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
  "tools": [ ... ],
  "visualization": { ... }
}
```

The optional `visualization` section carries display-only localization the web client reads through `GET /api/config`: `pseudoRoleLabels` (labels for the `human`/`interrupt`/`tools` pseudo-roles the views invent), `operationTemplates` (per-kind, per-source-kind→destination-kind tiered templates that interpolate `{source}` and `{destination}`), `genericOperationTemplates` (per-kind fallbacks), and `workingTemplates` (generic per-participant-kind fallback for the working-state caption when a role/tool has no per-entry `workingLabel`). The executor ignores it; it exists so a swapped Guild re-flavors the diagram without a frontend change. See [`docs/visualization.md`](visualization.md) "Labels".

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
  "maxCompactionAttempts": 5,
  "contextPressureThreshold": 0.8,
  "contextHandlerRole": "context_manager",
  "interruptTriggers": {
    "handlerRole": "loop_detector",
    "everyToolCalls": 12,
    "everyTokens": 30000,
    "planOwnerRole": "planner"
  }
}
```

Safety budgets enforced by the executor. `maxAgentDepth` guards unbounded agent recursion; `defaultToolTimeoutSeconds` aborts a hung tool subprocess; `maxCompactionAttempts` terminates a `context_manager` that is not reducing tokens. `contextPressureThreshold` (optional, default `0.8`) is the fraction of the effective context budget at which the one-shot pressure response fires (see "Context pressure and handoff"). `contextHandlerRole` (optional) names the guild role the engine invokes to compact a suspended role's conversation — at depth 0 when the entry role crosses the pressure threshold, and at any depth when a request is rejected for context size; when unset, depth-0 pressure falls back to the handoff notice and rejections fall back to the naive in-place backstop. The executor no longer enforces a wall-clock run timeout or per-role tool-call/token caps — run termination is the deployment container's job (see "Run termination" above and [`docs/architecture.md`](architecture.md) "Run termination").

`interruptTriggers` (optional) configures the interrupt platform's loop-check cadence (see "Interrupt platform"): `handlerRole` is the guild role invoked on a trigger (must exist in `roles`); `everyToolCalls`/`everyTokens` are the base thresholds, scaled by effort (`threshold × (effort + 1)`); `planOwnerRole` (optional) names the role that receives plan modifications — the rootmost live chain instance of it, falling back to the chain root when unset or absent from the chain. When the section is absent, cadence checks never fire; operator interrupts work regardless.

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
- `label` (object, optional): tiered display name (`{ detailed, friendly, whimsical }`) the web client renders.
- `description` (object, optional): tiered one-line description of the role.
- `workingLabel` (object, optional): tiered text for the "now" caption when this role is the destination of a settled call (its working phase). A `{participant}` placeholder interpolates to the role's own label at the chosen tier — e.g. `"{participant} is planning the approach"` → "Planner is planning the approach". See [`docs/visualization.md`](visualization.md) "Labels".

### `tools`

A list of tool-manifest file paths. Each manifest declares `name`, `description`, and `parameters` (JSON Schema). The executor validates calls against the schema and exposes the tools to the model in the chat/completions request. Each manifest also carries optional display fields the web client reads through `GET /api/config`: `humanLabel` (tiered display name), `humanDescription` (tiered one-line description), `humanCallLabel` (tiered template for the operation label when an agent calls this tool — interpolates `{source}` and optionally `{destination}`), and `humanWorkingLabel` (tiered text for the "now" caption when this tool is the active/working node — optionally interpolates `{participant}`). See [`docs/visualization.md`](visualization.md) "Labels".

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

Full run view: status, role activity, recent log. Includes `interruptPending` — whether an operator interrupt is queued for the run's next safe point — and `interrupts`, the history of operator interrupts: each inquiry paired with the recipient role's answer (the role's first content-bearing response after the injection) or its waiting/ended state, and each plan modification with its delivery target and aborted list.

### `POST /api/runs/:id/interrupt`

Submits an operator interrupt for the active run (see "Interrupt platform"). **Body:** `{ "kind": "inquiry" | "plan_modification", "message": "..." }`. `inquiry` injects the message into the entry role's conversation (the run keeps working; the entry role answers when control returns to it, delegating to sub-agents as needed); `plan_modification` aborts the live sub-work below the plan owner and delivers the message to it. **202:** `{ "ok": true }` when queued. **400:** `invalid_body` for a bad kind or empty message. **409:** `{ "ok": false, "error": "run_not_active" }` when the named run is not the active one (terminal, unknown, or no run active).

### `GET /api/run`

Convenience alias for the most recent run (active or last completed).

### `GET /api/questions`

Returns pending `ask_human` questions from the active run.

### `POST /api/answer`

Submits an answer. **Body:** `{ "id": "...", "answer": "..." }`.

### Lifecycle

The server outlives every run. `SIGINT`/`SIGTERM` trigger graceful shutdown: with an active run, the service submits a wind-down inquiry through the interrupt channel and waits under a bounded timeout (30s) for the run to finish at a safe point; a run still active after the timeout is abandoned (its log is durable; it reads as "in progress" on restart). The server then stops and the process exits (`130` if a run was still active, `0` if idle).

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

The effort channel is a per-run, project-wide speed-vs-quality setting: an integer `0`–`5` where `0` is fastest and `5` is highest quality. The executor provides the **channel only** — it accepts, persists, logs, and injects the value; it makes no decision about what each level *means*. The mapping from effort to concrete behavior (generation overrides, review-loop round caps, retry thresholds) lives entirely in the Guild prompts and is tunable by the Foundry, so hardcoding it in the executor would conflict with the Foundry's job.

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
