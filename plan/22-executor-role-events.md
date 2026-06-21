# Step 22 — Executor role-tree log events

## Goal

Emit structured log events when a child role is spawned and when a role completes, so the executor's own `log.jsonl` records a faithful parent-child role tree. This is the removal work for the tracked-debt row introduced in step 11: today `agent` tool-call log events carry only the parent role and tool name, so the web UI cannot reconstruct the tree and renders role *activity* instead. With structured spawn/finish events carrying parent, child, and depth, `render.ts` can build the real tree.

## Context

Read [`11-web-ui-server.md`](11-web-ui-server.md) (the debt row and its Closeout decision #2), `docs/executor.md` ("Sequential scheduling", "Run lifecycle"), and `source/executor/engine.ts`. The executor is strictly sequential and depth-first: when an `agent` call is made the child runs to completion before the parent continues. That traversal is exactly the tree the UI needs, and it is already happening — it just is not being logged with enough structure.

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
2. `source/executor/engine.test.ts` — extend existing run/agent tests to assert: an entry-role run logs exactly one `role_start` with `parent` omitted; a parent→child run logs `role_start` for the child carrying the correct `parent` and `depth`; `role_finished` now carries `depth` and `parent`; an `agent_call` event links parent to child. Keep existing event-shape assertions passing (additive change).
3. `source/executor/executor.test.ts` — extend the end-to-end in-memory test (and any fixture that asserts event types) to include the new event types where relevant without dropping the old ones.
4. `source/web/render.ts` — extend `deriveRoleActivity` (or add a sibling `deriveRoleTree`) to build a parent→children tree from `role_start`/`role_finished`/`agent_call` events when they are present, falling back to the activity summary when they are absent (so a partial log or a pre-step-22 log still renders). Add a `roles` field shape that includes the tree where available.
5. `source/web/render.test.ts` — cover tree derivation (entry role with no parent, a parent with multiple children, a child's parent pointer, depth ordering) and the fallback-when-events-absent path.
6. `source/web/server.test.ts` — update the fixture log so the `/api/run` view exercises the new tree shape.
7. `docs/executor.md` — document the new event types in the "Run lifecycle" / event list, naming the payload fields. The doc outlives the plan and is the reference for the event contract.

## Module boundaries

- All logging stays in the executor (engine), unchanged in shape: the existing `logEvent(appendLog, type, payload)` helper is the only emission point.
- The web layer only *reads* the richer log; no executor→web coupling is introduced.
- Do not change `LogEvent`'s `payload: unknown` type in `source/shared/types.ts` — the richer shape is a documented payload contract for specific event types, not a typed union.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] A parent→child run produces `role_start` and `agent_call` events whose payloads carry `parent`, `child`, and `depth`.
- [ ] `role_finished` carries `depth` and optional `parent` (additive — existing readers still pass).
- [ ] `render.ts` builds a parent→children tree from the new events and falls back to role activity when they are absent.
- [ ] The step-11 tracked-debt row is removed from `plan/README.md` and this step's "Tracked technical debt" section records the removal.
- [ ] No new dependencies.

## Tracked technical debt

- **Removes** the step-11 debt: "Web UI renders role *activity* not a role *tree*." After this step, the UI renders the real tree from executor events. Delete that row from `plan/README.md` when the removal is verified.

## End-of-step evaluation

Re-read `engine.ts` around the `spawnAgent` closure and the top of `runRole`: confirm every role that runs emits exactly one `role_start` and one `role_finished`, including the depth-exceeded early-return path (a refused `agent` call should not emit a `role_start` for a child that never runs). Confirm the additive payload changes do not break any existing `executor.test.ts` / `engine.test.ts` assertion that reads `role` from a `role_finished` payload. Confirm `render.ts`'s fallback keeps an old `log.jsonl` (pre-step-22) rendering as the activity summary, not as an empty tree.

## Estimated effort

Small-medium — the events are local to the engine; the care is in keeping the change additive and in the render-side fallback.

## Operator handoff

None — fully in-memory.
