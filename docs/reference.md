# Reference

Detailed reference for the executor runtime, Guild format, deployment configuration, HTTP API, and benchmark workspaces. For the high-level architecture, see [`docs/architecture.md`](architecture.md).

## Executor runtime

The executor is the minimal runtime that runs the small target model against the Guild. It loads the Guild, invokes the entry role, dispatches tool calls, enforces safety budgets, and persists what happened. It makes no domain decisions — it does not understand "planner," "coder," or "compaction agent." Those are roles in the Guild.

### Run lifecycle

1. **Initiation.** The executor creates `<workspace>/.orchestration/runs/<run_id>/` for bookkeeping, loads the Guild, and starts the entry role with an initial history whose current task is the operator's task; a run that continues a prior one also opens with the prior task and terminal result as reference turns before that current-task user message. The workspace is modified in place — no copy is made.

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

Each role invocation has its own message list. A role does not automatically see its ancestors' conversations — parents may include summaries or result cards when delegating via `agent`. Messages have `role` (`system`/`user`/`assistant`/`tool`), `content`, optional `reasoning`, and tool-call fields. A run that genuinely continues a prior one opens its entry role's history with the prior operator task as a user turn and the prior terminal result as an assistant turn, before the new task's user message: the assistant turn is synthesized from the prior meta's status, result card (summary, artifacts, and surfaced error message), and run-level error when present, and is always non-empty so the turn boundary survives the wire mapping; the raw technical detail is deliberately excluded from model history. The new user message then carries only the follow-up task, a marker naming the prior run and its `read_plan` handle, the queue briefing, project docs, and the git notice. A first queue dispatch (briefing only, no prior run) and a child role get no prior-run reference turns. Reasoning is retained in the history and replayed to the model every turn: each assistant message that carries reasoning is sent as a reasoning input item (`{type: "reasoning", content: [{type: "reasoning_text", text}]}`) placed before that turn's message and function-call items. Nothing drops reasoning automatically — not context pressure, and the compaction backstop only as a last resort (see "Context budget exceeded" below) — and the executor ships no `includeReasoning` flag; outside that backstop the only way to remove reasoning is the guild's deliberate `edit_context` `strip_reasoning` op (see "Built-in tools"). Unknown role keys — including the removed `includeReasoning` — are rejected at load with a validation error naming the key, so a stale guild file fails fast with a clear message; the flag's removal changed behavior: reasoning is now always retained and replayed, even for guilds that previously relied on the old strip-by-default behavior.

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

1. The oldest turns are dropped (the protected prefix — the system prompt, any prior-run reference turns, and the current task — and the most recent turn are always kept), never splitting an assistant tool call from its tool-result messages — an unmatched pair is a malformed request on OpenAI-compatible endpoints.
2. Surviving tool results that are still oversized are truncated.
3. Only when the estimate is still over target, reasoning is stripped from the oldest surviving messages after the protected prefix, one at a time, until the estimate fits or no strippable reasoning is left — the protected prefix and the last assistant message keep their reasoning.

Reasoning is replayed to the model every turn (see "Messages and context" above), so stripping it silently rewrites what the model believes it decided; the backstop accepts that cost only after dropping and truncating cannot fit, and shedding reasoning proactively remains the guild's deliberate choice via the `edit_context` `strip_reasoning` op.

The token estimate is calibrated with the prompt-token count the endpoint reported in its rejection (falling back to ~4 chars/token when it reports none) and the compaction target is 70% of the context window, leaving headroom for estimator error and the completion reservation. The compaction is logged as a `context_compacted` event, and the role resumes with a `[Platform notice — context window exceeded]` user message describing what was removed, so it can re-read what it needs or finish honestly.

Recovery is bounded either way: after 3 consecutive rejections — or immediately, when even the undeletable remainder cannot fit — the role finishes with `{status: "error", error: {kind: "context_budget_exceeded"}}` and the parent recovers (the seed Guild re-delegates the work in smaller pieces via `recovery`). A successful call resets the counter.

Separately, a role may manage its own context ahead of the limit with `context_info` and `edit_context`. If a role calls `edit_context` repeatedly without reducing tokens, the executor terminates it after `executor.maxCompactionAttempts`.

### Compaction and the prompt cache

Between compaction events a role's history is append-only, and reasoning is replayed to the model every turn (see "Messages and context" above). Server prompt caches re-prefill from the first differing token, so continuous history editing would re-prefill the whole suffix every turn, while an append-only turn pays only for its new tokens. All edits the backstop makes therefore coalesce into a single compaction event, and the earliest edit defines the refill — edits after it are cache-free; a rewrite the context manager makes through `edit_context` is not part of that coalescing, because those rewrites are themselves compaction events, agent-decided and each counting as the event. The backstop strips reasoning only as a last resort, oldest first across the surviving messages after the protected prefix, and never from the final assistant message (see the numbered list above; the protected prefix — system prompt, any prior-run reference turns, and current task — carries no reasoning in practice). During agent-driven compaction it is the seed Guild's `context_manager` role that decides reasoning policy. A model change forces a cache refill regardless, which makes a coalesced deep rewrite free at that boundary.

### Error handling

Every failure is translated into a structured result the current or parent role can act on. The executor never halts unless the entry role itself cannot recover.

| Failure | Behavior | Surface |
|---|---|---|
| LLM HTTP error | Retry with backoff | If retries fail: `{status: "error", error: {kind: "llm_unavailable"}}` |
| LLM endpoint failure or empty completion (`finish_reason: "error"`, or a response with no content and no tool calls) | Retried with backoff like an HTTP error; `finish_reason: "length"` with no content fails immediately (the completion budget was consumed before any content — raise `generation.maxTokens`) | `{status: "error", error: {kind: "llm_unavailable"}}` |
| LLM endpoint stalls (no response headers within 30s; or an open stream sends no bytes within 120s) | The attempt is aborted and retried with backoff like a network failure. The stream bound is an idle timeout reset on every streamed chunk — not an overall deadline — so a slow generation that keeps producing bytes is never aborted (slow local hardware on CPU inferencers is a supported deployment) | `{status: "error", error: {kind: "llm_unavailable"}}` |
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

**Checkpoint contents.** `state.json` holds the full depth-first stack, root first: for each live role, its context (role, depth, task, parent, effort and involvement), its instance id, its complete `RoleState` (history, tool-call count, token accumulators, loop-check watermarks, context-pressure/compaction state, the llm_call delta baseline so a resumed role continues logging deltas instead of re-logging its whole conversation), and, on a frame stopped mid-dispatch (including a suspended ancestor awaiting a child), a `pending` invocation record — the turn's full `toolCalls` list, the `index` of the call being dispatched, that call's `callId` and `parentCallId`, and, for a child-spawning call, the child's result card once it has finished (`childCard`). The record covers ordinary tools, `ask_human`, and child-spawning calls alike; calls before `index` are already in the persisted history, and calls after it dispatch on resume. A legacy record carrying `childIndex` instead of `index`/`callId` is still read as the old child-suspension shape. The entry frame also carries the run's logging level (see "Logging level"), so a resumed run keeps filtering its log at the same level. It also carries the run id, the original start time, the registry id counter, and the learned context ceiling, so the resumed run mints non-colliding instance ids, keeps the tightened pressure threshold, and preserves budget accumulators and elapsed-time accounting — a resumed run cannot exceed its budget by forgetting prior usage. A paused checkpoint may additionally carry `parkedAsk` — `{ roleId, toolCallId, callId?, questionId?, question }` — naming the leaf role and the `ask_human` call whose tool result the queue answer will replace on resume (see "Parking: the pre-write rule" in [`docs/queueing.md`](queueing.md)). The optional `callId` and `questionId` are the invocation identity allocated for the ask and are absent on legacy checkpoints. A root direct clarification finish is the other pause shape: its checkpoint is kept but carries no `parkedAsk`; when its answer is delivered the checkpoint also carries `clarificationAnswer` — `{ id, question, answer, consumed? }` — recording the note already appended to the leaf history. Its id makes a retry idempotent. `consumed` is absent when the note was checkpointed but the running meta had not yet landed, and becomes true once the run starts; the queue uses the distinction to retry an answer that never started while treating a consumed same-question re-pause as delivered. A delivery record may coexist with a later `parkedAsk`, and `readPauseStateById` gives the parked ask precedence.

**When it is written.** At every leaf safe point (the same drain point the interrupt platform uses, once per turn), when a child card returns, before each dispatch, and at a completed batch: before a tool call starts the executor records its pending invocation and writes the checkpoint, then emits the start event (`tool_call`, or `ask_human` for an ask); after the result it emits the matching terminal (`tool_result`, or `human_answer` for an ask). The pending marker is cleared and the checkpoint rewritten only once the call is the last of its turn, the role is ending, or the whole batch is complete, so an intermediate result leaves the marker on disk for replay. Every checkpoint therefore names each in-flight invocation with a pending marker and leaves no assistant tool-call turn partially answered without one. A root role whose final card is `error` or `needs_clarification` also writes a final checkpoint after the completed turn's tool results are recorded and before the frame leaves the recorder, so a batched `agent` plus `finish` turn has no pending call when the answer note is resumed. The extra write is gated on a completed finish turn: the last assistant tool-call message carries a `finish` call and a consecutive tool result for every call in that message, with nothing after those results. A `finish` followed by later calls qualifies because dispatch has already closed those calls with `interrupted` results and included them in the batch. The post-answer continuation write uses the same completed-finish test when the continued turn ends with a `finish`. Writes are atomic (temp file + rename), so the on-disk checkpoint is never torn — a crash mid-write leaves the previous, complete checkpoint. Writes are suppressed while a handler invocation (loop-check, context, or inquiry handler) is on the stack: a handler interlude is atomic with respect to the checkpoint, so a restart either sees its fully-applied effects or re-runs the drain. At the park moment the parked role writes one checkpoint carrying the live turn and the ask's tool result, then freezes the recorder: the unwinding ancestors' later writes cannot overwrite it, and it is the exact state the queue answer re-enters. When the answer is delivered, the recorder unfreezes; the next dispatched remaining call then writes its pending checkpoint before dispatch (or, when none remain, the completed-boundary write follows), so the frozen parked checkpoint stops being the recovery point as soon as that write lands. A crash mid-batch therefore either still looks parked, so the queue's answer-pending rule retries delivery, or a subsequent write has recorded the in-flight call as a pending invocation, so resume reconciles that call instead of leaving it open. On a clarification answer the executor appends the framed note and its `clarificationAnswer` id to the checkpoint and writes it before the running meta, so a crash after the meta cannot resume a checkpoint that lost the answer; a retry with the same id appends nothing. After the running meta lands the delivery is marked consumed in memory, so subsequent writes persist that the run started; boot and error resumes carry an existing delivery record forward and mark it consumed the same way. A `human_answer` event is emitted only when this resume appended the note, not on an idempotent replay. At a true completion the executor deletes the checkpoint for `success`, but keeps it for `error` (so the operator can explicitly resume an error run with its full context) and for every run-terminal `needs_clarification` — a parked ask or a root direct finish — because at run level that status is a pause and the queue answer must resume the same run; startup reconciliation auto-resumes neither. An `interrupted` run keeps no resumable path: reconciliation considers only runs whose meta reads `running`, and the resume endpoints reject a non-error meta. A run reconciliation marked `interrupted` keeps whatever checkpoint it had on disk (reconciliation has no delete dependency), making it an inert artifact; a parked run the operator terminates from the queue is also marked `interrupted`, but its checkpoint is deleted outright so it can never be answered.

**Resume.** There are three checkpoint re-entry paths: startup reconciliation (automatic), explicit error resume, and the queue answer; a user-initiated Continue starts a new run with reference turns rather than re-entering a checkpoint. On startup, the service scans the runs directory: a run with no terminal meta (none, or one still `running`) and a valid checkpoint resumes under its original run id — the stack is reconstructed (suspended parents re-register with their preserved ids and pending turns, the leaf re-enters at its loop top) and the depth-first traversal continues. A child that was mid-flight is re-entered; a child that had already finished is not re-run — its recorded card is delivered to the parent as the suspended `agent` call's tool result. Resumed roles do not re-emit `role_start` (their start events are already in the log); a `run_resumed` event marks the restart boundary. Only one run resumes (one task at a time): the most recent resumable run.

The second path is explicit: `POST /api/runs/:id/resume` re-enters an **error**-ended run from its kept checkpoint, on the operator's command only (see the HTTP API below). The restored run keeps its own run id, original start time, effort, involvement, and log level, and the resume re-asserts a `running` meta from them — the terminal error card is replaced in the live meta (it remains in the log) and the run continues from its full conversation. An error resume never accepts a checkpoint carrying `parkedAsk`: a parked checkpoint belongs to the queue answer.

The third path is the queue answer (see "Parking: the pre-write rule" in [`docs/queueing.md`](queueing.md)): `POST /api/queue/:id/answer` on a paused `needs_input` item re-enters the same run under its own id with the answer. For a parked ask the engine finds the last history message carrying the parked tool-call id, replaces only its content with the serialized `{question, answer}` tool result (the conversation prefix, and its prompt cache, is unchanged), logs `human_answer` with `{ id, callId, question, answer }`, clears `parkedAsk`/`parkedQuestion`, and continues the parked assistant turn from the call after `ask_human` — a batched turn's remaining calls dispatch exactly as the blocking path would. For a root direct clarification finish there is no call to replace and the question may not be in the checkpoint, so the resume appends a framed note carrying both the question and the answer, records its id as `clarificationAnswer` on the checkpoint, and writes that checkpoint before the running meta; a retry with the same id does not append again. It logs `human_answer` with `id: "clarification"` after the resume boundary. The queue restores the run's queue-tracked mark so a later pre-write ask parks again; boot and error resumes do not. A `success` terminal deletes the checkpoint; `error` keeps it so the run remains explicitly resumable, and every `needs_clarification` pause (park or direct finish) keeps its checkpoint. When no matching checkpoint exists (a legacy parked run), the queue falls back to dispatching a new briefed continuation with the question and answer, and re-points the item's lineage at the run that could not be resumed. If the item's own run has already terminated as anything other than `needs_clarification` (an operator termination), answering returns the item `cancelled` and discards the answer without dispatching or resuming; the termination cleanup deletes the leftover checkpoint and appends the `run_terminated` event. The boot repair for a `needs_input` item whose run meta reads `interrupted` performs the same cleanup before cancelling the item.

**Invocation reconciliation.** Before any resumed role re-enters its loop, resume seeds the invocation journal from the existing log and closes the invocations the crash left unresolved.
A checkpoint's pending invocation is reconciled first: if the log already carries a terminal (`tool_result` or `human_answer`) for its `callId`, the recorded result is appended to the restored history exactly once and the terminal is not rewritten; otherwise the call is re-dispatched under the recorded id.
If the reconciled call returns a final card while later calls in the batch never ran, those calls are closed with `interrupted` results so the assistant turn is fully answered before the completed checkpoint is written.
Identified starts that no checkpoint covers — a handler role, tool, ask, or interrupt caught mid-flight — are then closed with interrupted terminals (an error `role_finished`, an interrupted `tool_result`, a `human_answer` stating no answer was recorded, or a failed `interrupt_resolved`), except a start belonging to a live checkpoint role or the parked ask awaiting its answer.
The planning is idempotent, so a resume that runs twice does not duplicate a terminal.
A `role_finished` carrying `paused: true` is never treated as a terminal here; a `needs_clarification` finish without `paused` is an ordinary terminal.

**Old checkpoints and slim logs.** A checkpoint written before the pending-invocation record existed has no such marker and keeps the previous resume behavior; its legacy `childIndex` child suspension remains readable.
At `standard` logging a replayed `tool_result` has no result body: a successful `finish` is reconstructed from its tool-call arguments, a finish whose retained kind is an error becomes an error placeholder and does not end the role, and any other result is restored as a clearly marked placeholder carrying the retained kind. Only a result with neither a body nor a valid kind fails fast.

**Reconciliation.** A parked checkpoint is not a resumable run: when a crash left the run meta `running`, reconciliation terminalizes it as `needs_clarification` with the park summary, leaves the checkpoint on disk, and records it in the reconciliation's parked run ids so the boot queue tick can settle or retry the item. Only this crash-parked case appears in that report; a normally parked run already has a `needs_clarification` meta and is skipped by reconciliation. A run that cannot be resumed — missing or corrupt checkpoint, or superseded by a newer resumable run — is marked `interrupted`: a terminal `meta.json` with `status: "interrupted"`, an `error: { kind: "interrupted", message }` recording why, and its original fields preserved. `interrupted` is a terminal status everywhere (run list, run view, flow model), rendered error-toned, so the UI never shows an abandoned run as perpetually "in progress". Reconciliation and operator termination both write `interrupted`: reconciliation abandons a run that cannot be resumed, while an operator termination ends a parked `needs_input` run, preserves its parked `endTime`, appends a `run_terminated` event stamped with the actual termination time, and deletes the checkpoint; a retry after a crash between the meta write and that cleanup re-deletes the checkpoint and re-appends the event, so the log may carry a duplicate. Because the write is atomic, even a hard kill (`docker kill`, `kill -9`) mid-checkpoint-write still resumes — the on-disk file is always a complete checkpoint — so reconciliation's `interrupted` is normally expected only when no valid checkpoint ever existed (a crash before the run's first safe point or genuine disk corruption); operator termination is the other, deliberate source. A kill mid-write may leave a `state.json.<pid>.tmp` artifact in the run directory; it is ignored and overwritten by later checkpoint writes.

**Caveats.** Checkpoint granularity is the invocation: a pending tool, ask, or child call is reconciled on resume, while an in-flight LLM call is replayed from the last safe point — replayed tool side effects already applied to the workspace are not rolled back, and a few log events may duplicate straddling a restart boundary (`log.jsonl` is append-only and is never rewritten). Pending operator interrupts and pending human questions are in-memory and lost on restart; the operator can resubmit. Resuming against a changed Guild is not a supported migration — a role that no longer exists finishes with an error card that unwinds the run.

### Log events

`log.jsonl` is append-only and carries one JSON object per line. Each event has `timestamp`, `type`, and a `payload` whose shape depends on the type. Invocation-lifecycle events carry optional `callId` and `parentCallId` identity fields; old logs omit them, and the flow adapter selects its id-based projection as soon as an invocation start carries a `callId`. The role-tree and per-turn detail events are:

- `role_start` — `{ role, roleId, callId, depth, task, parent?, parentRoleId?, parentCallId?, continuedFrom? }`. Emitted when a role begins, after its definition is confirmed to exist and the instance is registered. `roleId` is the role-instance id (see "Interrupt platform") and `callId` is `role:<roleId>`; `parent` is the calling role's name and `parentRoleId` its instance id, both omitted for the entry role at depth 0; `parentCallId` names the invocation that caused this role — the caller role's `role:<roleId>` or, for a handler, the `interrupt:<id>` that preempted the target — and is absent for the entry role. `continuedFrom` is present only on an instance started by `continue_agent` and names the finished instance it was seeded from. A refused `agent` call (depth exceeded or unknown child) emits no `role_start` for the never-run child.
- `effort_set` — `{ effort }`. Emitted once at run start, before the entry role begins, recording the run's chosen effort tier (`quick`, `standard`, or `thorough`; see "Effort channel").
- `involvement_set` — `{ involvement }`. Emitted once at run start, right after `effort_set`, recording the run's chosen human-involvement level (`autonomous`, `early-engagement`, or `collaborative`; see "Involvement channel").
- `workspace_dirty_at_start` — `{ count }`. Emitted once at run start when the workspace's git repository has uncommitted changes, carrying their count; the entry role's git-state notice tells it to familiarize itself with them before planning (see "Git tools"). Not emitted for a clean repository or a non-repository.
- `role_finished` — `{ role, roleId, callId, depth, status, summary?, error?, parent?, paused? }`. Emitted when a role returns a final card. `callId` is the role invocation's `role:<roleId>`; `status` is the `ResultCard` status; `summary` is the role's own explanation of its result (so a reviewer reading only the log can see why a role errored, rather than only that it did); `error` is the structured `{ kind, message?, details? }` when the card carried one; `parent` is omitted for the entry role. A `needs_clarification` finish sets `paused: true` only when it actually pauses the run: a root `needs_clarification` finish (direct clarification) or any role finish in a parked stack (`parkedAsk` set). A paused finish is a pause marker, not the invocation's terminal: the role invocation stays open and the later answer resume emits its true terminal. A non-root child or handler that finishes `needs_clarification` without pausing the run is an ordinary terminal and carries no `paused` flag. A role invocation is closed by a non-paused `role_finished`, so a resumed role does not re-emit its start and its eventual finish closes the original start.
- `agent_call` — `{ parent, child, depth }`. Emitted when the `agent` or `continue_agent` tool is invoked, before the child runs, carrying the parent→child edge even for callers that do not read `role_start` (a continuation is additionally marked by `continuedFrom` on the child's `role_start`). It is a diagnostic edge and carries no invocation ids; the child's `role_start`/`role_finished` and the enclosing tool lifecycle are the authoritative identified events.
- `llm_call_start` — `{ role, roleId }`. Emitted immediately before the LLM request is dispatched, on every turn (including the paths that later fail: `llm_unavailable` and `context_budget_exceeded`). It marks the turn in flight the moment the request is sent, so the flow view can end the call's transit phase (flowing edge → solid) when the callee begins working rather than when the response completes. `roleId` is the role-instance id the `role_start` event carries, so the in-flight turn is attributable to its instance; the full turn (message list, response, usage) lands in the succeeding `llm_call`.
- `llm_call` — emitted only on success paths (a turn that returned content/tool calls or finished). Payload: `{ role, roleId, messageCount, sentFrom, sent, received, usage, finishReason? }`. `roleId` is the role-instance id the `role_start` event carries, so a role's turns are groupable per instance even when it spawns a same-named child. To keep the log's growth proportional to the work done rather than quadratic in the turns, `sent` is a delta of the role's conversation: only the messages the request added since the role's previous `llm_call` event (each message's `role` and `content`; reasoning omitted; `tool_calls` on assistant messages included). `sentFrom` is the conversation index `sent[0]` starts at, and `messageCount` is the full request's message count, so a full snapshot is `sentFrom: 0` with `sent.length === messageCount` — the shape of a role's first `llm_call`, and of the first one after anything rewrote the conversation out from under the delta baseline: an `edit_context` operation (`drop`, `strip_reasoning`, or `replace` — a content change would be invisible in a slice) or a platform compaction forces the role's next `llm_call` back to a full snapshot. An `llm_call` without `sentFrom` is a full snapshot by definition. A turn's full conversation is reconstructed by walking the log backward from the event, folding the deltas of the same role instance (matched on `roleId`, falling back to the `role` name when `roleId` is absent): track the still-uncovered start (initially the event's `sentFrom`); each earlier same-instance `llm_call` contributes `sent.slice(0, max(0, uncovered − sentFrom))`, clamped to that slice's length — its own absent `sentFrom` reading as 0 — and lowers the uncovered start to its `sentFrom`; stop when the uncovered start reaches 0. Each request is its predecessor's plus appended messages, so the folded slices are exactly the request a full snapshot would have carried, and `GET /api/runs/:id/log?detail=` performs this fold server-side, so the raw-detail view is identical for delta and full-snapshot logs. `received` is the assistant response actually received: `content`, `reasoning` (if any), and the parsed `toolCalls` (each call's `id`, `function.name`, and `function.arguments`). `usage` carries `promptTokens`, `completionTokens`, `totalTokens`, and `cachedPromptTokens` (when the endpoint reports a cached share), and is omitted entirely when the endpoint's terminal payload carried no usage object at all — endpoint silence stays distinguishable from a reported zero, and the token totals simply skip what was never reported (a present-but-partial usage object still degrades its missing fields to 0, since that is endpoint-reported data). `finishReason` is the OpenAI `choices[0].finish_reason` (e.g. `stop`, `length`, `tool_calls`, `content_filter`), absent when the endpoint omits it so "absent" is distinguishable from "model stopped". Under the `standard` logging level the `sent` and `received` bodies are omitted from the payload (with them the `sentFrom` delta marker, which has nothing left to locate); `role`, `roleId`, `messageCount`, `usage`, and `finishReason` are kept (see "Logging level"). The `llm_unavailable` and `context_budget_exceeded` paths log their own dedicated events and do not emit a misleading `llm_call`.
- `llm_retry` — `{ role, roleId, discardedAttempts, usage? }`. Emitted at most once per successful call, on the success paths, when the LLM caller discarded completed retry attempts behind the successful turn: an attempt that ran to a completed terminal (billing at least the full prompt) but was thrown away for a degenerate empty response and retried. `discardedAttempts` counts every discarded completed attempt, and `usage` — shaped exactly like the `llm_call` usage — sums what those attempts reported; it is omitted when none of them reported usage, so endpoint silence never masquerades as a billed zero (a reported zero, including a cached-tokens-only report, is endpoint data and is kept). Emitted before the turn's `llm_call`, whose own usage stays the final attempt's, so pressure and context semantics keep reflecting the live conversation size; retry spend is separate bookkeeping. Attempts failing before completing (stream failures, failed connects) contribute nothing to the event, and no `llm_retry` fires for a call with no discarded attempts — including a call whose every retry failed before completing.
- `summarizer_llm_call` — `{ usage }`. The run's one-line summary generation — a service-level background call reusing the run's model endpoint, not a role turn (see `GET /api/runs`) — consumed tokens: `usage` is shaped exactly like the `llm_call` usage and is logged against the run whose summary was being produced. The event is not emitted for a call the endpoint answered without a usage report, and not for a failed call.
- `tool_call` — `{ role, tool, arguments, callId, parentCallId }`. Emitted when a tool invocation starts. `arguments` is the raw JSON-arguments string the model passed, so the exact parameters are recoverable; `callId` is `tool:<id>` (the model's tool-call id, or a generated one when it is empty or reused) and `parentCallId` is the invoking role's `role:<roleId>`.
- `tool_result` — `{ role, tool, kind, result, callId }`. Emitted when a tool invocation settles. `result` is the full un-truncated `ToolResult` (`{ kind: 'success', data }` or `{ kind, message, details }`); `callId` is the matching `tool:<id>`. Truncation still applies only to what is appended to the conversation; the log records the un-truncated result so a reviewer is not flying blind on what a tool returned. Under the `standard` logging level the `result` body is omitted from the payload but `callId` and the other identity fields are kept (see "Logging level").
- `ask_human` — `{ id, callId, parentCallId, question, context?, parked? }`. Emitted when an `ask_human` invocation starts waiting: `id` is the question id (the tool-call id), `callId` is `tool:<questionId>`, and `parentCallId` is the asking role's `role:<roleId>`. A queued pre-write ask additionally sets `parked: true`. An ask that reaches its handler uses this `ask_human`/`human_answer` pair as its lifecycle and emits no generic `tool_call`/`tool_result` pair; an ask rejected before the `ask_human` event, and a call prevented by an earlier final card, instead close with a generic `tool_call`/`tool_result` pair carrying the rejection result or an `interrupted` result respectively.
- `human_answer` — `{ id, callId, answer, question? }`. Emitted when an answer resolves an `ask_human` invocation. The blocking web backend logs `{ id, callId, answer }` (its matching `ask_human` event carries the same `id` and `callId` and no `parked` flag). The queue answer resume for a parked ask delivers into that call and logs `{ id, callId, question, answer }`; `id` is the parked question id and `callId` its `tool:<questionId>`, pairing with the `ask_human` event that carried `parked: true`. The clarification-answer resume appends the note and logs the same shape with the synthetic `id: "clarification"` and `callId: "tool:clarification"`, since a direct finish has no `ask_human` call in the checkpointed conversation; an idempotent replay that appends nothing does not re-log the event.
- `depth_exceeded` — `{ parent, child, depth, error }` when an `agent` call is refused for exceeding `maxAgentDepth`.
- `role_not_found` — `{ roleName }` for an unknown entry role, or `{ parent, roleName }` when a child role name is invalid.
- `interrupt` — `{ trigger, handler, target, message?, callId, parentCallId }`. Emitted when the engine suspends the active role to invoke a handler role. `callId` is `interrupt:<id>` and `parentCallId` is the preempted target role's `role:<roleId>`. `trigger` is the source (`loop_check` for the cadence, `context_pressure` when the entry role is compacted at the threshold, `context_budget_exceeded` when a rejection is answered by the context handler, `inquiry` for an operator question), `handler` the handler role name, `target` the suspended role-instance id; the `inquiry` trigger additionally carries `message`, the operator's verbatim question. The interrupt preempts the active call stack in the interaction model: a new stack pauses the previous one, rooted at a fresh participant — a synthetic interrupt instance, or a fresh human asker for an inquiry (the person asking is that stack's caller). Subsequent `role_start`/`role_finished`/`llm_call`/`tool_call`/`tool_result` events (the handler's) belong to the interrupt stack until its root call closes, at which point control returns to the preempted stack.
- `interrupt_resolved` — `{ trigger, handler, target, action, handlerStatus?, summary?, callId }`. Emitted after the handler finishes and carries the `callId` of the interrupt it resolves. For `loop_check`, `action` is the applied `trigger_interrupt` decision (`continue`, `redirect`, or `abort`; `continue` also when the handler finished without deciding). For the context-compaction triggers, `action` is `compacted` when the handler succeeded and `failed` otherwise (`failed` carries `handlerStatus`; the role then falls back to the handoff notice or the naive backstop). For `inquiry`, `action` is `answered` with `summary` carrying the handler's finish-card summary — the answer shown to the operator — or `failed` with `handlerStatus` and `summary` when the handler itself errored.
- `operator_notice` — `{ role, roleId, message }`. An operator notice (the graceful-shutdown wind-down, or a future platform directive) was injected as a marked user message into the history of the named role (always the chain root — the entry role). A notice is a directive to act on, not a question to answer.
- `inquiry_dropped` — `{ message, reason }`. An operator inquiry arrived but `executor.inquiryHandlerRole` is not configured: the question is dropped and the run continues — a run is never killed over a question.
- `plan_modification` — `{ target, targetRole, message, aborted }`. An operator plan modification was routed: `target`/`targetRole` are the instance id and role name of the plan owner that received the modification, `aborted` the instance ids unwound below it (each finishes with an `interrupted` error card).
- `observe` — `{ role, roleId, details }`. Emitted between a `tool_call` and its `tool_result` whenever a read-only cross-role inspection tool (`list_role_messages`, `read_message_window`, `search_role_blocks`, `recent_role_tool_calls`, or cross-role `context_info` — never `edit_context`, which mutates) successfully reads another live role instance: `role`/`roleId` name the observed instance (the open call being read on a paused stack), `details` the tool name. A read-only cross-stack reference in the interaction model: the adapter sources the observe at the tool emitting it and points it at the matched paused node, and it never affects activity.
- `terminate` — `{ role, details? }`. A rewind reference in the interaction model: `role` names the open call being reverted on a paused stack; the terminate closes that call immediately (no separate return) so the node is removed right away. *(Adapter-supported; no current executor tool emits this.)*
- `context_compacted` — `{ role, droppedMessages, truncatedToolMessages, strippedReasoningMessages, estimatedPromptTokens, contextWindow }`. The executor compacted the role's conversation after a context-window rejection (see "Context budget exceeded" above).
- `context_pressure` — `{ role, promptTokens, effectiveBudget }`. The role's reported prompt size crossed the pressure threshold; the one-shot handoff notice is appended at the next turn boundary (see "Context pressure and handoff" above).
- `run_resumed` — `{ runId, resumedFrames, operatorNote? }`. Emitted once when a run resumes from its checkpoint, ahead of any resumed-role events; it marks the boundary between the pre-restart and post-restart portions of the log (see "Run persistence and resumption"). `operatorNote` is present only on an explicit resume of an error-ended run and carries the operator's framed note (see `POST /api/runs/:id/resume`). A queue answer resume emits `run_resumed` without a note (the answer itself is the `human_answer` event). Resumed roles do not re-emit `role_start`, and a few events immediately straddling the boundary may duplicate.
- `run_terminated` — `{ reason, message }`. Emitted when the operator terminates a parked `needs_input` run from the queue; `reason` is `operator` and `message` states that the run was terminated while waiting for an answer. The run's meta is rewritten `interrupted` with `{ kind: "interrupted", message }` while preserving its parked `endTime`, the event's `timestamp` records the actual termination time, and its checkpoint is deleted. The event is best-effort: a crash retry after the meta write re-appends it, so the append-only log may contain a duplicate.
- `role_budget_exceeded`, `global_budget_exceeded`, `llm_unavailable`, `context_budget_exceeded`, `implicit_finish`, `unknown_tool`, `invalid_tool_call` — failure and lifecycle events carrying the role and the relevant detail.

## Tool dispatch

Tool dispatch is the mechanism by which the executor invokes a tool in response to a model tool call. `createToolDispatch(handlers)` is a factory that takes a map of tool-name → handler and returns a `ToolDispatch`; its `dispatch(call)` looks up the handler, parses the call's JSON arguments, rejects anything that is not a JSON object, and invokes the handler with the parsed arguments and the originating `ToolCall` (so a handler such as `ask_human` can record the call id it parks on). Errors are returned as a `ToolResult` carrying the appropriate kind (`unknown_tool`, `invalid_arguments`), never thrown, so a malformed call is a normal result the role can read and act on.

`dispatchToolCall(config, call)` wraps that dispatch with the role-scoped checks the engine performs first: a name absent from the Guild's manifests is `unknown_tool`, and a name the role is not allowed to call is `invalid_tool_call`. The engine composes the handler map from the built-in tools (below) and the native tools, so every tool a role can call is reachable through the same dispatcher. Tool dispatch is pure orchestration and is fully testable with fake handlers.

Dispatching a tool in the engine is a durable lifecycle, not just a handler call.
Before dispatch the engine records the pending invocation — `callId`, `parentCallId`, the turn's `toolCalls`, and the current `index` — and writes the checkpoint; only then does it write the `tool_call` start event.
After the handler returns it writes the `tool_result` terminal.
A dispatched `ask_human` is the exception: its handler writes the `ask_human` and `human_answer` events instead of the generic pair, while the same pending-before-start and terminal-before-clear durability applies.
The pending marker is cleared and the checkpoint rewritten when the call is the last of its turn, when a final card ends the role, or when the batch is otherwise complete; an intermediate result leaves the marker on disk so a crash replays that call and then continues at the next one.
When a final card (typically `finish`) ends the role before later calls in the same assistant message have run, the engine closes each remaining call with an `interrupted` tool result (`tool_call`/`tool_result` pair) so the persisted turn has no unanswered call.

## Built-in tools

Built-in tools are listed in the Guild like any other tool but are implemented by the executor.

### `agent`

Delegates to another role. Parameters: `role` (string, required), `task` (string, required). The child runs to completion; its `finish` result card is returned as the tool result. If the child fails due to a safety budget, an error result card is returned. This makes the system recursive: roles are invoked through the same tool-calling mechanism as file reads.

### `continue_agent`

Continues a finished child role as a new instance seeded from that child's persisted conversation snapshot. Parameters: `role` (string, required), `comment` (string, optional), `roleId` (string, optional). The target must be a child of the calling instance — a parent can continue only a child it spawned, never another parent's child — and is resolved by role name, or by instance id when `roleId` disambiguates among several finished instances of that role. With `comment`, the comment is appended to the seed as a user message; without it the continuation is transparent, dropping the child's terminal `finish` block so it re-enters at its last input boundary rather than replaying its own completion. The new instance receives a fresh instance id, its `role_start` carries `continuedFrom` naming the continued instance, and it runs to completion like any `agent` call.

Continuation is deliberately unbounded: a parent can continue a role repeatedly, and finished-role snapshots are not pruned. The context budget and the loop detector are the current backstops; snapshot retention is deferred.

### `finish`

Ends the current role and returns a result card. Parameters: `status` (`"success"`/`"error"`/`"needs_clarification"`), `summary` (non-empty string), `artifacts` (array, optional), `error` (object, optional). The entry role's `finish` ends the run.

### `context_info`

Returns metadata about a conversation: context window, current prompt tokens, budget remaining, per-message token counts. Optional `targetRole` (a role-instance id): when present, the metadata describes that suspended instance's conversation instead of the caller's own.

### `edit_context`

Mutates a conversation. Operations: `drop` (range `[start, end)`), `strip_reasoning` (range), `replace` (index + content). Returns the updated `context_info`. Optional `targetRole` (a role-instance id): when present, the operations apply to that instance's history instead of the caller's own. A cross-role target must be registered (hence suspended — a finished role is unregistered and cannot be compacted) and must not be the caller itself, which is active rather than suspended. In every operation, the protected prefix — the system prompt, any prior-run reference turns, and the current task — is untouchable — a batch that touches it is rejected without applying anything. This is the write half of the cross-role compaction primitive: the context handler (see "Context budget exceeded" and "Context pressure and handoff") combines it with the read-only inspection tools to prune a suspended role's history from the outside.

### `ask_human`

Asks a human for clarification. Parameters: `question` (string), `context` (string, optional). A normal (post-write) question surfaces in the web UI and the run pauses until the operator answers through `/api/answer`. The web backend is the only backend — the Foundry (when it exists) answers as an HTTP client posting to `/api/answer`, but the tool schema is identical regardless of who answers. A queue-tracked pre-write ask parks instead (see "Parking: the pre-write rule" in [`docs/queueing.md`](queueing.md)): it never registers a pending question, its `ask_human` event carries the tool-call id and `parked: true`, the run pauses in `needs_clarification` with a frozen checkpoint, and the queue answer `POST /api/queue/:id/answer` resumes the same run by replacing this call's tool result with `{question, answer}`. A root (entry-role) direct `finish` with `status: "needs_clarification"` is the same pause without a parked call: the checkpoint is kept, and the answer re-enters the same run as a framed note naming both the question and the answer.

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
- `read_plan` — read a run's complete plan document (the current run by default, or another run by `runId`); a run that has not written one returns an `unavailable` result, and a stored document too large to deliver within `maxToolOutputChars` returns an `unavailable` error (documents written by this platform are capped at 20,000 characters and `maxToolOutputChars`, so they read back whole)
- `write_plan` — replace the current run's plan document in full (the location is fixed per run; no path parameter); the document is limited to 20,000 characters and the deployment's `maxToolOutputChars`, and exceeding either rejects the write with the exact limits while leaving any previous document unchanged
- `read_style_guide` — read a run's complete style guide document (the current run by default, or another run by `runId`); a run that has not written one returns an `unavailable` result, and a stored document too large to deliver within `maxToolOutputChars` returns an `unavailable` error (documents written by this platform are capped at 20,000 characters and `maxToolOutputChars`, so they read back whole)
- `write_style_guide` — replace the current run's style guide document in full (the location is fixed per run; no path parameter); the document is limited to 20,000 characters and the deployment's `maxToolOutputChars`, and exceeding either rejects the write with the exact limits while leaving any previous document unchanged
- `list_directory` — list directory entries
- `repo_map` — symbol-level map of the workspace's TypeScript/JavaScript sources: one line per top-level declaration, grouped by file (tests, declaration files, vendored code, hidden directories, and build output excluded)
- `run_shell` — run a shell command (via `sh -c`, with the workspace as the working directory)
- `typecheck` — run the workspace's typecheck commands and return each command's result separately (see "Checker tools" below)
- `test` — run the workspace's test commands and return each command's result separately (see "Checker tools" below)
- `fetch_url` — fetch a document over HTTP/HTTPS. The `method` parameter selects the backend: `auto` (default) converts the page to markdown through Kagi Extract when `ORCHESTRATOR_KAGI_API_KEY` is configured, then markdown.new, falling back to a direct fetch of the raw document; `direct` skips conversion (the right choice for API/JSON endpoints); `kagi` and `markdown_new` force a specific backend
- `web_search` — search the web through Kagi, returning ranked results (title, url, snippet, time)

`web_search` and the `kagi` fetch backend are optional capabilities keyed on `ORCHESTRATOR_KAGI_API_KEY` (environment variable, or a Docker secret at `/run/secrets/kagi_api_key`). The Guild's tool set is static (see "Tool availability"), so without the key the tools stay visible to roles and report an `unavailable` error when called; prompts should treat that as a signal to work from known URLs with `fetch_url`.

Each tool manifest in the Guild declares the name, description, and parameter schema. The executor validates calls against that schema.

### Checker tools

`typecheck` and `test` are the same tool under two names — semantic wrappers over the same subprocess machinery as `run_shell` (one spawn path; see [`docs/architecture.md`](architecture.md) "Tool surface"). Each takes `commands` (required: a non-empty array of non-empty strings) and an optional `timeoutSeconds`. The commands run sequentially in the workspace root, each via `sh -c`. Which commands a workspace's toolchain calls for is decided by the calling role at run time (by surveying the workspace and installing what is missing), never configured in the executor or the Guild. One call is a bounded envelope: at most 16 commands (a longer array is rejected as invalid arguments, mirrored by the manifests' `maxItems`), each under a per-command timeout clamped to the executor's default tool timeout (30 seconds in the shipped deployment), so a single invocation cannot run unbounded work.

The success payload is an array with one entry per completed command: `{ command, exitCode, stdout, stderr }`, with each command's streams truncated by a per-command cap. A non-zero exit code is a normal result to read and iterate on, not an error. A command that outlives its timeout returns a `timeout` error whose message names the failing command and whose details carry the completed entries plus the timed-out entry (marked `timedOut`, exit code `null`, partial output); a command that fails to spawn returns `unavailable` naming it, with the completed entries in the details. Processing stops at the first timeout or spawn failure — later commands in the array are not run — and a command killed by a signal outside the timeout path reports `exitCode: null` like a timed-out one. `timeoutSeconds` is per command and clamped: the caller may lower it below the executor's default tool timeout, never raise it. The whole serialized result is also subject to the engine's `maxToolOutputChars` cap: on overflow it is cut from the tail, so the later commands' entries are the first dropped — batch long output into fewer commands rather than spreading it across many.

### Git tools

Nine git tools give roles a narrow, safe version-control surface.
They run `git` directly with a fixed argv — never through a shell — and share one safety posture: only read-only operations plus `init`, `commit`, branch-at-HEAD, and a run-scoped base move; no history rewrite, no checkout or switch, no remote, push, fetch, or pull, no branch delete or force.
Hooks and the fsmonitor hook are disabled (`core.hooksPath=/dev/null`, `core.fsmonitor=false`), the identity is pinned (`user.name=Adaptive Orchestrator`, `user.email=orchestrator@localhost`), and signing is off (`commit.gpgsign=false`), so a commit never depends on the workspace's own configuration.
On success each returns the captured `{ exitCode, stdout, stderr }`; a non-zero exit is an `invalid_arguments` error carrying git's own stderr, a timeout is `timeout`, and a spawn failure is `unavailable`.
Every tool also accepts an optional `timeoutSeconds`, capped by `executor.defaultToolTimeoutSeconds`; the parameters below are the tool-specific ones.

The orchestrator holds these seven — the baseline, commit, and branch tools plus `git_set_base` — so it can take a baseline, commit work as it proceeds, branch before a risky change, and move the run's base:

- `git_status` — no tool-specific parameters. Runs `git status --porcelain=v1 --branch --untracked-files=normal`; read-only.
- `git_log` — optional `count` (a positive integer, default `20`, max `100`). Runs `git log --oneline --decorate -n <count>`; read-only.
- `git_diff` — optional `staged` (boolean, default `false`: the unstaged diff; `true`: `--staged`), optional `paths` (an array of workspace-relative path strings, each rejected if it escapes the workspace or names the `.orchestration` bookkeeping). Runs `git diff --no-ext-diff --no-textconv [--staged] [-- <paths>]`; read-only.
- `git_init` — no tool-specific parameters. Runs `git init`, then re-ensures the `.orchestration` exclusion so run bookkeeping is never staged or committed even on a fresh workspace; safe when a repository already exists.
- `git_commit` — required `message` (a non-empty string of at most 1000 characters with no NUL). Stages the entire working tree (`git add -A`) and commits on the current branch (`git commit -m <message>`); it never amends. If there is nothing to commit it returns a normal success explaining so.
- `git_branch` — required `name` (a valid git branch name). Runs `git branch -- <name>`; creates the branch at the current HEAD but does not switch to it, and fails if the branch already exists or HEAD is unborn (no commits yet).
- `git_set_base` — optional `ref` (a branch, tag, or commit; HEAD when omitted). Resolves `ref` to a commit hash and records it as the run's base commit; a ref that does not resolve is an `invalid_arguments` error. It changes run bookkeeping, not the repository.

Two read-only change-set tools let the review and summarizer roles inspect the run's changes without a write path:

- `git_changes_since_base` — optional `paths` (validated like `git_diff`'s), optional `includeDiff` (boolean, default `false`). Lists the paths changed since the run's base commit — tracked modifications plus untracked files, the latter marked `??` — as a name-status list by default, or the full unified diff, including the contents of untracked files, when `includeDiff` is `true`; read-only. Held by the architecture, style, and security reviewers.
- `git_uncommitted_changes` — optional `paths` (validated like `git_diff`'s), optional `includeDiff` (boolean, default `false`). The same name-status list or full diff, for the workspace's staged, unstaged, and untracked changes against HEAD — resolved per call, using the git empty tree when HEAD is unborn, so it still works after a mid-run `git_init`; read-only. Held by the `change_summarizer` role, a read-only role the orchestrator may delegate to for a commit message derived from the diff.

#### The base commit

Every run has a base commit — the point its reviewers measure the run's changes against.
The executor records HEAD as the base when the task starts; when HEAD is unborn (a repository with no commits) the base is the git empty tree, so a fresh repository still yields a full change set; when the workspace is not a git repository there is no base.
When the workspace is a repository, it reads the git state once before the entry role starts and appends a one-line advisory notice to that role's initial user message — a prompt to handle the dirty state when there are uncommitted changes (no HEAD sha), a note that there are no commits yet when HEAD is unborn, or the short HEAD when the tree is clean — logging `workspace_dirty_at_start` when it is dirty.
The base is persisted in the run checkpoint, so a resumed run keeps the base it started with.
The orchestrator may move the base with `git_set_base` — a hint, not a requirement, is to advance it after a review round completes, so the next round's reviewers see only the changes made since.

The review roles read the change set because the seed Guild reviews on a consolidated cadence: the orchestrator implements every plan step, then runs one consolidated review pass scoped to the run's accumulated changes, then the final acceptance review.
The orchestrator chooses which review lenses apply to the work — the architecture, style, and security review-and-fix leads are the available lenses, and it runs only those the work calls for rather than always running all three.
It may add one interim consolidated review at a milestone when foundation risk warrants it — a new subsystem, a risky integration, an unfamiliar domain, or a `needs replan:`/`needs refactor:` signal from a child — and it runs no per-step review.
The orchestrator commits after every meaningful unit of work, not only after review, and may delegate a commit message to the `change_summarizer` when it wants the message derived from the diff.
Acceptance reviews the whole workspace and holds no git tool.
Separately from those lenses, non-code deliverables — reports, briefs, and instructions — are verified by the `verifier` against their evidence rather than reviewed for code structure.

#### Degradation without git

The git surface degrades gracefully, and the notice is advisory — the probe never throws and a run never depends on git being present.
A tool that spawns `git` returns an `unavailable` result when the process cannot be started, rather than erroring.
The two change-set tools instead report a plain sentence when there is nothing to diff — `git_changes_since_base` when no base was recorded (the workspace is not a repository), and `git_uncommitted_changes` when its probe cannot confirm a repository — and neither errors.
When the workspace is not a repository, the executor injects no git-state notice.

The seed Guild grants the tools that change the repository and `git_set_base` to the `orchestrator` role only, and the two read-only change-set tools to the review and summarizer roles as above; they are a guardrail for those roles' behavior, not a containment boundary (see [`docs/security.md`](security.md) "Git tool policy").

## Guild format

The Guild is the entire behavior of the orchestrator described as JSON: role definitions, tool manifests, the entry role name, and the optional visualization section. There is no workflow graph — workflows emerge from roles calling `agent` to invoke other roles. The deployment knobs (model endpoint, executor budgets, context policy) live in a separate deployment file, described under [Deployment configuration](#deployment-configuration); a guild file carrying them (or a `schemaVersion` key) is rejected with a pointer to that file.

### Files

```
deployment/
└── deployment.json        # deployment configuration (model endpoint, budgets, context policy)
guild/
├── guild.json             # top-level configuration
├── prompts/               # role system prompts (Markdown)
├── concepts/              # shared concept files appended to role prompts (Markdown)
└── tools/                 # tool manifests (JSON)
```

System prompts, concept files, and tool manifests are plain files so the Foundry can rewrite them independently.

### Top-level schema

```json
{
  "entryRole": "orchestrator",
  "concepts": { "style": "concepts/style.md" },
  "roles": { ... },
  "tools": [ ... ],
  "visualization": { ... }
}
```

The optional `visualization` section carries display-only localization the web client reads through `GET /api/config`: `pseudoRoleLabels` (labels for the `human`/`interrupt`/`tools` pseudo-roles the views invent), `operationTemplates` (per-kind, per-source-kind→destination-kind tiered templates that interpolate `{source}` and `{destination}`), `genericOperationTemplates` (per-kind fallbacks), `workingTemplates` (generic per-participant-kind fallback for the working-state caption when a role/tool has no per-entry `workingLabel`), and `roleOrder` (an optional array of declared role names giving the agent-role display order the flow view's top-bar counters and the sequence view's role columns share; a role absent from the list sorts after every listed role, ties break by name, tools always sort alphabetically, and an unknown name is rejected at load time). The executor ignores it; it exists so a swapped Guild re-flavors the diagram without a frontend change. See [`docs/visualization.md`](visualization.md) "Labels" and "Participant ordering".

### `concepts`

A registry mapping a concept name to a guild-relative Markdown file. A role pulls one or more concepts into its prompt by naming them in its own `concepts` array (below); the loader prepends a shared `## Shared concepts` preamble stating the precedence rule, then appends each declared file's content to that role's system prompt at load time, in declaration order, with one blank line between sections. Concepts are the Guild's standing engineering standards, shared across roles and swappable in one place rather than duplicated inline; swapping one requires a service restart because the guild is loaded once per process.

The seed Guild ships ten concepts, grouped by concern: `style` (`concepts/style.md`); architecture — `dependency-injection` (`concepts/dependency-injection.md`), `module-boundaries` (`concepts/module-boundaries.md`, the Guild's module doctrine), `type-safety` (`concepts/type-safety.md`), `error-handling` (`concepts/error-handling.md`); testing — `testability` (`concepts/testability.md`), `verification-and-evidence` (`concepts/verification-and-evidence.md`); and security/privacy — `external-data-validation` (`concepts/external-data-validation.md`), `security-posture` (`concepts/security-posture.md`), `privacy-posture` (`concepts/privacy-posture.md`).

**Precedence and trust.** Guild concepts are the standing defaults. A project's own explicit rules — its documentation, `.editorconfig`, linter configuration, or an instruction in the task — override them, and they in turn override conventions merely inferred from neighboring code. The loader injects the precedence rule once per role as the `## Shared concepts` preamble, so each concept file carries only its domain standards. Guild concepts are trusted guild content, whereas the workspace documentation injected via `projectDocs` remains untrusted reference material.

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
- `concepts` (array of strings, optional): concept names (keys of the top-level `concepts` registry) whose files are appended to this role's system prompt at load time, in declaration order, separated by one blank line, all preceded by the loader-injected `## Shared concepts` preamble (injected once before the role's concepts). Shared standards live in one swappable concept file the roles must not duplicate inline.
- `projectDocs` (array of strings, optional): workspace-relative file paths whose contents are injected into this role's initial user message when it starts at depth 0 (the entry role), inside one labeled `[Platform notice — project context]` block framed as untrusted project reference material. Each file is read once at run start and rides the checkpoint, never re-derived on resume. Each file is read with a hard 256 KiB byte cap and its decoded text is cut to 40,000 characters with a `… (truncated)` marker; a missing, non-regular, or unreadable file is skipped with a short notice in the block rather than failing the run. Paths are canonicalized against the workspace and symlink escapes are rejected.
- `label` (object, optional): tiered display name (`{ detailed, friendly, whimsical }`) the web client renders.
- `description` (object, optional): tiered one-line description of the role.
- `workingLabel` (object, optional): tiered text for the "now" caption when this role is the destination of a settled call (its working phase). A `{participant}` placeholder interpolates to the role's own label at the chosen tier — e.g. `"{participant} is planning the approach"` → "Planner is planning the approach". See [`docs/visualization.md`](visualization.md) "Labels".

The seed Guild's style workflow uses these fields together. Its `style_guide_author` role is read-only with respect to project files — it writes only the run style guide — and merges the task's style rules, the repository's style documents, `.editorconfig`, linter and formatter configuration, and the guild `style` concept — in that precedence, falling back to the repository's applied style when those are silent — into one run style guide, written with `write_style_guide`. The `coder`, the `technical_writer`, the `style_reviewer`, and the author itself read that guide with `read_style_guide`, and the orchestrator delegates to the author after planning and before the first producing delegation whenever a style review will run. The orchestrator additionally declares `projectDocs: ["AGENTS.md", "README.md"]`, injecting the repository's top-level documentation as the untrusted project-context block described above.

The seed Guild's non-code work routes to three roles. The `analyst` investigates the workspace — module boundaries, security posture, and privacy posture — and produces an evidence-backed findings report without changing existing code. The `technical_writer` reads the code, configuration, and scripts and writes or updates the documentation and usage instructions to match what the software actually does, against the run style guide. The `verifier` independently checks a deliverable's claims against the material it describes and its coverage for completeness, reporting findings and a verdict without code-structure review.

### Author hygiene

A child role starts from a fresh, information-constrained context and sees only its system prompt and the task text it is handed.
Some roles — above all a fresh reviewer — must reach their own conclusions: they must be unbiased and unpoisoned, reasoning about the work in front of them rather than the machinery around it.
Priming changes behavior: a reviewer told that a review pipeline exists, that it is round two, what a previous reviewer found, which findings are expected, or that it is being graded will look for what it was primed to find and stop looking elsewhere.

So when you author or change the Guild:

- Keep process out of shared concepts. A concept is appended to every role that declares it, so a process concept would leak the process into roles — including reviewers — that must stay unaware of the meta process. Concepts carry engineering standards only.
- Keep process in the process roles. The orchestrator and the leads are process-aware and their prompts carry the loop; a fresh reviewer's task text must not.
- Hand a child only what it needs. A parent's task text carries the work, the scope, the standards to apply, and the work parameters the child's own prompt expects (such as the effort level); it must not carry the parent's process state, prior findings, expected results, or evaluation framing.
- Before adding a prompt or a concept, ask whether a fresh, unbiased agent would be better or worse off for having read it. If a role does not need it to do its job, it does not belong in that role's context.

### `tools`

A list of tool-manifest file paths. Each manifest declares `name`, `description`, and `parameters` (JSON Schema). The executor validates calls against the schema and exposes the tools to the model in the Responses API request. Each manifest also carries optional display fields the web client reads through `GET /api/config`: `humanLabel` (tiered display name), `humanDescription` (tiered one-line description), `humanCallLabel` (tiered template for the operation label when an agent calls this tool — interpolates `{source}` and optionally `{destination}`), and `humanWorkingLabel` (tiered text for the "now" caption when this tool is the active/working node — optionally interpolates `{participant}`). See [`docs/visualization.md`](visualization.md) "Labels".

### Tool availability

The set of tools a role may call is part of the Guild. The executor does not hide tools conditionally — the same Guild is used during Foundry optimization and in production, so the small model always sees the same tool names and schemas.

### Workflows

There is no separate graph or playbook file. A workflow is a role calling `agent` multiple times and combining results before calling `finish`. If the Foundry wants a different workflow, it rewrites the orchestrator prompt or adds/removes roles.

### Loading and validation

`createGuildLoader(deploymentFilePath)` is a leaf factory that returns a `LoadGuild` whose `loadGuild(guildDir)` reads `guild.json`, validates it with the shared `validateGuildConfig`, reads and validates the deployment file, and cross-checks that every handler role the deployment names exists in the Guild. It then resolves each role's `systemPrompt` Markdown file (composing in that role's declared `concepts` with `composeRolePrompt`), validates every referenced tool-manifest JSON file with `validateToolManifest`, and checks that each role's `tools` list names only declared manifests. Validation failures surface as a `ValidationError` naming the offending path.

The loader's return value is file-shaped — the validated `GuildConfig`, the deployment still unresolved (`model.name` and `model.contextWindow` may be absent), the resolved prompt text per role, and the parsed tool manifests keyed by name. Completing the model into the `LoadedGuild` the executor consumes is the startup path's job. The loader is a leaf and is not unit-tested; the shipped Guild data is validated by a dedicated script run directly (see `bun run validate-data`), not under `bun test`.

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
| `ORCHESTRATOR_INVOLVEMENT` | `executor.defaultInvolvement` |
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
  "defaultInvolvement": "early-engagement",
  "interruptTriggers": {
    "handlerRole": "loop_detector",
    "everyToolCalls": 12,
    "everyTokens": 30000,
    "planOwnerRole": "planner"
  }
}
```

Safety budgets enforced by the executor. `maxAgentDepth` guards unbounded agent recursion; `defaultToolTimeoutSeconds` aborts a hung tool subprocess; `maxCompactionAttempts` terminates a `context_manager` that is not reducing tokens. `contextPressureThreshold` (optional, default `0.8`) is the fraction of the effective context budget at which the one-shot pressure response fires (see "Context pressure and handoff"). `contextHandlerRole` (optional) names the guild role the engine invokes to compact a suspended role's conversation — at depth 0 when the entry role crosses the pressure threshold, and at any depth when a request is rejected for context size; when unset, depth-0 pressure falls back to the handoff notice and rejections fall back to the naive in-place backstop. `inquiryHandlerRole` (optional) names the guild role the engine invokes to answer an operator inquiry (see "Interrupt platform"); when unset, the inquiry is dropped and logged (`inquiry_dropped`) and the run continues. `defaultInvolvement` (optional) sets the deployment-wide default human-involvement level (`autonomous`, `early-engagement`, or `collaborative`; see "Involvement channel"); it is the resolution chain's lowest-priority input, overridable per run or by the project setting. The executor does not enforce a wall-clock run timeout or per-role tool-call/token caps — run termination is the deployment container's job (see "Run termination" above and [`docs/architecture.md`](architecture.md) "Run termination").

`interruptTriggers` (optional) configures the interrupt platform's loop-check cadence (see "Interrupt platform"): `handlerRole` is the guild role invoked on a trigger (must exist in `roles`); `everyToolCalls`/`everyTokens` are the base thresholds, scaled by the effort tier's factor (`quick` ×2, `standard` ×4, `thorough` ×6); `planOwnerRole` (optional) names the role that receives plan modifications — the rootmost live chain instance of it, falling back to the chain root when unset or absent from the chain. When the section is absent, cadence checks never fire; operator interrupts work regardless.

### `contextPolicy`

```json
{ "maxToolOutputChars": 4000 }
```

Tool results longer than this are truncated inline. Run documents (plan and style guide) are write-capped to 20,000 characters and `maxToolOutputChars`, so a successful write reads back whole. There is no automatic compaction threshold — roles use `context_info` and `edit_context` to manage context.

### `logging`

```json
{ "level": "standard" }
```

Optional section setting the deployment-wide default logging level for run logs (see "Logging level" below): `level` is `"full"` or `"standard"`, and the whole section may be omitted. A per-run choice or the project setting (see `GET|PUT /api/settings`) still overrides it. The section is validated strictly like the rest of the file — an unknown key such as `levels`, or a value that is not one of the two wire strings, fails the load.

## HTTP API

The web UI is the primary interface. The HTTP API exists for programmatic access (e.g. the Foundry). All endpoints return JSON. The server dispatches one run at a time from a durable task queue: tasks submitted while a run is in flight wait in the queue and start when the slot frees (see [`docs/queueing.md`](queueing.md) for the queue's design).

Two polled representations — `GET /api/runs/:id` and the flow endpoint's `?operation=<id>` detail variant (`GET /api/runs/:id/flow?operation=<id>`) — support conditional requests. Each returns an `ETag` that identifies exactly the representation of the requested URL, honors an `If-None-Match` request header by returning `304 Not Modified` with no body when that representation is unchanged (the validator is echoed back so the client can revalidate again), and always sends `Cache-Control: no-store`. The two base collection routes are not conditional: `GET /api/runs` and `GET /api/runs/:id/flow` (without `?operation=`) each return an entity-diff envelope (see below) whose own `unchanged` reply is the revalidation, and each sends `Cache-Control: no-store` without an `ETag`. Validators are per-URL: each representation has its own token, and within the flow endpoint each `?operation=<id>` detail is distinct, so a validator obtained from one URL must never be replayed against another — a client that does so receives a fresh `200`, never a spurious `304`.

The browser tab title of the served UI is a service setting, not a deployment field: `ORCHESTRATOR_TITLE` (default `Adaptive Orchestrator`) is substituted into the page's `<title>` element when the static handler serves it, so the configured title is present in the initial HTML and an empty value falls back to the default.

### `POST /api/runs`

Starts a run. **Body:** `{ "task": "...", "effort"?: "quick"|"standard"|"thorough", "involvement"?: "autonomous"|"early-engagement"|"collaborative", "logLevel"?: "full"|"standard", "continuesFrom"?: "<run_id>" }`. `effort` is optional; the validated tier is recorded on the enqueued item and applies to its run as the per-run effort override, and when omitted the project default (see `GET|PUT /api/settings`) is applied, falling back to `"standard"` when no default is set. Anything but the three tier strings returns `400 invalid_body`. `involvement` is optional and picks the run's human-involvement level (see "Involvement channel"); when omitted it resolves through the same chain — project default, then the deployment file's `executor.defaultInvolvement`, then `"early-engagement"` — and anything but the three level strings returns `400 invalid_body`. `logLevel` is optional and picks the run's logging level (see "Logging level"); when omitted it resolves through the same chain — project default, then the deployment file's `logging.level`, then `"full"` — and anything but the two level strings returns `400 invalid_body`. `continuesFrom` starts a new run that continues a prior one; when present it must be a well-formed run id (`run-YYYYMMDD-HHMMSS`) naming a known run whose status is terminal (`success`, `error`, `needs_clarification`, or `interrupted` — a `running` run has no outcome to continue from), and anything else returns `400 invalid_body`. A continuation run records the lineage as `continuesFrom` in its `meta.json` (see "Persistence"), and the executor represents the prior run as real reference turns in the entry role's initial history — the prior operator task as a user turn and the prior terminal result as an assistant turn, immediately after the system prompt — so the Guild can pick up where the prior run left off. The operator's new task follows as its own user message carrying only the follow-up task text, a marker naming the prior run and its `read_plan` handle for the prior run's plan document (the planner reads the prior plan with `read_plan(runId)`), the queue briefing when present, project docs, and the git notice; the prior task and result are not repeated in that message. The executor provides the channel only, and the Guild decides what to do with the continuation. A continuation may also omit `task` (or pass an empty one): the run then re-runs the prior task, so the prior run's task text necessarily appears both as the reference user turn and, substituted as the effective task, in the new user message; the enqueued item and the composed continuation both carry it. A fresh submission without task text still returns `400 invalid_body`. **201:** `{ "runId": "..." }`. **409:** `{ "ok": false, "error": "run_in_progress" }` when a run is already active, or `{ "ok": false, "error": "run_id_collision" }` when the generated run id collides with an existing run directory — run ids have one-second resolution, so a prior run that failed instantly can still own the fresh id, and sharing a directory would interleave the two runs' logs and metas; resubmitting generates a new id.

Internally the validated task is enqueued at the head of the durable task queue (recording the request's `effort`, `involvement`, `logLevel`, and `continuesFrom` on the item) and the queue's scheduler dispatches it within the same request when the run slot is free — the response still carries the started run's id, and every active run is queue-tracked. The busy-service 409 is decided before anything is enqueued.

### `/api/queue`

The task queue's management surface (see [`docs/queueing.md`](queueing.md) "HTTP API" for the design). Every endpoint returns the affected item on success. Error semantics are shared: a malformed body is `400` `{ "ok": false, "error": "invalid_body" }`, an unknown item id is `404` `{ "ok": false, "error": "not_found" }`, and a status-forbidden operation is `409` `{ "ok": false, "error": "status_forbidden" }`.

- `GET /api/queue` — the ordered item list with statuses, head first.
- `POST /api/queue` — **Body:** `{ "task": "...", "effort"?: "quick"|"standard"|"thorough", "involvement"?: "autonomous"|"early-engagement"|"collaborative" }`. Always enqueues at the tail (never a 409) and returns `201` with the created item; the scheduler tick runs in the same request, so an idle system starts the task immediately.
- `PATCH /api/queue/:id` — edits `task`/`effort`/`involvement` and/or moves the item to `position` — a 0-based index into the `waiting` list, out-of-range values clamped; `waiting` items only, else 409. A waiting item bound to a same-run answer resume refuses task/effort/involvement edits with 409; a position-only reorder remains allowed.
- `DELETE /api/queue/:id` — marks a `waiting` item `cancelled` (the item stays in the file so the UI can show the recent outcome).
- `POST /api/queue/:id/answer` — **Body:** `{ "answer": "..." }` — answers a `needs_input` item: the answer is recorded, the item moves to the front of the `waiting` list (keeping its existing lineage), and the scheduler resumes the same paused run — delivering the answer as the existing `ask_human` tool result for a parked ask, or as a framed question-and-answer note for a direct clarification finish. When the matching pause checkpoint is missing, the item falls back to the legacy briefed continuation with the question and answer preserved and its lineage re-pointed at the unresumable run. When the item's own run has already terminated as anything other than `needs_clarification` (an operator termination), the item is returned `cancelled` with the answer discarded and nothing dispatched or resumed; the cleanup deletes the leftover checkpoint and appends the `run_terminated` event. This is the answer path for parked pre-write questions, which never register in the human backend (see `POST /api/answer`).
- `POST /api/queue/:id/terminate` — no body; terminates a `needs_input` item. The queue item is marked `cancelled` (keeping its question, answer, and lineage for audit), the parked run's meta is rewritten `interrupted` with `{ "kind": "interrupted", "message": "The operator terminated this run while it was waiting for an answer." }` while preserving its parked `endTime`, a `run_terminated` event is appended to its log with the actual termination timestamp, and its checkpoint is deleted so the run can never be answered or resumed. The item is still cancelled when the run is already gone or no longer parked.
- `POST /api/queue/:id/requeue` — returns an `error` item to `waiting` at the tail, its lineage re-pointed at the errored run; the scheduler tick runs in the same request.

### `GET /api/settings`

Returns the project-wide settings. **200:** `{ "effort": "quick"|"standard"|"thorough" | null, "involvement": "autonomous"|"early-engagement"|"collaborative" | null, "logLevel": "full"|"standard" | null }`. Each field is `null` when no default has been set.

### `PUT /api/settings`

Updates the project-wide settings. **Body:** `{ "effort": "quick"|"standard"|"thorough", "involvement"?: "autonomous"|"early-engagement"|"collaborative", "logLevel"?: "full"|"standard" }` — `effort` is required and strict; the optional `involvement` sets the project-wide default human-involvement level (see "Involvement channel") and, being absent, clears it; the optional `logLevel` sets the project-wide default logging level (see "Logging level") and, being absent, clears it (the write replaces the file wholesale). The file is written atomically (write-temp + rename). **200:** the settings as stored. **400:** `{ "ok": false, "error": "invalid_body" }` for a missing or invalid `effort`, or an invalid `involvement` or `logLevel`.

### `GET /api/runs`

Lists known runs (read from `<workspace>/.orchestration/runs/`), newest first, shipped inside an entity-diff envelope so a steady poll transfers only the runs that changed. The envelope is one of `{ "kind": "snapshot", "version", "contentHash", "collections" }` (the full state), `{ "kind": "delta", "base", "next", "collections" }` (the changes since the client's `base` revision), or `{ "kind": "unchanged", "version" }` (the client's revision is current). The client's held revision rides as the `have` query parameter; an absent, unknown, or evicted `have` yields a snapshot. `collections.runs` is the id-keyed list of run entities, from which the client reconstructs the summaries (sorted newest-first by run id). Each entry carries the run id, status, task, effort, involvement, start/end times, result card, error, and `continuesFrom` (the prior run's id when this run continues one, `null` otherwise), plus `summary`: an LLM-generated one-line description of the run (`null` when none has been produced). A task-only summary is written to `<run>/summary.txt` shortly after the run starts and is replaced at a true completion (success or error) by one derived from the task, the interrupt history, and the result; a `needs_clarification` pause keeps the task-only summary as the task label instead, because the question is not a completion. Generation is best-effort and never affects the run. The summarizer's calls are not role turns and appear in no role's accumulator — their spend is logged against the run as `summarizer_llm_call` events (see "Log events").

### `GET /api/runs/:id`

Full run view: status, role activity, recent log. Includes `continuesFrom` — the prior run's id when this run continues one, `null` otherwise (see `POST /api/runs`) — plus `resumable` — whether the run can be explicitly resumed from its checkpoint: `true` only when the status is `error` and a checkpoint file exists on disk (see `POST /api/runs/:id/resume`) — plus `plan` — the run's plan document, the raw Markdown written through `write_plan` and read per request from `<run>/plan.md` (`null` when the run has no plan document) — plus `interruptPending` — whether an operator interrupt is queued for the run's next safe point — and `interrupts`, the history of operator interrupts: each inquiry (an `inquiry`-triggered `interrupt` event) paired with its `interrupt_resolved` — an `answered` resolution with a non-empty summary sets the answer, anything else marks it ended, and no resolution yet leaves it waiting — and each plan modification with its delivery target and aborted list. An error result card may also carry `detail`: the bounded raw failure payload behind the card's summary (for an LLM transport failure, the endpoint's error-response body as sent, capped at 2000 characters with a truncation marker), which the web client renders as collapsed technical details on the error modal and includes in the copy-raw payload.

The `recentLog` entries are identity rows only: `{ index, timestamp, type, text }` where `index` is the event's log-wide position (the identity the window endpoint pages and serves detail by) and `text` the one-line rendering of the event. Raw payloads and per-event detail sections (the `llm_call` sent/received bodies, tool arguments/results, finish summaries) are deliberately absent — they can carry multi-megabyte bodies, so shipping them on every poll would multiply the run view's size by the number of windows they appear in; fetch them on demand from `GET /api/runs/:id/log`.

### `GET /api/runs/:id/log`

A window over the run's parsed event log, reusing the run-view snapshot read path. Query parameters: `offset` (default `0`), `limit` (default `50`, capped at `500`); a non-integer or negative value falls back to the default, and an offset past the end yields an empty page with the correct `total`. **200:** `{ runId, total, offset, limit, events: [{ index, timestamp, type, payload }] }` — each event carries its log-wide `index`, so a client can page backward and address single events unambiguously.

`?instance=<roleId>` scopes the window to one agent instance before windowing: the instance's own turns (`llm_call`/`llm_call_start`, matched on the payload's `roleId`, falling back to the role name for old logs whose turn events predate per-instance ids), its role-named turn-failure events (`llm_unavailable`/`context_budget_exceeded` carry no role id; single-flight execution makes the role-name match unambiguous, and the turn pairing closes a failed turn's bracket on them), its own `role_start`/`role_finished` lifecycle, and the lifecycle of its ancestor chain walked through `parentRoleId` to the root — the server sees the full log, so ancestry is always resolvable from it; old logs whose `role_start` events predate `parentRoleId` resolve the parent by the latest earlier same-named start at depth − 1, and a genuinely absent ancestor start ends the walk where it stands. `offset`/`limit` then window the FILTERED sequence, so `total` is the filtered count while every event keeps its log-wide `index`. An absent or empty `instance` serves the unfiltered window, and an id that names nothing yields an empty `200` (`total: 0`) rather than `404`, so a stale client scope renders an empty transcript instead of an error. `?detail=` and `?format=text` are unaffected by `instance` on purpose: detail is addressed by log-global index (its fold needs the full log's slice chain) and the text export is run-wide. The web client's inspector fetches this variant when its transcript scopes to an instance, so an old agent's turns and complete delegation breadcrumb load without paging back through the run's tail (children are deliberately not included — the client's child affordances read the unscoped tail window it keeps alongside).

`?detail=<index>` serves one event's detail sections instead of a window: **200:** `{ index, detailSections }` where `detailSections` pairs the event's heavy bodies under machine labels (`sent`/`received`/`finish reason`/`usage` for an `llm_call`; `arguments` for a `tool_call`; `result` for a `tool_result`; `summary`/`error` for a `role_finished`) and is `null` when the event carries none. An out-of-range or malformed index returns `404 not_found`. This is the on-demand surface the web client's inspector transcript consumes for a turn's "on the wire" expander (the complete request conversation the model saw at that turn — the response consumption folds `sent` server-side, so the expander shows the full envelope even for delta-protocol logs): the sections are fetched on the expander's first open and cached for the browser session, so the polled log window never carries the bodies.

`?format=text` renders the requested page as plain text (one tab-separated line per event: timestamp, type, one-line rendering) with a `content-disposition: attachment; filename="<run_id>.log"` disposition, so export reuses the server-side formatter. Unknown run → `404 not_found`.

### `GET /api/runs/:id/flow`

The run's structured `InteractionModel` (see [`docs/visualization.md`](visualization.md) "The model"), shipped inside an entity-diff envelope so a steady poll transfers only the entities that changed. The envelope is one of `{ "kind": "snapshot", "version", "contentHash", "collections" }` (the full state), `{ "kind": "delta", "base", "next", "collections" }` (the changes since the client's `base` revision), or `{ "kind": "unchanged", "version" }` (the client's revision is current). The client's held revision rides as the `have` query parameter; an absent, unknown, or evicted `have` yields a snapshot. `collections` are the id-keyed `participants`, `operations`, `stacks`, and `runStatus` collections (the run status is the singleton `run-status` entity), from which the client reconstructs the `InteractionModel`; the operations carry identities, lifecycle, outcome, and metrics but no detail bodies. Per-invocation metrics attach to `call` operations only — a call's metrics accumulate its destination's LLM spend while the call is open, discarded `llm_retry` attempts included — and carry the token counters plus `elapsedSeconds`. The token counters are `null` until a usage report folds into the call (a tool call, an `ask_human` call, or an agent call whose endpoint answered without usage stays `null` rather than a fabricated zero; `cachedPromptTokens` additionally stays `null` until a usage reports it, and is a subset of the prompt bill), while `elapsedSeconds` is always measured. `lastPromptTokens` is the assignment exception: each folded usage overwrites it with that turn's `promptTokens`, so it carries the invocation's current context window size (the executor's per-role `lastPromptTokens`) rather than a sum, and the per-destination aggregation takes the latest reported value. Returns, observes, and terminates carry `metrics: null`, their outcome riding the return alone. The model is derived from the run's full log per request. Unknown run → `404 not_found`.

`?operation=<id>` serves one operation's detail markdown instead of the model: **200:** `{ operationId, details }` where `details` is the operation's Markdown body — the delegation task text for a role call, the pretty-printed arguments for a tool call, the full result for a tool return, the question (and context) for an `ask_human` call, the answer or finish summary for a return — or `null` when the operation carries no detail material. An id that names no operation in the current model (e.g. a stale id from an earlier frame) returns `404 not_found`. This is the on-demand surface the web client's inspector fetches when a card opens, so the polled flow model never carries the (potentially large) detail bodies.

### `POST /api/runs/:id/interrupt`

Submits an operator interrupt for the active run (see "Interrupt platform"). **Body:** `{ "kind": "inquiry" | "plan_modification", "message": "..." }`. `inquiry` pauses the run at the next safe point while a fresh `executor.inquiryHandlerRole` instance investigates the suspended roles and the workspace read-only; its finish-card summary is the answer, surfaced in the run view's interrupt history (and the operator's answer card), and the run then resumes. `plan_modification` aborts the live sub-work below the plan owner and delivers the message to it. (A third kind, `notice`, is internal-only — see "Interrupt platform".) **202:** `{ "ok": true }` when queued. **400:** `invalid_body` for a bad kind or empty message. **409:** `{ "ok": false, "error": "run_not_active" }` when the named run is not the active one (terminal, unknown, or no run active).

### `POST /api/runs/:id/resume`

Explicitly resumes an error-ended run from its checkpoint (see "Run persistence and resumption"; also [`docs/queueing.md`](queueing.md) "Resume of an errored run"). This is the operator-driven path that re-enters an error terminal (the queue answer is the corresponding path for a parked `needs_clarification`), and startup reconciliation never auto-resumes an error run. **Body (optional):** `{ "note"?: "..." }` — an absent body, a JSON `null`, a missing `note`, a `null` note, or an empty-string note all resume with no note injected; a non-empty string is delivered to the resumed conversation as a clearly framed user message (`The operator resumed this run after a failure. Message from the operator: <note>`) before the resumed role's first LLM request; anything else is `400 invalid_body`. With no note, nothing is injected — the agent simply continues from its last successful turn. The resumed run keeps its own run id, original start time, effort, involvement, and log level; the terminal error meta is replaced by a `running` meta (the old error card remains in the log), and the `run_resumed` event stamps the note as `operatorNote` when present. The queue item settled to `error` for this run is re-activated under the same run id, and its next settlement maps it like any active item's. **201:** `{ "runId": "..." }` — the SAME id as the resumed run. **404:** `{ "ok": false, "error": "not_found" }` for an unknown run id. **409:** `{ "ok": false, "error": "run_not_errored" }` when the meta names a run that did not end in error; `{ "ok": false, "error": "run_in_progress" }` when a run is active; `{ "ok": false, "error": "checkpoint_missing", "message": "..." }` when no valid checkpoint exists — including a checkpoint carrying `parkedAsk`, which belongs to the queue answer — and the message points at the fallback, `POST /api/runs` with `continuesFrom` (the briefed continuation, which re-does work without the failed run's conversation).

### `GET /api/run`

Convenience alias for the most recent run (active or last completed). **404:** `{ "ok": false, "error": "no_run" }` when no run has ever started (there is nothing to alias), `{ "ok": false, "error": "not_found" }` when the most recent run's artifacts can no longer be read.

### `GET /api/questions`

Returns pending `ask_human` questions from the active run.

### `POST /api/answer`

Submits an answer. **Body:** `{ "id": "...", "answer": "..." }`.

### `GET /api/config`

Returns the rendered configuration the web client boots from: the model endpoint (`name`, `contextWindow`), the executor budgets, the entry role, each role's tools and display fields, each tool manifest's display fields, the guild's `visualization` section when present (see "Guild format" and [`docs/visualization.md`](visualization.md) "Labels"), and the image's build identifier as `build` — `{ sha, builtAt }`, with `sha` present only when the image was built with `BUILD_SHA` and `builtAt` the UTC timestamp baked at build time; `build` is `null` when running without a baked build-info file (e.g. from a source checkout).

### `GET /api/demo/scenarios`

Manifest of the fixture scenarios the visualization demo page serves: `{ id, label, frameCount, participants }` per scenario. `participants` is taken from the scenario's final frame so the sequence view can lay out every column from the first frame (see [`docs/visualization.md`](visualization.md) "Dev harness").

### `GET /api/demo/flow/:scenario/:frame`

Serves one frame of a demo scenario fed through the real adapter — the same `LogEvent` → InteractionModel derivation as `GET /api/runs/:id/flow` — so the demo harness exercises the product's data path (see [`docs/visualization.md`](visualization.md) "Dev harness"). `?operation=<id>` serves one operation's detail markdown the same way the run flow endpoint does. An unknown scenario or an out-of-range frame returns `404 not_found`.

### Live token stream

`GET /ws/stream` upgrades to a WebSocket (the only upgrade path) carrying the active run's live token stream. WebSocket — rather than server-sent events — was chosen for bidirectional headroom: the protocol already carries client→server requests, so a future feature (extra filters, other server-pushed event kinds) slots into the same endpoint instead of growing a second one.

**Protocol.** Client → server: `{"type":"subscribe","runId":"..."}`; a re-subscribe replaces the previous subscription, and every other message is ignored. Server → client: `{"type":"subscribed","runId":"..."}` — the ack, sent once per accepted subscribe — and `{"type":"delta","runId","roleId","role","field":"reasoning"|"content","text","reset"?}`. `roleId` identifies the role instance, `role` its name, `field` names the turn-text field the text extends, and `reset` marks the first delta of every attempt (a retried stream re-emits its text from zero). Deltas flow only while the subscribed run is the active run. Malformed messages are ignored in both directions. The browser client is `source/web/static/ts/stream-client.ts` (reconnect with capped backoff — 500ms doubling to an 8s cap, reset by an ack); the fan-out is `source/web/stream-hub.ts`.

**Client lifecycle.** The client subscribes while the watch screen shows a selected, non-terminal run. Leaving Watch, switching to a terminal run, or opening another screen unsubscribes: the desired run is cleared, the reconnect timer is cancelled, the socket is closed, and the inspector can show that live text is reconnecting. A later subscribe starts a fresh connection (the stream client is not permanently closed); only the explicit permanent `close()` stops reconnecting for good. While the inspector is open on a non-terminal run with the socket down, it renders a spinner beside "Live text reconnecting…" above the transcript rather than an empty-looking live area.

**Partial cap.** The client keeps at most 250,000 characters per turn-text field (about 60k tokens). An append that would exceed the cap keeps the most recent characters (the tail) and trims to 90% of the cap, leaving headroom so the common case appends cheaply instead of slicing on every delta; a tail never starts mid-surrogate-pair. The partial carries a `truncated` marker until the turn resets or a different role instance starts, and the inspector renders a fixed note that the preview is truncated and the full turn appears when it completes. The cap only bounds ephemeral rendering state, never the polled log or the completed turn.

The contract, in bold terms:

- **The stream carries only ephemeral in-flight partials.** It never carries turn history or run state; the run log and the polling endpoints above remain the **sole authority** for both, and a completed turn is read from the log like any other event.
- **Partials are keyed by role instance, not turn.** The client pairs the in-flight partial with an in-flight row by the row's `roleId`, falling back to the role name only when a side carries no instance id (old logs, whose turn events predate per-instance ids) — under that fallback a same-named child role's partial may briefly render under the parent's in-flight row after the child completes. The partial is ephemeral rendering input only; the polled log remains the authority on turn boundaries.
- **The UI must keep fully working when the socket is absent, rejected, or dies mid-stream.** Only live partial text is lost; no run state, history, or control path depends on the stream, and the client shows no error surface for it.
- **Deltas re-emit from zero per attempt, not per reconnect.** When a turn starts or the model retries it, the server marks the attempt's first delta `reset: true` and the text re-emits from zero, so a client accumulation must clear before appending. A client that reconnects mid-turn simply resumes with the deltas that follow; the missed middle is not replayed.
- **Publishing is best-effort and never backpressures the run.** The executor taps the streaming hot path after the fact; slow or dead subscribers are dropped, and streaming never waits on the stream.

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
│   ├── meta.json      # run id, guild path, start/end time, status (incl. interrupted), effort, involvement, logLevel, final result, continuesFrom (the prior run's id when this run continues one)
│   ├── state.json     # checkpoint: the runnable role stack, written atomically at every safe point, before each dispatch, when a child card returns, and at a completed batch; kept for error (explicit resume) and every needs_clarification pause (parked ask or direct finish, queue answer resume), deleted at true completions
│   ├── log.jsonl      # one JSON object per line: effort_set, involvement_set, run_resumed, llm calls, tool calls, errors (payload detail per the run's logging level)
│   ├── summary.txt    # LLM-generated one-line run summary (UI label; best-effort)
│   ├── plan.md        # the run's plan document (write_plan/read_plan)
│   └── style-guide.md # the run's style guide document (write_style_guide/read_style_guide)
├── settings.json      # project-wide settings (the default effort, involvement, and logging level)
└── queue.json         # the durable task queue: every queued task, its status, and its outcome (see docs/queueing.md)
```

The workspace itself holds the final filesystem state (mutated in place). `log.jsonl` is append-only — the executor logs every role start/finish, the parent→child agent-call edges, every LLM turn (its new messages as a delta against the role's previous turn — see "Log events", received response, finish reason, per-call usage), and every tool call/result (raw arguments and the full un-truncated result) so a reviewer can reconstruct exactly what happened from the log alone. `state.json` is the run's resumable state (see "Run persistence and resumption"): present while a run is live and kept after an `error` or any `needs_clarification` pause — a parked ask or a direct finish (deleted only at true completions such as `success`), rewritten at every safe point, when a child card returns, before each dispatch (the pending-invocation write), and at a completed batch including a recorded `role_finished`, frozen at a park, and validated on startup before any of it is trusted.

The file tools (`read_file`, `write_file`, `list_directory`, `glob_files`, `search_text`, `repo_map`) refuse the top-level `.orchestration` directory with a `permission_denied` error — it is the executor's bookkeeping, not project content, so a role reading or writing there is always a mistake. The bookkeeping a role legitimately needs is mediated by the dedicated tools instead: `read_plan`/`write_plan` for the run's plan, `read_style_guide`/`write_style_guide` for the run style guide, and `read_run_log`/`search_run_log` for the event log.

## Effort channel

The effort channel is a per-run, project-wide speed-vs-quality setting with three named tiers: `quick` (fastest and most direct), `standard`, and `thorough` (slowest and most careful). The three lowercase strings are the wire format everywhere: the HTTP API, `settings.json`, `meta.json`, checkpoints, and the `effort_set` log event all carry them verbatim. The executor provides the **channel only** — it accepts, persists, logs, and injects the tier; it makes no decision about what each tier *means*. The mapping from effort to concrete behavior (generation overrides, the quality bar the review loops run to — what findings the leads act on and how convergence is confirmed, with no round caps — retry thresholds) lives entirely in the Guild prompts and is tunable by the Foundry, so hardcoding it in the executor would conflict with the Foundry's job.

### Resolution

Effort is resolved once at run submission and is not adjustable mid-run (a second submit while a run is active is rejected as `run_in_progress`):

1. A per-run `effort` in `POST /api/runs` wins.
2. Otherwise the project default from `.orchestration/settings.json` (set via `PUT /api/settings`) is used.
3. Otherwise the default `"standard"` is applied.

### Injection

The entry role (and only the entry role) receives the effort directive appended to its single system message, so prompts can branch on it. Child roles do **not** receive a global effort directive — the parent decides how to translate effort into delegation instructions. The directive string is a stable contract the Guild prompts depend on:

```
Quality level: <tier> (one of quick, standard, thorough — quick is fastest and most direct; thorough is slowest and most careful).
```

### Surfaces

- `RunMeta.effort` and `GET /api/runs/:id` carry the run's effort tier.
- An `effort_set` event `{ effort }` is logged once at run start, with the tier string as the payload value.
- `GET|PUT /api/settings` read/write `.orchestration/settings.json` atomically — the project defaults for `effort`, `involvement`, and `logLevel`; a malformed file is treated as absent (a torn read mid-write must not crash submission).
- The Foundry sets effort per benchmark and ignores the project setting, so benchmark runs are comparable.

## Involvement channel

The involvement channel is a per-run, project-wide human-involvement setting with three named levels: `autonomous` (the operator has delegated decisions; no clarifying questions), `early-engagement` (resolve genuine ambiguity up front, then work autonomously), and `collaborative` (keep the operator in the loop throughout). The three lowercase strings are the wire format everywhere: the HTTP API, `settings.json`, `meta.json`, checkpoints, and the `involvement_set` log event all carry them verbatim. The executor provides the **channel and the directive** — it accepts, persists, logs, and injects the level, and composes the level's guidance directive (`involvementDirective` in `source/executor/involvement.ts`) which is injected verbatim into the entry role's system prompt. The executor applies **no platform enforcement** (no question budgets, no suppression, no timeouts, no park/block changes, no mid-run adjustment); the Guild role prompts defer to the injected directive and carry the role-specific behavior that acts on it.

### Resolution

Involvement is resolved once at run submission and is not adjustable mid-run (a second submit while a run is active is rejected as `run_in_progress`):

1. A per-run `involvement` in `POST /api/runs` wins.
2. Otherwise the project default from `.orchestration/settings.json` (set via `PUT /api/settings`) is used.
3. Otherwise the deployment default from `deployment.json` (`"executor"."defaultInvolvement"`, see [Deployment configuration](#deployment-configuration)) is used.
4. Otherwise the default `"early-engagement"` is applied.

Like the logging level, the web compose selectors persist the project default and always send the selected level as a per-run override, so the deployment default (step 3) applies to API and queue submissions that omit `involvement` — not to runs submitted from the UI, which always carry an explicit level.

### Injection

The entry role (and only the entry role) receives the involvement level as a paragraph appended to the same system message as the effort directive, so prompts can branch on it. Child roles do **not** receive a global involvement directive — the parent restates the policy in the tasks it delegates. The directive string is a stable contract the Guild prompts depend on:

```
Human involvement: <level>. ...
```

### Surfaces

- `RunMeta.involvement` and `GET /api/runs/:id` carry the run's involvement level.
- An `involvement_set` event `{ involvement }` is logged once at run start, with the level string as the payload value.
- The checkpoint's entry frame carries the level, so a restart-resumed run keeps the same level.
- `GET|PUT /api/settings` read/write the project default alongside `effort` and `logLevel`.
- `deployment.json`'s `executor.defaultInvolvement` sets the deployment-wide default, overridable with `ORCHESTRATOR_INVOLVEMENT`.

## Logging level

The logging level is a per-run choice controlling how much payload detail `log.jsonl` carries. Two levels exist, and the lowercase strings are the wire format everywhere (`POST /api/runs`, `settings.json`, `deployment.json`, `meta.json`, and the checkpoint's entry frame):

- `full` — the default: every event carries its full payload, including each `llm_call`'s complete sent conversation and received response and each `tool_result`'s full un-truncated result.
- `standard` — exactly two slimming rules applied where the event is written; nothing else changes (every event type is still emitted, with identical counts and order):
  - `llm_call`: `payload.sent` and `payload.received` are dropped (with them the `sentFrom` delta marker, which has nothing left to locate); `role`, `roleId`, `messageCount`, `usage`, and `finishReason` are kept.
  - `tool_result`: `payload.result` is dropped; `role`, `tool`, `kind`, `callId`, and any other identity fields (such as `parentCallId`, when present) are kept, so the terminal still matches its invocation.
  - `llm_retry` and `summarizer_llm_call` keep their token-relevant fields (`role`, `roleId`, `discardedAttempts`, and `usage`; and `usage`, respectively — those payloads carry nothing else).

The kept fields are the ones the UI's derivations read: the flow model and the token budgets consume only identities and `usage`, and the inspector transcript's per-turn "on the wire" expanders simply show fewer or empty sections for the slimmed events (the turn header's usage and finish reason stay). The trade-off: under `standard` the conversation bodies of finished roles are never written, so the inquiry handler cannot research what a finished role said or received through `read_run_log`/`search_run_log` (both tools still work for the log's structure — event types, kinds, tool names, and usage).

On resume, a replayed `tool_result` whose body was dropped is restored as a placeholder carrying its retained kind, except that a successful `finish` is reconstructed from its tool-call arguments and a finish whose retained kind is an error becomes an error placeholder and does not end the role; only a result with neither a body nor a valid kind fails fast.

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
- `GET|PUT /api/settings` read/write the project default alongside `effort` and `involvement`.
