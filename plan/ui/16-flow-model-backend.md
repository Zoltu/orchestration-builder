# UI step 16 — Flow model backend (deferred)

## Status

**Deferred.** This step is documented now (out of step 03) so the decision to move the flow-graph model derivation to the backend is not lost. It is sequenced after the phase-A visualization sign-off (step 11) and the guild label tiers (step 12), and is consumed by the live-data hookup (step 13). It is the backend half of the work step 03 deferred.

## Why this is a backend step, not a client derivation

Step 03 originally planned a browser-pure `deriveFlowGraph(config, runView)` that reconstructed the active path, lingering response legs, and in-flight tool nodes from the `RunView` the client receives. That reconstruction is unreliable on the client for two reasons:

- **Truncation.** `/api/runs/:id` ships only the last 200 log events (`recentLog`). Lingering-state detection ("a finished child whose caller hasn't yet acted") depends on event ordering that may fall outside that window for a long run, so a client derivation would silently mis-derive.
- **Per-invocation costs.** The real `RunView` exposes only run-wide budgets and per-role `lastPromptTokens`/`llmCalls`/`toolCalls`. There is no per-invocation or per-role-cumulative time/token field. A client derivation could not produce the per-node costs the view shows without inventing them.

The server has the **full** log and can group events per invocation, so the derivation belongs server-side. The client becomes a render-only consumer of a purpose-built `FlowModel` — the shape step 03's fixtures already author and `flow-view.js` already renders.

## Goal

Add a server-side derivation that turns a run's full log + meta + guild config into the `FlowModel` shape (the contract step 03 fixed), and expose it via new endpoints so step 13 swaps the fixture models for live data with no renderer change.

## The FlowModel contract (fixed in step 03)

```
FlowNode  = { id, kind: 'you'|'role'|'tool', label, column, row, sublabel?, status?, active?, counter?, costTime?, costTokens? }
FlowEdge  = { from, to, kind: 'call'|'return'|'question' }
mainArea  = { nodes: FlowNode[], edges: FlowEdge[] }
TopBarNode = { id, kind, label, invocations, totalTime?, totalTokens?, status? }
topBar    = { nodes: TopBarNode[] }
FlowModel = { mainArea, topBar }
```

## Derivation rules (match the step-03 fixtures)

- **Active call stack.** Walk `roleTree` (already derived by `render.ts` from `role_start`/`role_finished`/`agent_call`) to the single active node (its `active` flag + parent links). Emit `You → entry role → … → active node` as forward `call` edges. `column` = depth (You = 0).
- **Lingering response legs.** Scan the log tail for the last `role_finished`-with-parent / `tool_result` whose caller has not yet emitted a new action (`llm_call`, `tool_call`, or `role_finished`). Emit a `return` edge from the finished child/in-flight tool back to its caller; keep the node in the main area until the caller acts.
- **In-flight tool nodes.** A tool whose `tool_call` has happened but whose `tool_result` has not (or has arrived but the caller hasn't acted) is a node at `column = caller.column + 1`, with a `call` edge from the caller. Tools are not in `roleTree`, so they are derived from the log.
- **"Backwards always means return."** A repeated role is a new node at the next column (a forward `call` edge); the only right-to-left movement is a `return` edge.
- **"You" root + child "You".** A root "You" is always at column 0. An `ask_human` produces a child "You" node with a `question` edge from the `ask_human` tool node to the child "You"; the child "You" lingers as a `return` edge after the `human_answer`, then departs when the caller acts.
- **Interrupt rows.** A user interrupt or loop-detector `trigger_interrupt` creates a new root at column 0 on a new `row`, with edges pointing at the nodes it was inspecting.
- **Per-invocation accumulated costs.** Group log events per invocation (a `role_start`…`role_finished` span, or a `tool_call`…`tool_result` span). `costTokens` = sum of `usage.totalTokens` across the invocation's `llm_call`s (the active node sums up to `now` when in-flight). `costTime` = `finish − start` (or `now − start` while in-flight). Tools sum their own `tool_call`…`tool_result` span.
- **Top bar.** One node per role-type and per tool-type (and "You") that has ever run, ordered by first appearance, with cumulative `invocations`, `totalTime`, `totalTokens`, and a terminal `status` (the worst status seen for that type, so a failed role's slot reads error).

## Deliverables

1. **`source/web/flow-model.ts`** (new) — a pure `deriveFlowModel(snapshot, config, now): FlowModel` function (and the `FlowModel`/`FlowNode`/`FlowEdge`/`TopBarNode` interfaces exported for the renderer and tests). Pure: given the full log + meta + config + `now`, a deterministic `FlowModel`. Tested in-memory against synthetic log sequences (the same scenarios the fixtures author: single-role, delegation, retry mid-frame, pending question, self-delegation, deep tree, interrupt). No `as` casts; external data (`LogEvent` payloads) narrowed with type guards.
2. **`source/web/flow-model.test.ts`** (new, in-memory) — the derivation rules above, asserted against hand-built log sequences (not the fixtures; the fixtures are the *renderer's* test bed and stay hand-authored). Covers: active-path-only main area (retry mid-frame shows only `You → orchestrator → coder`), lingering return legs, in-flight tool nodes, "You" root + child "You" + `question` edge, "backwards = return", interrupt rows, per-invocation cost accumulation, top-bar cumulative stats and worst-status.
3. **`source/web/server.ts`** — new endpoints `GET /api/runs/:id/flow` and `GET /api/run/flow` (alias to the active run, mirroring `/api/runs/:id` and `/api/run`) that call `deriveFlowModel` with the full snapshot. `format=text` is not needed (the model is structured). Reuse the existing `runViewFor`/`isKnownRun` helpers.
4. **`source/web/server.test.ts`** — endpoint cases: known/unknown run, the active-run alias, and one derivation-shape assertion against a tree-bearing run snapshot (e.g. `run-retry`).
5. **`source/web/static/fixtures.js`** — leave the hand-authored `flowModel` frames in place (they remain the renderer's test bed and the playback harness's data source until step 13); this step does not touch them.

## Module boundaries

- The derivation is a pure function in a `source/web/*.ts` module (it can import `render.ts`'s `deriveRoleTree`/`LogEvent` types and `executor/validation.js`, unlike the browser-pure `flow-view.js`). It is tested in-memory; the server is a thin leaf that delegates to it.
- No executor-runtime changes: the derivation reads the persisted log + meta, the same artifacts `render.ts` already reads. Per-invocation costs are *derived*, not newly emitted by the executor.
- No new dependencies. The new endpoints reuse the existing static-asset + JSON-response helpers.
- `flow-view.js` (the renderer) is unchanged by this step — step 13 points it at the live endpoint instead of the fixture model.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] `deriveFlowModel` produces the same shapes the step-03 fixtures author, for each scenario's representative frame.
- [ ] The main area is active-path-only (retry mid-frame: only `You → orchestrator → coder`).
- [ ] Lingering return legs and in-flight tool nodes are derived from the full log, not the truncated `recentLog`.
- [ ] Per-invocation `costTime`/`costTokens` and top-bar cumulative `totalTime`/`totalTokens` are derived from log usage + event timestamps.
- [ ] `GET /api/runs/:id/flow` and `GET /api/run/flow` return the model; 404 for unknown runs.

## Sequencing

After step 12 (guild label tiers, so the model's friendly labels resolve from the live config) and before step 13 (live-data hookup). Step 13 swaps the playback harness's fixture model for `fetch('/api/run/flow')` and the run view points `flow-view.js` at the same endpoint — a data-source swap, not a renderer rewrite, because step 03 already rendered the contract this step produces.
