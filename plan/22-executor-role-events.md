# Step 22 — Executor role-tree log events

## Goal

Emit structured log events when a child role is spawned and when a role completes, so the executor's own `log.jsonl` records a faithful parent-child role tree. This is the removal work for the tracked-debt row introduced in step 11: today `agent` tool-call log events carry only the parent role and tool name, so the web UI cannot reconstruct the tree and renders role *activity* instead. With structured spawn/finish events carrying parent, child, and depth, `render.ts` can build the real tree.

## Context

Read [`11-web-ui-server.md`](11-web-ui-server.md) (the debt row and its Closeout decision #2), `docs/reference.md` ("Sequential scheduling", "Run lifecycle"), and `source/executor/engine.ts`. The executor is strictly sequential and depth-first: when an `agent` call is made the child runs to completion before the parent continues. That traversal is exactly the tree the UI needs, and it is already happening — it just is not being logged with enough structure.

Today the engine logs:
- `depth_exceeded` with `{ parent, child, depth }` (when an agent call is refused).
- `tool_call` with `{ role: parent, tool: 'agent' }` (the agent tool call itself, carrying only the parent role).
- `role_finished` with `{ role, status }` (when a role returns a final card).
- `role_not_found` (parent + child when a child role name is invalid).

What is missing is the linkage that ties a child run to its parent and records its depth. A role-start event emitted right before the child runs, plus a parent reference on role finish, is enough. The events must be backward-compatible additions: existing consumers (`executor.test.ts`, the foundry) read these events and must not break — add new event types and/or new payload fields rather than renaming existing ones.

## Deliverables

1. `source/executor/engine.ts` — emit two new log events:
   - `role_start`: `{ role, depth, task, parent }` where `parent` is the calling role's name (omitted for the entry role at depth 0). Emit at the top of `runRole` after the role definition is confirmed to exist (so `role_not_found` still fires for unknown roles and there is no orphan `role_start`).
   - `role_finish` (or extend `role_finished`): `{ role, depth, status, parent }` — emitted alongside the existing `role_finished` log. Prefer extending the existing `role_finished` payload with `depth` and optional `parent` (additive, existing readers keep working) rather than introducing a parallel event.
   - Extend `agent_call` / the agent tool-call path to log `{ parent, child, depth, budget }` when the agent tool is invoked (before the child runs), so the tool-call log carries the parent→child edge even for callers that do not read `role_start`. Use a new event type such as `agent_call` to avoid overloading `tool_call`.
2. **Rich LLM/tool payloads.** `log.jsonl` must carry the full request/response detail a reviewer needs to reconstruct what the model did, not just a one-line summary. Extend the engine's emission points (all additive — new payload fields, no renames) so that:
   - The `llm_call` event payload includes the **message list sent** (each message's `role` and `content`; `reasoning` omitted; `tool_calls` on assistant messages included) alongside the existing `messageCount`. The message list is what was sent to the endpoint for this turn.
   - The `llm_call` event payload includes the **assistant response** actually received: `content`, `reasoning` (if the model returned any), the parsed `tool_calls` (each call's `id`, `function.name`, and `function.arguments`), and the **`finishReason`** from the OpenAI `choices[0].finish_reason` (e.g. `stop`, `length`, `tool_calls`, `content_filter`) so a reviewer can tell why the model stopped emitting.
   - The `llm_call` event payload includes the per-call **usage metrics**: `promptTokens` and `completionTokens` from the response's `usage` object. (These are already accumulated into the role's running totals; logging them per call makes each turn's cost visible without differencing.)
   - **Capturing `finishReason` requires an additive change to the LLM layer, not just the engine.** `parseOpenAiResponse` (`source/executor/llm.ts`) currently reads `choices[0].message` and `usage` but discards `choices[0].finish_reason`. Add `finishReason?: string` to the success variant of `LlmCallResult` (additive — existing callers that do not read it keep working) and populate it in the parser from `firstChoice['finish_reason']` when it is a string. The LLM caller is a leaf and is not unit-tested; the engine test exercises this field via a fake `LlmCaller` whose canned response includes `finishReason`, and `llm.test.ts` (if present) or the integration test covers the parser reading it from a shaped OpenAI response. `usage` needs no LLM-layer change — it is already on `LlmCallResult`.
   - The `tool_call` event payload includes the **arguments** the model passed: `{ role, tool, arguments }` where `arguments` is the raw JSON-arguments string from the `ToolCall` (so the exact parameters are recoverable).
   - The `tool_result` event payload includes the **full `ToolResult`**: `{ role, tool, kind, result }` where `result` is the full `ToolResult` object (`{ kind: 'success', data }` or `{ kind, message, details }`) before truncation. Truncation still applies when the result is appended to the conversation (that contract is unchanged); the log records the un-truncated result so a reviewer is not flying blind on what a tool actually returned.
   - Keep payload size bounded by the existing `contextPolicy.maxToolOutputChars` only for what is appended to the conversation, **not** for what is logged — the log is the audit trail and must not silently drop the real result. If a result is genuinely enormous (e.g. a directory listing of thousands of files), record it in full; the log is append-only and a reviewer can truncate when reading.
   - **The `llm_call` event must move from before the call to after `handleLlmResult`.** Today it is emitted at `engine.ts:312` (before `deps.llmCaller.call`) carrying only `{role, messageCount}`, because the response is not yet known. To carry the sent messages, the received response, `finishReason`, and per-call usage in one event, emit it after `handleLlmResult` has run (so `llmResult` is available) but only on the `continue`/`tool_calls` paths and the success-`finished` path — the `llm_unavailable` and `context_budget_exceeded` paths already log their own dedicated events and must not emit a misleading `llm_call`. On the success paths the sent-message list is `messages` (built by `buildMessages` just before the call) and the response fields come from `llmResult`. This reorder is internal to the `runRole` loop and does not change the loop's control flow.
3. `source/executor/engine.test.ts` — extend existing run/agent tests to assert: an entry-role run logs exactly one `role_start` with `parent` omitted; a parent→child run logs `role_start` for the child carrying the correct `parent` and `depth`; `role_finished` now carries `depth` and `parent`; an `agent_call` event links parent to child. Add assertions that the `llm_call` payload carries the sent message list, the received assistant response (content + tool_calls with name+arguments), the `finishReason`, and the per-call `usage` (`promptTokens`/`completionTokens`); that `tool_call` carries the model's raw `arguments`; and that `tool_result` carries the full un-truncated `ToolResult`. The fakes' canned `LlmCallResult` responses must include a `finishReason` field so the assertion is exercisable. Keep existing event-shape assertions passing (additive change).
4. `source/executor/executor.test.ts` — extend the end-to-end in-memory test (and any fixture that asserts event types) to include the new event types where relevant without dropping the old ones.
5. `source/web/render.ts` — extend `deriveRoleActivity` (or add a sibling `deriveRoleTree`) to build a parent→children tree from `role_start`/`role_finished`/`agent_call` events when they are present, falling back to the activity summary when they are absent (so a partial log or a pre-step-22 log still renders). Add a `roles` field shape that includes the tree where available. **Also extend the raw-payload detail the UI surfaces from the `recentLog` entries:** because `llm_call`, `tool_call`, and `tool_result` now carry their full paired content (sent messages + assistant response + finishReason + usage; tool call arguments + full result), `formatLogEvent`'s raw toggle should present these as **paired sections** rather than a single blob — an `llm_call` shows "sent" (messages), "received" (assistant content + tool_calls), "finish reason", and "usage"; a `tool_call`/`tool_result` pair shows the call's arguments next to its full result. Keep the rendering `textContent`-only (a `JSON.stringify` into `textContent` is safe).
6. `source/web/render.test.ts` — cover tree derivation (entry role with no parent, a parent with multiple children, a child's parent pointer, depth ordering) and the fallback-when-events-absent path. Cover the paired raw-payload shaping for `llm_call` (messages + response + finishReason + usage) and `tool_call`/`tool_result` (arguments + full result).
7. `source/web/server.test.ts` — update the fixture log so the `/api/run` view exercises the new tree shape and the rich `llm_call`/`tool_call`/`tool_result` payloads.
8. `docs/reference.md` — document the new event types in the "Run lifecycle" / event list, naming the payload fields. The doc outlives the plan and is the reference for the event contract.

## Module boundaries

- All logging stays in the executor (engine), unchanged in shape: the existing `logEvent(appendLog, type, payload)` helper is the only emission point.
- The web layer only *reads* the richer log; no executor→web coupling is introduced.
- Do not change `LogEvent`'s `payload: unknown` type in `source/shared/types.ts` — the richer shape is a documented payload contract for specific event types, not a typed union.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] A parent→child run produces `role_start` and `agent_call` events whose payloads carry `parent`, `child`, and `depth`.
- [ ] `role_finished` carries `depth` and optional `parent` (additive — existing readers still pass).
- [ ] `render.ts` builds a parent→children tree from the new events and falls back to role activity when they are absent.
- [ ] `log.jsonl`'s `llm_call` payload carries the sent message list, the received assistant response (content + tool_calls with name+arguments), the `finishReason`, and the per-call `usage` (`promptTokens`/`completionTokens`).
- [ ] `LlmCallResult`'s success variant includes an additive `finishReason?: string`, populated by `parseOpenAiResponse` from `choices[0].finish_reason`; existing callers that do not read it still compile and pass.
- [ ] `log.jsonl`'s `tool_call` payload carries the model's raw `arguments`, and `tool_result` carries the full un-truncated `ToolResult`.
- [ ] The web UI's raw-payload toggle for an `llm_call` shows the sent messages, the received response, the finish reason, and the usage as paired sections; a `tool_call`/`tool_result` pair shows the call's arguments next to its full result.
- [ ] The step-11 tracked-debt row is removed from `plan/README.md` and this step's "Tracked technical debt" section records the removal.
- [ ] No new dependencies.

## Tracked technical debt

- **Removes** the step-11 debt: "Web UI renders role *activity* not a role *tree*." After this step, the UI renders the real tree from executor events. Delete that row from `plan/README.md` when the removal is verified.

## End-of-step evaluation

Re-read `engine.ts` around the `spawnAgent` closure and the top of `runRole`: confirm every role that runs emits exactly one `role_start` and one `role_finished`, including the depth-exceeded early-return path (a refused `agent` call should not emit a `role_start` for a child that never runs). Confirm the additive payload changes do not break any existing `executor.test.ts` / `engine.test.ts` assertion that reads `role` from a `role_finished` payload. Confirm `render.ts`'s fallback keeps an old `log.jsonl` (pre-step-22) rendering as the activity summary, not as an empty tree. Confirm the rich `llm_call` / `tool_call` / `tool_result` payloads do not duplicate-truncate: truncation is applied only when appending to the conversation, never to what is written to the log. Confirm the `llm_call` event's move to after `handleLlmResult` did not cause an `llm_call` to be emitted on the `llm_unavailable` or `context_budget_exceeded` paths (those keep their own dedicated events). Confirm `finishReason` is read from `choices[0].finish_reason` in the parser and is absent (not a default like `""`) when the endpoint omits it, so a reviewer can distinguish "model stopped" from "field missing". Confirm a reviewer reading only `log.jsonl` can reconstruct the full sent message list, the model's response (content + reasoning + tool_calls), why the model stopped (`finishReason`), the per-turn token cost (`usage`), the exact arguments of every tool call, and the full result of every tool — with nothing silently dropped.

## Estimated effort

Small-medium — the events are local to the engine; the care is in keeping the change additive and in the render-side fallback. The `finishReason` capture adds one small field to the LLM parser and `LlmCallResult` (additive, no caller breakage); the per-call `usage` and the `llm_call`-after-`handleLlmResult` reorder are both engine-local. The render-side tree builder is the largest single piece but is a pure function over the event list with a clean fallback.

## Operator handoff

None — fully in-memory.
