# Reference

Detailed reference for the executor runtime, Guild format, deployment configuration, HTTP API, and benchmark workspaces. For the high-level architecture, see [`docs/architecture.md`](architecture.md).

## Executor runtime

The executor is the minimal runtime that runs the small target model against the Guild. It loads the Guild, invokes the entry role, dispatches tool calls, enforces safety budgets, and persists what happened. It makes no domain decisions — it does not understand "planner," "coder," or "compaction agent." Those are roles in the Guild.

### Run lifecycle

1. **Initiation.** The executor creates `<workspace>/.orchestration/runs/<run_id>/` for bookkeeping, loads the Guild, and starts the entry role with the task as the initial user message. The workspace is modified in place — no copy is made.

2. **Role execution loop.** For the active role, the executor repeats:
   - Assemble context: system prompt, user task, prior assistant/tool messages, child result cards.
   - Call the model endpoint (`POST {apiBase}/responses`, a streaming OpenAI Responses API request).
   - If reported usage crosses the context-pressure threshold, append a one-shot handoff notice at the next turn boundary (see "Context pressure and handoff" below).
   - If the prompt exceeds the context window, compact the conversation in place (bounded attempts; see "Context budget exceeded" below) and resume with a platform notice; if it cannot be made to fit, finish the role with `context_budget_exceeded`.
   - Parse content, reasoning, and tool calls.
   - Log the request/response to `log.jsonl`.
   - Dispatch each tool call (validate against the role's allowed tools, execute, append the result).
   - If the role calls `finish`, finalize and return the result card to the parent.
   - If the response has no tool calls, treat it as an implicit `finish`.

3. **Completion.** The run ends when the entry role calls `finish` or a root-level error occurs that no parent can handle. The executor does not enforce a wall-clock or tool-call cap; run termination is the deployment container's job (see [`docs/architecture.md`](architecture.md) "Run termination"). The executor writes `meta.json` and `log.jsonl`.

### Messages and context

Each role invocation has its own message list. A role does not automatically see its ancestors' conversations — parents may include summaries or result cards when delegating via `agent`. Messages have `role` (`system`/`user`/`assistant`/`tool`), `content`, optional `reasoning`, and tool-call fields. Reasoning is retained in the history and replayed to the model every turn: each assistant message that carries reasoning is sent as a reasoning input item (`{type: "reasoning", content: [{type: "reasoning_text", text}]}`) placed before that turn's message and function-call items. Nothing drops reasoning automatically — not context pressure, and the compaction backstop only as a last resort (see "Context budget exceeded" below) — and the executor ships no `includeReasoning` flag; outside that backstop the only way to remove reasoning is the guild's deliberate `edit_context` `strip_reasoning` op (see "Built-in tools"). Unknown role keys — including the removed `includeReasoning` — are rejected at load with a validation error naming the key, so a stale guild file fails fast with a clear message; the flag's removal changed behavior: reasoning is now always retained and replayed, even for guilds that previously relied on the old strip-by-default behavior.

The executor does not estimate token counts before sending. It trusts only the `usage` fields returned by the API, exposed via `context_info`; there is no char-based token estimator in the proactive path. Reported usage drives the context-pressure trigger (see "Context pressure and handoff" below), which asks the role to hand off before the wall — self-managed compaction strategy still belongs to the Guild. (The post-rejection compaction described below is a safety backstop calibrated from the endpoint's own rejection report, not a pre-send estimate.)

### Context pressure and handoff

The primary defense against context-window overflow is proactive: a role under pressure hands its work off to a fresh instance *while requests still succeed*, so the common path never prunes history and never busts the endpoint's prefix cache with a mid-history edit.

**The trigger reads real reported usage only.** Every successful LLM call stores the endpoint-reported `usage.promptTokens`. When it reaches `executor.contextPressureThreshold` (a fraction in (0, 1), default `0.8`) of the *effective budget*, the engine logs a `context_pressure` event and sets a one-shot flag on the role. The response fires once per role instance, at the top of the next turn — after the turn's tool results, never between an assistant `tool_calls` message and its results, which would be a malformed request on strict endpoints.

**The response depends on depth.** A *child* role gets an append-only `[Platform notice — context pressure]` user message asking it to hand off (below). The *entry role* has no parent to hand off to, so when `executor.contextHandlerRole` is set the platform instead suspends it and invokes the context handler (the seed Guild's `context_manager`) against its frozen, registered state — the same preempt-and-resume interlude as the interrupt platform's loop-check handler, logged with the same `interrupt`/`interrupt_resolved` pair (trigger `context_pressure`). The handler prunes the suspended role's history from the outside with the cross-role `edit_context`/`context_info` (see "Built-in tools"), the role resumes with a `[Platform notice — context compacted]` message, and the run continues. If the handler fails, the role falls back to the handoff notice; without a configured handler, depth 0 always gets the notice.

**Effective budget.** `effectiveBudget = min(contextWindow − generation.maxTokens, learnedCeiling)`. The static term reserves the completion budget up front (llama-server rejects a prompt when `prompt ≥ n_ctx − n_predict`). The learned ceiling is a per-run record of the minimum endpoint-reported `promptTokens` across the run's `context_budget_exceeded` rejections (only rejections that report a count teach anything): one role's wall-hit is ground truth that tightens every role's threshold for the rest of the run.

**The handoff protocol.** The notice asks the role to stop starting new work and call `finish` with `status: "error"` and `error.kind: "context_handoff"`, writing the summary as a handoff brief for the fresh agent that will replace it — what is done, what remains, key file paths, decisions made, and the immediate next step. The working agent is the best-qualified summarizer of its own work, and it summarizes best while it still has its full context. The `context_handoff` kind routes differently from `context_budget_exceeded`: the parent re-delegates a fresh instance of the same role with the brief verbatim, rather than splitting the work smaller (splitting is the wall path's response). The executor treats the card like any other finish — the routing convention lives in the Guild prompts. An entry role that receives the notice (no configured handler, or a failed compaction) wraps the run toward a resumable checkpoint and finishes with a checkpoint summary the operator can resume from.

By the time the reactive backstop below fires, the proactive protocol has already given the model its chance to hand off cleanly.

### Context budget exceeded

If the endpoint rejects a request because the prompt is too long, the role cannot recover on its own: any notification appended to the conversation would ride along on the next, equally oversized request, so the model would never see it and the executor would retry forever. With `executor.contextHandlerRole` configured, the executor therefore defers the answer to the next turn boundary (the rejection details park on the role's state): the role is suspended and the context handler (the seed Guild's `context_manager`) is invoked against its frozen, registered state — logged as an `interrupt`/`interrupt_resolved` pair with trigger `context_budget_exceeded`. The handler runs on a fresh, small conversation of its own, so it can work even while the target is over the limit: it reads the target's history through the bounded inspection tools, prunes it surgically with cross-role `edit_context`, and the target resumes with a `[Platform notice — context compacted]` message carrying the handler's own summary of what was removed.

When no handler is configured — or the handler fails — the executor falls back to compacting the conversation itself before retrying:

1. The oldest turns are dropped (the system prompt, the original task, and the most recent turn are always kept), never splitting an assistant tool call from its tool-result messages — an unmatched pair is a malformed request on OpenAI-compatible endpoints.
2. Surviving tool results that are still oversized are truncated.
3. Only when the estimate is still over target, reasoning is stripped from the oldest surviving messages, one at a time, until the estimate fits or no strippable reasoning is left — the last assistant message's reasoning is never stripped.

Reasoning is replayed to the model every turn (see "Messages and context" above), so stripping it silently rewrites what the model believes it decided; the backstop accepts that cost only after dropping and truncating cannot fit, and shedding reasoning proactively remains the guild's deliberate choice via the `edit_context` `strip_reasoning` op.

The token estimate is calibrated with the prompt-token count the endpoint reported in its rejection (falling back to ~4 chars/token when it reports none) and the compaction target is 70% of the context window, leaving headroom for estimator error and the completion reservation. The compaction is logged as a `context_compacted` event, and the role resumes with a `[Platform notice — context window exceeded]` user message describing what was removed, so it can re-read what it needs or finish honestly.

Recovery is bounded either way: after 3 consecutive rejections — or immediately, when even the undeletable remainder cannot fit — the role finishes with `{status: "error", error: {kind: "context_budget_exceeded"}}` and the parent recovers (the seed Guild re-delegates the work in smaller pieces via `recovery`). A successful call resets the counter.

Separately, a role may manage its own context ahead of the limit with `context_info` and `edit_context`. If a role calls `edit_context` repeatedly without reducing tokens, the executor terminates it after `executor.maxCompactionAttempts`.

### Compaction and the prompt cache

Between compaction events a role's history is append-only, and reasoning is replayed to the model every turn (see "Messages and context" above). Server prompt caches re-prefill from the first differing token, so continuous history editing would re-prefill the whole suffix every turn, while an append-only turn pays only for its new tokens. All edits the backstop makes therefore coalesce into a single compaction event, and the earliest edit defines the refill — edits after it are cache-free; a rewrite the context manager makes through `edit_context` is not part of that coalescing, because those rewrites are themselves compaction events, agent-decided and each counting as the event. The backstop strips reasoning only as a last resort, oldest first across the surviving history, and never from the final assistant message (see the numbered list above; the system prompt and the original task carry no reasoning in practice). During agent-driven compaction it is the seed Guild's `context_manager` role that decides reasoning policy. A model change forces a cache refill regardless, which makes a coalesced deep rewrite free at that boundary.

### Error handling

Every failure is translated into a structured result the current or parent role can act on. The executor never halts unless the entry role itself cannot recover.

| Failure | Behavior | Surface |
|---|---|---|
| LLM HTTP error | Retry with backoff | If retries fail: `{status: "error", error: {kind: "llm_unavailable"}}` |
| LLM endpoint failure or empty completion (`finish_reason: "error"`, or a response with no content and no tool calls) | Retried with backoff like an HTTP error; `finish_reason: "length"` with no content fails immediately (the completion budget was consumed before any content — raise `generation.maxTokens`) | `{status: "error", error: {kind: "llm_unavailable"}}` |
| Context budget exceeded | Context handler compacts the conversation (naive in-place backstop as fallback), bounded retries | Role resumes with a platform notice, or finishes `{kind: "context_budget_exceeded"}` |
| Context pressure threshold crossed | Child roles: one-shot handoff notice at the next turn boundary; the role writes a handoff brief and finishes. Entry role (with a configured context handler): suspended and compacted by the handler, then resumed | Child: `{kind: "context_handoff"}`; the parent re-delegates a fresh instance with the brief |
| Malformed tool call | Do not execute | `{kind: "invalid_tool_call"}` |
| Unknown tool | Do not execute | `{kind: "unknown_tool"}` |
| Invalid arguments | Do not execute | `{kind: "invalid_arguments"}` |
| Tool timeout | Abort tool | `{kind: "timeout"}` |
| Tool's external service unavailable (not configured, rate-limited, HTTP error, network failure, failed-to-start command) | Return error to the caller | `{kind: "unavailable"}` |
| Agent recursion depth exceeded | Terminate child | Parent receives error result card |
| Compaction stuck | Terminate role | `{kind: "compaction_failed"}` |
| Loop-check handler aborts a role | Finish role with error | `{kind: "loop_detected"}` |
| Operator plan modification | Abort chain below the plan owner | `{kind: "interrupted"}` |
| Service restart mid-run | Resume from checkpoint on startup; if unresumable, mark the run terminal | `status: "interrupted"` meta with `{kind: "interrupted"}` (see "Run persistence and resumption") |

Recovery is implemented in the Guild, not the executor. A parent that receives an error may retry, call a different role, call a recovery role, or escalate with `finish`.

### Run termination

The executor does not enforce a wall-clock timeout or a per-role tool-call/token cap: a wall-clock limit is hardware-dependent (it fires on healthy slow-hardware runs or never fires on fast hardware), and cumulative token/tool-call budgets fire on healthy long-horizon work long before the context window fills. The real context-window guardrail is the endpoint's `context_budget_exceeded` path (see "Context budget exceeded" above).

Run termination is the deployment container's responsibility: `docker stop` (or the orchestrator's own timeout) is the outer boundary that ends a stuck or runaway run. The in-band layer is the interrupt platform (see "Interrupt platform" below): the loop-check cadence invokes a handler role that can abort a stuck role with `loop_detected`, and the operator can preempt a run with an inquiry or plan modification. See [`docs/architecture.md`](architecture.md) "Run termination".

### Sequential scheduling

The executor maintains a single queue of pending LLM requests. At most one is in flight at a time. A run is a depth-first traversal of the role tree: when `agent` is called, the child runs to completion before the parent continues.

### Interrupt platform

The interrupt platform lets the Guild define agents that interrupt running work and inspect other roles' activity, without the executor hard-coding any particular overseer. It is agent-agnostic machinery; the loop detector (`loop_detector` in the seed Guild) is one guild role using it, and other interrupt-use agents (on-task checks, post-hoc reviewers) are prompt-only additions on the same tools.

**Role-instance registry.** Every role that starts registers in a run-level registry under a stable role-instance id (`<role>-<depth>-<counter>`, e.g. `coder-1-4`), so multiple instances of one role are distinguishable and targetable. The registry holds the instance's live `RoleState` and is not persisted. The id is logged on `role_start` and `role_finished` as `roleId`, and every instance records its parent's instance id, so the live delegation chain is walkable.

**The safe point.** The engine is synchronous: an interrupt can only be applied by the role currently executing, between turns. At the top of every `executeRoleLoop` iteration — never during an in-flight LLM call — the role drains the interrupt state in a fixed order: marks set by an earlier routing, then the loop-check cadence, then one queued operator request.

**Triggers.** Three sources: (1) every N tool calls, (2) every N generated (completion) tokens — both configured in `executor.interruptTriggers` and scaled by the run's effort tier (`threshold ×` the tier's factor: `quick` ×2, `standard` ×4, `thorough` ×6, so higher-effort runs are checked less often), and (3) the operator/API interrupt. A cadence crossing suspends the active role (its registered state stays frozen) and invokes the configured `handlerRole` with a generated task naming the target instance id. The handler investigates with the inspection tools, decides via `trigger_interrupt`, and finishes like any role. The engine then applies the recorded action: `continue` resumes unchanged, `redirect` resumes with the handler's message already injected into the target's history, `abort` finishes the target with a `loop_detected` error card. The handler role is itself exempt from the cadence and never consumes operator requests.

**Operator interrupts.** `POST /api/runs/:id/interrupt` queues a request (the public kinds are `inquiry` and `plan_modification`; a third kind, `notice`, is internal-only — see "Graceful shutdown"). `kind: "inquiry"` is answered by a fresh agent rather than injected into a working role: at the next safe point the active role suspends and the configured `executor.inquiryHandlerRole` (the seed Guild's `inquiry_responder`) runs as a fresh instance against the frozen registry state — the same preempt-and-resume interlude as the loop-check and context handlers, logged with the same `interrupt`/`interrupt_resolved` pair (trigger `inquiry`). The handler's task briefing carries the operator's verbatim question and a root-first map of the live role instances (ids, names, depths, parents); its toolbox is read-only (the inspection tools — including the run-log readers for researching roles that already finished — cross-role `context_info`, and read-only filesystem tools). The handler answers by calling `finish` — the card's summary IS the answer shown to the operator — and the suspended role resumes whatever the handler did: a run is never killed over a question, and with no handler configured the inquiry is dropped and logged (`inquiry_dropped`). In the interaction model the interlude pushes a new call stack rooted at a fresh human-asker participant (the person asking is that stack's caller), so the views draw it as its own preempting stack like any interrupt, with `observe` lines crossing into the paused stack when the handler inspects a suspended role. The run view pairs each inquiry's `interrupt` with its `interrupt_resolved`: an `answered` resolution's summary is the answer; anything else ends the inquiry unanswered. `kind: "plan_modification"` marks every live chain member below the plan owner (the rootmost chain instance of `executor.interruptTriggers.planOwnerRole`, else the chain root) to abort with an `interrupted` error card, and the owner to receive the modification as a marked user message (`[Operator plan modification …]`). The abort then unwinds one safe point at a time through the existing `agent`-call result-card propagation — no separate control-flow mechanism — and the plan owner resumes and re-plans. The internal `notice` kind keeps the inject-into-chain-root path: a marked user message (`[Operator notice …]`) lands in the **chain root's** (the entry role's) history as a directive to act on, not a question to answer.

**Graceful shutdown.** On `SIGINT`/`SIGTERM` with an active run, the service submits a wind-down `notice` through the same queue — the internal interrupt kind that injects a marked user message into the chain root's history (a directive to wind down, not a question to answer) — and waits under a bounded timeout (`30s`) before exiting, so a run can finish at a safe point instead of being abandoned mid-turn. A run still active when the timeout elapses is not lost: the next startup resumes it from its last checkpoint (see "Run persistence and resumption").

### Run persistence and resumption

The executor keeps every role's conversation and budget state in memory, so a service restart (crash, host reboot, `docker stop`, operator Ctrl-C) would otherwise lose the active run. To survive it, the executor checkpoints the runnable role stack to `<run>/state.json`, and the service reconciles runs on startup.

**Checkpoint contents.** `state.json` holds the full depth-first stack, root first: for each live role, its context (role, depth, task, parent, effort on the entry role), its instance id, its complete `RoleState` (history, tool-call count, token accumulators, loop-check watermarks, context-pressure/compaction state, the llm_call delta baseline so a resumed role continues logging deltas instead of re-logging its whole conversation), and — for each suspended ancestor — the pending turn it is paused in (the turn's tool calls and the index of the `agent` call it awaits, plus the child's result card once the child has finished). The entry frame also carries the run's logging level (see "Logging level"), so a resumed run keeps filtering its log at the same level. It also carries the run id, the original start time, the registry id counter, and the learned context ceiling, so the resumed run mints non-colliding instance ids, keeps the tightened pressure threshold, and preserves budget accumulators and elapsed-time accounting — a resumed run cannot exceed its budget by forgetting prior usage.

**When it is written.** At every leaf safe point (the same drain point the interrupt platform uses, once per turn) and on every `role_finished`. Writes are atomic (temp file + rename), so the on-disk checkpoint is never torn — a crash mid-write leaves the previous, complete checkpoint. Writes are suppressed while a handler invocation (loop-check, context, or inquiry handler) is on the stack: a handler interlude is atomic with respect to the checkpoint, so a restart either sees its fully-applied effects or re-runs the drain. The checkpoint is deleted when the run reaches a terminal meta.

**Resume.** On startup, the service scans the runs directory. A run with no terminal meta (none, or one still `running`) and a valid checkpoint resumes under its original run id: the stack is reconstructed — suspended parents re-register with their preserved ids and pending turns, the leaf re-enters at its loop top — and the depth-first traversal continues. A child that was mid-flight is re-entered; a child that had already finished is not re-run — its recorded card is delivered to the parent as the suspended `agent` call's tool result. Resumed roles do not re-emit `role_start` (their start events are already in the log); a `run_resumed` event marks the restart boundary. Only one run resumes (one task at a time): the most recent resumable run.

**Reconciliation.** A run that cannot be resumed — missing or corrupt checkpoint, or superseded by a newer resumable run — is marked `interrupted`: a terminal `meta.json` with `status: "interrupted"`, an `error: { kind: "interrupted", message }` recording why, and its original fields preserved. `interrupted` is a terminal status everywhere (run list, run view, flow model), rendered error-toned, so the UI never shows an abandoned run as perpetually "in progress". Because the write is atomic, even a hard kill (`docker kill`, `kill -9`) mid-checkpoint-write still resumes — the on-disk file is always a complete checkpoint — so in practice `interrupted` is expected only when no valid checkpoint ever existed (a crash before the run's first safe point or genuine disk corruption). A kill mid-write may leave a `state.json.<pid>.tmp` artifact in the run directory; it is ignored and overwritten by later checkpoint writes.

**Caveats.** Checkpoint granularity is the turn: mid-turn work (an in-flight LLM call, a tool executing, a pending `ask_human` answer) is replayed from the last checkpoint — tool side effects already applied to the workspace are not rolled back, and a few log events may duplicate straddling a restart boundary (`log.jsonl` is append-only and is never rewritten). Pending operator interrupts and pending human questions are in-memory and lost on restart; the operator can resubmit. Resuming against a changed Guild is not a supported migration — a role that no longer exists finishes with an error card that unwinds the run.

### Log events

`log.jsonl` is append-only and carries one JSON object per line. Each event has `timestamp`, `type`, and a `payload` whose shape depends on the type. The role-tree and per-turn detail events are:

- `role_start` — `{ role, roleId, depth, task, parent? }`. Emitted when a role begins, after its definition is confirmed to exist and the instance is registered. `roleId` is the role-instance id (see "Interrupt platform"); `parent` is the calling role's name, omitted for the entry role at depth 0. A refused `agent` call (depth exceeded or unknown child) emits no `role_start` for the never-run child.
- `effort_set` — `{ effort }`. Emitted once at run start, before the entry role begins, recording the run's chosen effort tier (`quick`, `standard`, or `thorough`; see "Effort channel").
- `role_finished` — `{ role, roleId, depth, status, summary?, error?, parent? }`. Emitted when a role returns a final card. `status` is the `ResultCard` status; `summary` is the role's own explanation of its result (so a reviewer reading only the log can see why a role errored, rather than only that it did); `error` is the structured `{ kind, message?, details? }` when the card carried one; `parent` is omitted for the entry role. Every `role_start` is paired with exactly one `role_finished`.
- `agent_call` — `{ parent, child, depth }`. Emitted when the `agent` tool is invoked, before the child runs, carrying the parent→child edge even for callers that do not read `role_start`.
- `llm_call_start` — `{ role }`. Emitted immediately before the LLM request is dispatched, on every turn (including the paths that later fail: `llm_unavailable` and `context_budget_exceeded`). It marks the turn in flight the moment the request is sent, so the flow view can end the call's transit phase (flowing edge → solid) when the callee begins working rather than when the response completes. Only the role is carried; the full turn (message list, response, usage) lands in the succeeding `llm_call`.
- `llm_call` — emitted only on success paths (a turn that returned content/tool calls or finished). Payload: `{ role, roleId, messageCount, sentFrom, sent, received, usage, finishReason? }`. `roleId` is the role-instance id the `role_start` event carries, so a role's turns are groupable per instance even when it spawns a same-named child. To keep the log's growth proportional to the work done rather than quadratic in the turns, `sent` is a delta of the role's conversation: only the messages the request added since the role's previous `llm_call` event (each message's `role` and `content`; reasoning omitted; `tool_calls` on assistant messages included). `sentFrom` is the conversation index `sent[0]` starts at, and `messageCount` is the full request's message count, so a full snapshot is `sentFrom: 0` with `sent.length === messageCount` — the shape of a role's first `llm_call`, and of the first one after anything rewrote the conversation out from under the delta baseline: an `edit_context` operation (`drop`, `strip_reasoning`, or `replace` — a content change would be invisible in a slice) or a platform compaction forces the role's next `llm_call` back to a full snapshot. An `llm_call` without `sentFrom` is a full snapshot by definition. A turn's full conversation is reconstructed by walking the log backward from the event, folding the deltas of the same role instance (matched on `roleId`, falling back to the `role` name when `roleId` is absent): track the still-uncovered start (initially the event's `sentFrom`); each earlier same-instance `llm_call` contributes `sent.slice(0, max(0, uncovered − sentFrom))`, clamped to that slice's length — its own absent `sentFrom` reading as 0 — and lowers the uncovered start to its `sentFrom`; stop when the uncovered start reaches 0. Each request is its predecessor's plus appended messages, so the folded slices are exactly the request a full snapshot would have carried, and `GET /api/runs/:id/log?detail=` performs this fold server-side, so the raw-detail view is identical for delta and full-snapshot logs. `received` is the assistant response actually received: `content`, `reasoning` (if any), and the parsed `toolCalls` (each call's `id`, `function.name`, and `function.arguments`). `usage` carries `promptTokens`, `completionTokens`, `totalTokens`, and `cachedPromptTokens` (when the endpoint reports a cached share). `finishReason` is the OpenAI `choices[0].finish_reason` (e.g. `stop`, `length`, `tool_calls`, `content_filter`), absent when the endpoint omits it so "absent" is distinguishable from "model stopped". Under the `standard` logging level the `sent` and `received` bodies are omitted from the payload (see "Logging level"). The `llm_unavailable` and `context_budget_exceeded` paths log their own dedicated events and do not emit a misleading `llm_call`.
- `tool_call` — `{ role, tool, arguments }`. `arguments` is the raw JSON-arguments string the model passed, so the exact parameters are recoverable.
- `tool_result` — `{ role, tool, kind, result }`. `result` is the full un-truncated `ToolResult` (`{ kind: 'success', data }` or `{ kind, message, details }`). Truncation still applies only to what is appended to the conversation; the log records the un-truncated result so a reviewer is not flying blind on what a tool returned. Under the `standard` logging level the `result` body is omitted from the payload (see "Logging level").
- `depth_exceeded` — `{ parent, child, depth, error }` when an `agent` call is refused for exceeding `maxAgentDepth`.
- `role_not_found` — `{ roleName }` for an unknown entry role, or `{ parent, roleName }` when a child role name is invalid.
- `interrupt` — `{ trigger, handler, target, message? }`. Emitted when the engine suspends the active role to invoke a handler role: `trigger` is the source (`loop_check` for the cadence, `context_pressure` when the entry role is compacted at the threshold, `context_budget_exceeded` when a rejection is answered by the context handler, `inquiry` for an operator question), `handler` the handler role name, `target` the suspended role-instance id; the `inquiry` trigger additionally carries `message`, the operator's verbatim question. The interrupt preempts the active call stack in the interaction model: a new stack pauses the previous one, rooted at a fresh participant — a synthetic interrupt instance, or a fresh human asker for an inquiry (the person asking is that stack's caller). Subsequent `role_start`/`role_finished`/`llm_call`/`tool_call`/`tool_result` events (the handler's) belong to the interrupt stack until its root call closes, at which point control returns to the preempted stack.
- `interrupt_resolved` — `{ trigger, handler, target, action, handlerStatus?, summary? }`. Emitted after the handler finishes. For `loop_check`, `action` is the applied `trigger_interrupt` decision (`continue`, `redirect`, or `abort`; `continue` also when the handler finished without deciding). For the context-compaction triggers, `action` is `compacted` when the handler succeeded and `failed` otherwise (`failed` carries `handlerStatus`; the role then falls back to the handoff notice or the naive backstop). For `inquiry`, `action` is `answered` with `summary` carrying the handler's finish-card summary — the answer shown to the operator — or `failed` with `handlerStatus` and `summary` when the handler itself errored.
- `operator_notice` — `{ role, roleId, message }`. An operator notice (the graceful-shutdown wind-down, or a future platform directive) was injected as a marked user message into the history of the named role (always the chain root — the entry role). A notice is a directive to act on, not a question to answer.
- `inquiry_dropped` — `{ message, reason }`. An operator inquiry arrived but `executor.inquiryHandlerRole` is not configured: the question is dropped and the run continues — a run is never killed over a question.
- `plan_modification` — `{ target, targetRole, message, aborted }`. An operator plan modification was routed: `target`/`targetRole` are the instance id and role name of the plan owner that received the modification, `aborted` the instance ids unwound below it (each finishes with an `interrupted` error card).
- `observe` — `{ role, roleId, details }`. Emitted between a `tool_call` and its `tool_result` whenever a read-only cross-role inspection tool (`list_role_messages`, `read_message_window`, `search_role_blocks`, `recent_role_tool_calls`, or cross-role `context_info` — never `edit_context`, which mutates) successfully reads another live role instance: `role`/`roleId` name the observed instance (the open call being read on a paused stack), `details` the tool name. A read-only cross-stack reference in the interaction model: the adapter sources the observe at the tool emitting it and points it at the matched paused node, and it never affects activity.
- `terminate` — `{ role, details? }`. A rewind reference in the interaction model: `role` names the open call being reverted on a paused stack; the terminate closes that call immediately (no separate return) so the node is removed right away. *(Adapter-supported; no current executor tool emits this.)*
- `context_compacted` — `{ role, droppedMessages, truncatedToolMessages, strippedReasoningMessages, estimatedPromptTokens, contextWindow }`. The executor compacted the role's conversation after a context-window rejection (see "Context budget exceeded" above).
- `context_pressure` — `{ role, promptTokens, effectiveBudget }`. The role's reported prompt size crossed the pressure threshold; the one-shot handoff notice is appended at the next turn boundary (see "Context pressure and handoff" above).
- `run_resumed` — `{ runId, resumedFrames }`. Emitted once when a run resumes from its checkpoint after a service restart, ahead of any resumed-role events; it marks the boundary between the pre-restart and post-restart portions of the log (see "Run persistence and resumption"). Resumed roles do not re-emit `role_start`, and a few events immediately straddling the boundary may duplicate.
- `role_budget_exceeded`, `global_budget_exceeded`, `llm_unavailable`, `context_budget_exceeded`, `implicit_finish`, `unknown_tool`, `invalid_tool_call` — failure and lifecycle events carrying the role and the relevant detail.

## Built-in tools

Built-in tools are listed in the Guild like any other tool but are implemented by the executor.

### `agent`

Delegates to another role. Parameters: `role` (string, required), `task` (string, required). The child runs to completion; its `finish` result card is returned as the tool result. If the child fails due to a safety budget, an error result card is returned. This makes the system recursive: roles are invoked through the same tool-calling mechanism as file reads.

### `finish`

Ends the current role and returns a result card. Parameters: `status` (`"success"`/`"error"`/`"needs_clarification"`), `summary` (non-empty string), `artifacts` (array, optional), `error` (object, optional). The entry role's `finish` ends the run.

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

Two further bounded tools research the run itself rather than a live conversation. They are assigned only to the inquiry handler, whose task names what to look for: roles that already finished have no live conversation to inspect — their work is recorded in the run's `log.jsonl` (see "Persistence"), whose `llm_call` events carry the full conversations (unless the run logged at the `standard` level, which omits those bodies — see "Logging level").

- `read_run_log` — pages over the run's parsed log events in order (`offset`, `limit`, hard-capped); each event carries its log-wide `index`, `timestamp`, `type`, and raw `payload`, plus `totalEvents` and whether more exist after the window.
- `search_run_log` — case-insensitive plain-substring search over each event's raw serialized line (so payload text matches), returning per match the event's `index`/`timestamp`/`type` and a bounded excerpt of the line around the first occurrence; an optional `type` filter narrows the search before matching, matches are hard-capped, and `totalMatches` reports the uncapped count.

A run whose log does not exist yet returns an `unavailable` result from both.

## Native tools

Native tools are implemented in the executor and operate against the mounted workspace. Paths are canonicalized and rejected if they resolve outside the workspace. A typical seed Guild includes:

- `read_file` — read file contents (supports partial reads)
- `write_file` — write or overwrite a file
- `read_plan` — read a run's plan document, capped with a truncation flag (the current run by default, or another run by `runId`)
- `write_plan` — replace the current run's plan document in full (the location is fixed per run; no path parameter)
- `list_directory` — list directory entries
- `repo_map` — symbol-level map of the workspace's TypeScript/JavaScript sources: one line per top-level declaration, grouped by file (tests, declaration files, vendored code, hidden directories, and build output excluded)
- `run_shell` — run a shell command (via `sh -c`, with the workspace as the working directory)
- `typecheck` — run the workspace's typecheck commands and return each command's result separately (see "Checker tools" below)
- `test` — run the workspace's test commands and return each command's result separately (see "Checker tools" below)
- `fetch_url` — fetch a document over HTTP/HTTPS. The `method` parameter selects the backend: `auto` (default) converts the page to markdown through Kagi Extract when `KAGI_API_KEY` is configured, then markdown.new, falling back to a direct fetch of the raw document; `direct` skips conversion (the right choice for API/JSON endpoints); `kagi` and `markdown_new` force a specific backend
- `web_search` — search the web through Kagi, returning ranked results (title, url, snippet, time)

`web_search` and the `kagi` fetch backend are optional capabilities keyed on `KAGI_API_KEY` (environment variable, or a Docker secret at `/run/secrets/kagi_api_key`). The Guild's tool set is static (see "Tool availability"), so without the key the tools stay visible to roles and report an `unavailable` error when called; prompts should treat that as a signal to work from known URLs with `fetch_url`.

Each tool manifest in the Guild declares the name, description, and parameter schema. The executor validates calls against that schema.

### Checker tools

`typecheck` and `test` are the same tool under two names — semantic wrappers over the same subprocess machinery as `run_shell` (one spawn path; see [`docs/architecture.md`](architecture.md) "Tool surface"). Each takes `commands` (required: a non-empty array of non-empty strings) and an optional `timeoutSeconds`. The commands run sequentially in the workspace root, each via `sh -c`. Which commands a workspace's toolchain calls for is decided by the calling role at run time (by surveying the workspace and installing what is missing), never configured in the executor or the Guild. One call is a bounded envelope: at most 16 commands (a longer array is rejected as invalid arguments, mirrored by the manifests' `maxItems`), each under a per-command timeout clamped to the executor's default tool timeout (30 seconds in the shipped deployment), so a single invocation cannot run unbounded work.

The success payload is an array with one entry per completed command: `{ command, exitCode, stdout, stderr }`, with each command's streams truncated by a per-command cap. A non-zero exit code is a normal result to read and iterate on, not an error. A command that outlives its timeout returns a `timeout` error whose message names the failing command and whose details carry the completed entries plus the timed-out entry (marked `timedOut`, exit code `null`, partial output); a command that fails to spawn returns `unavailable` naming it, with the completed entries in the details. Processing stops at the first timeout or spawn failure — later commands in the array are not run — and a command killed by a signal outside the timeout path reports `exitCode: null` like a timed-out one. `timeoutSeconds` is per command and clamped: the caller may lower it below the executor's default tool timeout, never raise it. The whole serialized result is also subject to the engine's `maxToolOutputChars` cap: on overflow it is cut from the tail, so the later commands' entries are the first dropped — batch long output into fewer commands rather than spreading it across many.

## Guild format

The Guild is the entire behavior of the orchestrator described as JSON: role definitions, tool manifests, the entry role name, and the optional visualization section. There is no workflow graph — workflows emerge from roles calling `agent` to invoke other roles. The deployment knobs (model endpoint, executor budgets, context policy) live in a separate deployment file, described under [Deployment configuration](#deployment-configuration); a guild file carrying them (or a `schemaVersion` key) is rejected with a pointer to that file.

### Files

```
deployment/
└── deployment.json        # deployment configuration (model endpoint, budgets, context policy)
guild/
├── guild.json             # top-level configuration
├── prompts/               # role system prompts (Markdown)
└── tools/                 # tool manifests (JSON)
```

System prompts and tool manifests are plain files so the Foundry can rewrite them independently.

### Top-level schema

```json
{
  "entryRole": "orchestrator",
  "roles": { ... },
  "tools": [ ... ],
  "visualization": { ... }
}
```

The optional `visualization` section carries display-only localization the web client reads through `GET /api/config`: `pseudoRoleLabels` (labels for the `human`/`interrupt`/`tools` pseudo-roles the views invent), `operationTemplates` (per-kind, per-source-kind→destination-kind tiered templates that interpolate `{source}` and `{destination}`), `genericOperationTemplates` (per-kind fallbacks), and `workingTemplates` (generic per-participant-kind fallback for the working-state caption when a role/tool has no per-entry `workingLabel`). The executor ignores it; it exists so a swapped Guild re-flavors the diagram without a frontend change. See [`docs/visualization.md`](visualization.md) "Labels".

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
- `label` (object, optional): tiered display name (`{ detailed, friendly, whimsical }`) the web client renders.
- `description` (object, optional): tiered one-line description of the role.
- `workingLabel` (object, optional): tiered text for the "now" caption when this role is the destination of a settled call (its working phase). A `{participant}` placeholder interpolates to the role's own label at the chosen tier — e.g. `"{participant} is planning the approach"` → "Planner is planning the approach". See [`docs/visualization.md`](visualization.md) "Labels".

### `tools`

A list of tool-manifest file paths. Each manifest declares `name`, `description`, and `parameters` (JSON Schema). The executor validates calls against the schema and exposes the tools to the model in the Responses API request. Each manifest also carries optional display fields the web client reads through `GET /api/config`: `humanLabel` (tiered display name), `humanDescription` (tiered one-line description), `humanCallLabel` (tiered template for the operation label when an agent calls this tool — interpolates `{source}` and optionally `{destination}`), and `humanWorkingLabel` (tiered text for the "now" caption when this tool is the active/working node — optionally interpolates `{participant}`). See [`docs/visualization.md`](visualization.md) "Labels".

### Tool availability

The set of tools a role may call is part of the Guild. The executor does not hide tools conditionally — the same Guild is used during Foundry optimization and in production, so the small model always sees the same tool names and schemas.

### Workflows

There is no separate graph or playbook file. A workflow is a role calling `agent` multiple times and combining results before calling `finish`. If the Foundry wants a different workflow, it rewrites the orchestrator prompt or adds/removes roles.

## Deployment configuration

The deployment file `deployment/deployment.json` holds the knobs an operator sets once per deployment: the model endpoint, the executor budgets, the context policy, and the logging default. It is bundled into the image at `/app/deployment/` alongside the Guild and loaded at service startup. Like the Guild it has full-replacement semantics — to change it, mount a different file and point `ORCHESTRATOR_DEPLOYMENT_FILE` at it — and individual fields can also be overridden with environment variables on top of it (see "Environment overrides" below). It is validated strictly: unknown keys are rejected at every level, including nested objects like `generation`, `interruptTriggers`, and `logging` (the file is small and fully known, so a typo must fail loudly), and handler-role fields (`executor.contextHandlerRole`, `executor.inquiryHandlerRole`, `executor.interruptTriggers.handlerRole`, `executor.interruptTriggers.planOwnerRole`) must name roles declared in the Guild. There is no schema versioning; a deployment file that does not match this document fails the load.

The model credential is deliberately absent from the file: an `apiKey` key is rejected with a pointer to the `ORCHESTRATOR_API_KEY` environment variable, which injects the key at runtime (see [`README.md`](../README.md) "Configuration"). Like the Kagi key, it may also arrive as a Docker secret at `/run/secrets/orchestrator_api_key` (or `/run/secrets/ORCHESTRATOR_API_KEY`).

`model.name` and `model.contextWindow` are optional in the file because the service probes the model API's model list (`GET {apiBase}/models`, the OpenAI-compatible listing) once at startup. An API-reported context window — llama.cpp's `meta.n_ctx`, or the top-level `context_length` of rich catalog entries like PPQ's, two interchangeable reports of the same number — is the server's ground truth and always replaces the configured value; the startup log states the override. `model.name` is only discovered from the API when it is unset in both the file and the environment and the server serves exactly one model; if the server lists several models and no name is configured, startup fails with an error listing the served ids so the operator can choose. When the probe fails (unreachable endpoint, timeout, HTTP error, unparseable body) the service boots on the configured values and logs the probe outcome — the endpoint being down is a runtime concern that runs surface as `llm_unavailable` on their own. If a needed field is then still missing, startup fails with an error that says the API did not provide it (distinguishing "could not be probed" from "did not report it") and names where to set it — the deployment file field or its environment variable (`ORCHESTRATOR_MODEL` / `ORCHESTRATOR_MODEL_CONTEXT_WINDOW`).

### Environment overrides

Individual deployment fields can be overridden at runtime with `ORCHESTRATOR_*` environment variables. Precedence is deployment file first, environment variables second: the file is loaded and validated as usual, then each set variable replaces exactly one field of the result — the nested `generation` and `interruptTriggers` objects merge per-field, never wholesale — and the merged deployment is validated again, including the handler-role cross-checks against the Guild, so a bad override fails at startup with the offending variable named. An unset or empty variable means "not set": an override can replace a field's value but never clear it.

| Variable | Deployment field |
|---|---|
| `ORCHESTRATOR_MODEL` | `model.name` (discovered from the API when unset) |
| `ORCHESTRATOR_API_BASE` | `model.apiBase` |
| `ORCHESTRATOR_MODEL_CONTEXT_WINDOW` | `model.contextWindow` (the API-reported value wins) |
| `ORCHESTRATOR_TEMPERATURE` | `model.generation.temperature` |
| `ORCHESTRATOR_MAX_TOKENS` | `model.generation.maxTokens` |
| `ORCHESTRATOR_MAX_AGENT_DEPTH` | `executor.maxAgentDepth` |
| `ORCHESTRATOR_TOOL_TIMEOUT_SECONDS` | `executor.defaultToolTimeoutSeconds` |
| `ORCHESTRATOR_MAX_COMPACTION_ATTEMPTS` | `executor.maxCompactionAttempts` |
| `ORCHESTRATOR_CONTEXT_PRESSURE_THRESHOLD` | `executor.contextPressureThreshold` |
| `ORCHESTRATOR_CONTEXT_HANDLER_ROLE` | `executor.contextHandlerRole` |
| `ORCHESTRATOR_INQUIRY_HANDLER_ROLE` | `executor.inquiryHandlerRole` |
| `ORCHESTRATOR_INTERRUPT_HANDLER_ROLE` | `executor.interruptTriggers.handlerRole` |
| `ORCHESTRATOR_INTERRUPT_EVERY_TOOL_CALLS` | `executor.interruptTriggers.everyToolCalls` |
| `ORCHESTRATOR_INTERRUPT_EVERY_TOKENS` | `executor.interruptTriggers.everyTokens` |
| `ORCHESTRATOR_INTERRUPT_PLAN_OWNER_ROLE` | `executor.interruptTriggers.planOwnerRole` |
| `ORCHESTRATOR_MAX_TOOL_OUTPUT_CHARS` | `contextPolicy.maxToolOutputChars` |

The constraints mirror the file's semantics with the error pointing at the variable: integer-valued fields are positive integers parsed strictly (plain digit strings only — `0x1a`, `1e3`, `8080.0`, and padded values are rejected), `ORCHESTRATOR_TEMPERATURE` must be a finite number, and `ORCHESTRATOR_CONTEXT_PRESSURE_THRESHOLD` must be a number in (0, 1). When the deployment file has no `interruptTriggers` section, introducing one from the environment requires `ORCHESTRATOR_INTERRUPT_HANDLER_ROLE`, `ORCHESTRATOR_INTERRUPT_EVERY_TOOL_CALLS`, and `ORCHESTRATOR_INTERRUPT_EVERY_TOKENS` together, since the section's required fields must all come from the override.

### `model`

```json
{
  "name": "qwen2.5-coder:32b",
  "apiBase": "http://localhost:11434/v1",
  "contextWindow": 32768,
  "generation": { "temperature": 0.2, "maxTokens": 4096 }
}
```

- `name` (optional): the model id sent in Responses API requests. Set it here or via `ORCHESTRATOR_MODEL`; when unset it is discovered from the model API at startup if exactly one model is served, and startup fails listing the served ids otherwise.
- `apiBase`: OpenAI-compatible Responses API base URL; the executor posts to `{apiBase}/responses`.
- `contextWindow` (optional): context window size in tokens. Set it here or via `ORCHESTRATOR_MODEL_CONTEXT_WINDOW`; an API-reported value (llama.cpp's `meta.n_ctx`, or a rich catalog entry's top-level `context_length`) always wins over the configured one, and a value the API also does not report fails startup.
- `generation`: default sampling parameters (`temperature`, `maxTokens`) applied to every role. There is no per-role generation override. `maxTokens` maps to the Responses API's `max_output_tokens`, which includes reasoning tokens, so the value must leave room for the visible answer.

### `executor`

```json
{
  "maxAgentDepth": 8,
  "defaultToolTimeoutSeconds": 30,
  "maxCompactionAttempts": 5,
  "contextPressureThreshold": 0.8,
  "contextHandlerRole": "context_manager",
  "inquiryHandlerRole": "inquiry_responder",
  "interruptTriggers": {
    "handlerRole": "loop_detector",
    "everyToolCalls": 12,
    "everyTokens": 30000,
    "planOwnerRole": "planner"
  }
}
```

Safety budgets enforced by the executor. `maxAgentDepth` guards unbounded agent recursion; `defaultToolTimeoutSeconds` aborts a hung tool subprocess; `maxCompactionAttempts` terminates a `context_manager` that is not reducing tokens. `contextPressureThreshold` (optional, default `0.8`) is the fraction of the effective context budget at which the one-shot pressure response fires (see "Context pressure and handoff"). `contextHandlerRole` (optional) names the guild role the engine invokes to compact a suspended role's conversation — at depth 0 when the entry role crosses the pressure threshold, and at any depth when a request is rejected for context size; when unset, depth-0 pressure falls back to the handoff notice and rejections fall back to the naive in-place backstop. `inquiryHandlerRole` (optional) names the guild role the engine invokes to answer an operator inquiry (see "Interrupt platform"); when unset, the inquiry is dropped and logged (`inquiry_dropped`) and the run continues. The executor does not enforce a wall-clock run timeout or per-role tool-call/token caps — run termination is the deployment container's job (see "Run termination" above and [`docs/architecture.md`](architecture.md) "Run termination").

`interruptTriggers` (optional) configures the interrupt platform's loop-check cadence (see "Interrupt platform"): `handlerRole` is the guild role invoked on a trigger (must exist in `roles`); `everyToolCalls`/`everyTokens` are the base thresholds, scaled by the effort tier's factor (`quick` ×2, `standard` ×4, `thorough` ×6); `planOwnerRole` (optional) names the role that receives plan modifications — the rootmost live chain instance of it, falling back to the chain root when unset or absent from the chain. When the section is absent, cadence checks never fire; operator interrupts work regardless.

### `contextPolicy`

```json
{ "maxToolOutputChars": 4000 }
```

Tool results longer than this are truncated inline. There is no automatic compaction threshold — roles use `context_info` and `edit_context` to manage context.

### `logging`

```json
{ "level": "standard" }
```

Optional section setting the deployment-wide default logging level for run logs (see "Logging level" below): `level` is `"full"` or `"standard"`, and the whole section may be omitted. A per-run choice or the project setting (see `GET|PUT /api/settings`) still overrides it. The section is validated strictly like the rest of the file — an unknown key such as `levels`, or a value that is not one of the two wire strings, fails the load.

## HTTP API

The web UI is the primary interface. The HTTP API exists for programmatic access (e.g. the Foundry). All endpoints return JSON. The server runs one task at a time; there is no queue.

The browser tab title of the served UI is a service setting, not a deployment field: `ORCHESTRATOR_TITLE` (default `Adaptive Orchestrator`) is substituted into the page's `<title>` element when the static handler serves it, so the configured title is present in the initial HTML and an empty value falls back to the default.

### `POST /api/runs`

Starts a run. **Body:** `{ "task": "...", "effort"?: "quick"|"standard"|"thorough", "logLevel"?: "full"|"standard", "continuesFrom"?: "<run_id>" }`. `effort` is optional; when omitted the project default (see `GET|PUT /api/settings`) is applied, falling back to `"standard"` when no default is set. Anything but the three tier strings returns `400 invalid_body`. `logLevel` is optional and picks the run's logging level (see "Logging level"); when omitted it resolves through the same chain — project default, then the deployment file's `logging.level`, then `"full"` — and anything but the two level strings returns `400 invalid_body`. `continuesFrom` starts a new run that continues a prior one; when present it must be a well-formed run id (`run-YYYYMMDD-HHMMSS`) naming a known run whose status is terminal (`success`, `error`, `needs_clarification`, or `interrupted` — a `running` run has no outcome to continue from), and anything else returns `400 invalid_body`. A continuation run records the lineage as `continuesFrom` in its `meta.json` (see "Persistence"), and the executor injects a clearly-marked briefing block into the entry role's initial user message — below the operator's new task text, quoting the prior run's task, its result summary, and the `read_plan` handle for the prior run's plan document — so the Guild can pick up where the prior run left off (the planner reads the prior plan with `read_plan(runId)`); the executor provides the channel only, and the Guild decides what to do with the continuation. **201:** `{ "runId": "..." }`. **409:** `{ "ok": false, "error": "run_in_progress" }`.

### `GET /api/settings`

Returns the project-wide settings. **200:** `{ "effort": "quick"|"standard"|"thorough" | null, "logLevel": "full"|"standard" | null }`. Each field is `null` when no default has been set.

### `PUT /api/settings`

Updates the project-wide settings. **Body:** `{ "effort": "quick"|"standard"|"thorough", "logLevel"?: "full"|"standard" }` — `effort` is required and strict; the optional `logLevel` sets the project-wide default logging level (see "Logging level") and, being absent, clears it (the write replaces the file wholesale). The file is written atomically (write-temp + rename). **200:** the settings as stored. **400:** `{ "ok": false, "error": "invalid_body" }` for a missing or invalid `effort`, or an invalid `logLevel`.

### `GET /api/runs`

Lists known runs (read from `<workspace>/.orchestration/runs/`), newest first. Each entry carries the run id, status, task, effort, start/end times, result card, and error, plus `summary`: an LLM-generated one-line description of the run (`null` when none has been produced). A task-only summary is written to `<run>/summary.txt` shortly after the run starts and is replaced at completion by one derived from the task, the interrupt history, and the result; generation is best-effort and never affects the run.

### `GET /api/runs/:id`

Full run view: status, role activity, recent log. Includes `continuesFrom` — the prior run's id when this run continues one, `null` otherwise (see `POST /api/runs`) — plus `plan` — the run's plan document, the raw Markdown written through `write_plan` and read per request from `<run>/plan.md` (`null` when the run has no plan document) — plus `interruptPending` — whether an operator interrupt is queued for the run's next safe point — and `interrupts`, the history of operator interrupts: each inquiry (an `inquiry`-triggered `interrupt` event) paired with its `interrupt_resolved` — an `answered` resolution with a non-empty summary sets the answer, anything else marks it ended, and no resolution yet leaves it waiting — and each plan modification with its delivery target and aborted list.

The `recentLog` entries are identity rows only: `{ index, timestamp, type, text }` where `index` is the event's log-wide position (the identity the window endpoint pages and serves detail by) and `text` the one-line rendering of the event. Raw payloads and per-event detail sections (the `llm_call` sent/received bodies, tool arguments/results, finish summaries) are deliberately absent — they can carry multi-megabyte bodies, so shipping them on every poll would multiply the run view's size by the number of windows they appear in; fetch them on demand from `GET /api/runs/:id/log`.

### `GET /api/runs/:id/log`

A window over the run's parsed event log, reusing the run-view snapshot read path. Query parameters: `offset` (default `0`), `limit` (default `50`, capped at `500`); a non-integer or negative value falls back to the default, and an offset past the end yields an empty page with the correct `total`. **200:** `{ runId, total, offset, limit, events: [{ index, timestamp, type, payload }] }` — each event carries its log-wide `index`, so a client can page backward and address single events unambiguously.

`?detail=<index>` serves one event's detail sections instead of a window: **200:** `{ index, detailSections }` where `detailSections` pairs the event's heavy bodies under machine labels (`sent`/`received`/`finish reason`/`usage` for an `llm_call`; `arguments` for a `tool_call`; `result` for a `tool_result`; `summary`/`error` for a `role_finished`) and is `null` when the event carries none. An out-of-range or malformed index returns `404 not_found`.

`?format=text` renders the requested page as plain text (one tab-separated line per event: timestamp, type, one-line rendering) with a `content-disposition: attachment; filename="<run_id>.log"` disposition, so export reuses the server-side formatter. Unknown run → `404 not_found`.

### `GET /api/runs/:id/flow`

The run's structured InteractionModel (see [`docs/visualization.md`](visualization.md) "The model"): participants, operations (identities, lifecycle, outcome, and metrics — no detail bodies), run status, and stack records. The model is derived from the run's full log per request. Unknown run → `404 not_found`.

`?operation=<id>` serves one operation's detail markdown instead of the model: **200:** `{ operationId, details }` where `details` is the operation's Markdown body — the delegation task text for a role call, the pretty-printed arguments for a tool call, the full result for a tool return, the question (and context) for an `ask_human` call, the answer or finish summary for a return — or `null` when the operation carries no detail material. An id that names no operation in the current model (e.g. a stale id from an earlier frame) returns `404 not_found`. This is the on-demand surface the web client's inspector fetches when a card opens, so the polled flow model never carries the (potentially large) detail bodies.

### `POST /api/runs/:id/interrupt`

Submits an operator interrupt for the active run (see "Interrupt platform"). **Body:** `{ "kind": "inquiry" | "plan_modification", "message": "..." }`. `inquiry` pauses the run at the next safe point while a fresh `executor.inquiryHandlerRole` instance investigates the suspended roles and the workspace read-only; its finish-card summary is the answer, surfaced in the run view's interrupt history (and the operator's answer card), and the run then resumes. `plan_modification` aborts the live sub-work below the plan owner and delivers the message to it. (A third kind, `notice`, is internal-only — see "Interrupt platform".) **202:** `{ "ok": true }` when queued. **400:** `invalid_body` for a bad kind or empty message. **409:** `{ "ok": false, "error": "run_not_active" }` when the named run is not the active one (terminal, unknown, or no run active).

### `GET /api/run`

Convenience alias for the most recent run (active or last completed).

### `GET /api/questions`

Returns pending `ask_human` questions from the active run.

### `POST /api/answer`

Submits an answer. **Body:** `{ "id": "...", "answer": "..." }`.

### Lifecycle

The server outlives every run. If startup configuration is invalid (an invalid or missing deployment file or Guild, or an invalid `ORCHESTRATOR_*` override), the service binds the port anyway and serves a self-contained error page describing the problem instead of exiting, so the browser shows what to fix; the process still exits non-zero once stopped. On startup, the service reconciles the runs directory: a run left mid-flight by the previous process resumes from its checkpoint under its original run id (at most one), and every run that cannot be resumed is marked `interrupted` (see "Run persistence and resumption"). `SIGINT`/`SIGTERM` trigger graceful shutdown: with an active run, the service submits a wind-down `notice` through the interrupt channel and waits under a bounded timeout (30s) for the run to finish at a safe point; a run still active after the timeout resumes on the next startup from its last checkpoint. The server then stops and the process exits (`130` if a run was still active, `0` if idle).

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
│   ├── meta.json      # run id, guild path, start/end time, status (incl. interrupted), effort, logLevel, final result, continuesFrom (the prior run's id when this run continues one)
│   ├── state.json     # checkpoint: the runnable role stack, written atomically at every safe point; deleted on terminal meta
│   ├── log.jsonl      # one JSON object per line: effort_set, run_resumed, llm calls, tool calls, errors (payload detail per the run's logging level)
│   ├── summary.txt    # LLM-generated one-line run summary (UI label; best-effort)
│   └── plan.md        # the run's plan document (write_plan/read_plan)
└── settings.json      # project-wide settings (the default effort and logging level)
```

The workspace itself holds the final filesystem state (mutated in place). `log.jsonl` is append-only — the executor logs every role start/finish, the parent→child agent-call edges, every LLM turn (its new messages as a delta against the role's previous turn — see "Log events", received response, finish reason, per-call usage), and every tool call/result (raw arguments and the full un-truncated result) so a reviewer can reconstruct exactly what happened from the log alone. `state.json` is the run's resumable state (see "Run persistence and resumption"): present only while a run is live, rewritten at every safe point and on every `role_finished`, and validated on startup before any of it is trusted.

The file tools (`read_file`, `write_file`, `list_directory`, `glob_files`, `search_text`, `repo_map`) refuse the top-level `.orchestration` directory with a `permission_denied` error — it is the executor's bookkeeping, not project content, so a role reading or writing there is always a mistake. The bookkeeping a role legitimately needs is mediated by the dedicated tools instead: `read_plan`/`write_plan` for the run's plan and `read_run_log`/`search_run_log` for the event log.

## Effort channel

The effort channel is a per-run, project-wide speed-vs-quality setting with three named tiers: `quick` (fastest and most direct), `standard`, and `thorough` (slowest and most careful). The three lowercase strings are the wire format everywhere: the HTTP API, `settings.json`, `meta.json`, checkpoints, and the `effort_set` log event all carry them verbatim. The executor provides the **channel only** — it accepts, persists, logs, and injects the tier; it makes no decision about what each tier *means*. The mapping from effort to concrete behavior (generation overrides, review-loop round caps, retry thresholds) lives entirely in the Guild prompts and is tunable by the Foundry, so hardcoding it in the executor would conflict with the Foundry's job.

### Resolution

Effort is resolved once at run submission and is not adjustable mid-run (a second submit while a run is active is rejected as `run_in_progress`):

1. A per-run `effort` in `POST /api/runs` wins.
2. Otherwise the project default from `.orchestration/settings.json` (set via `PUT /api/settings`) is used.
3. Otherwise the default `"standard"` is applied.

### Injection

The entry role (and only the entry role) receives the effort as a system message inserted between its system prompt and the task, so prompts can branch on it. Child roles do **not** receive a global effort directive — the parent decides how to translate effort into delegation instructions. The directive string is a stable contract the Guild prompts depend on:

```
Quality level: <tier> (one of quick, standard, thorough — quick is fastest and most direct; thorough is slowest and most careful).
```

### Surfaces

- `RunMeta.effort` and `GET /api/runs/:id` carry the run's effort tier.
- An `effort_set` event `{ effort }` is logged once at run start, with the tier string as the payload value.
- `GET|PUT /api/settings` read/write `.orchestration/settings.json` atomically; a malformed file is treated as absent (a torn read mid-write must not crash submission).
- The Foundry sets effort per benchmark and ignores the project setting, so benchmark runs are comparable.

## Logging level

The logging level is a per-run choice controlling how much payload detail `log.jsonl` carries. Two levels exist, and the lowercase strings are the wire format everywhere (`POST /api/runs`, `settings.json`, `deployment.json`, `meta.json`, and the checkpoint's entry frame):

- `full` — the default: every event carries its full payload, including each `llm_call`'s complete sent conversation and received response and each `tool_result`'s full un-truncated result.
- `standard` — exactly two slimming rules applied where the event is written; nothing else changes (every event type is still emitted, with identical counts and order):
  - `llm_call`: `payload.sent` and `payload.received` are dropped (with them the `sentFrom` delta marker, which has nothing left to locate); `role`, `messageCount`, `usage`, and `finishReason` are kept.
  - `tool_result`: `payload.result` is dropped; `role`, `tool`, and `kind` are kept.

The kept fields are the ones the UI's derivations read: the flow model and the token budgets consume only identities and `usage`, and the raw-detail toggle simply shows fewer or empty sections for the slimmed events. The trade-off: under `standard` the conversation bodies of finished roles are never written, so the inquiry handler cannot research what a finished role said or received through `read_run_log`/`search_run_log` (both tools still work for the log's structure — event types, kinds, tool names, and usage).

### Resolution

The level is resolved once at run submission and is not adjustable mid-run (a second submit while a run is active is rejected as `run_in_progress`):

1. A per-run `logLevel` in `POST /api/runs` wins.
2. Otherwise the project default from `.orchestration/settings.json` (set via `PUT /api/settings`) is used.
3. Otherwise the deployment default from `deployment.json` (`"logging"."level"`, see [Deployment configuration](#deployment-configuration)) is used.
4. Otherwise the default `"full"` is applied.

The web UI runs this chain once on load to initialize its selector and then pins the resolved level into its per-run submissions, so the deployment tier is honored for API submissions and as the selector's default.

### Surfaces

- `RunMeta.logLevel` carries the run's resolved level (a checkpoint whose entry frame carries no level, if encountered, resumes at `full`).
- The checkpoint's entry frame carries the level, so a restart-resumed run keeps filtering at the same level.
- The filtering wraps the run's `appendLog` leaf once, in the service's per-run bindings — every event the executor and the human backend emit funnels through it, and no event emitter knows the level.
- `GET|PUT /api/settings` read/write the project default alongside `effort`.
