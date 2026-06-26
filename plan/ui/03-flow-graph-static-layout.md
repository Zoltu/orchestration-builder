# UI step 03 — Flow graph: active-flow + history strip + pathfinding

## Goal

Build the two-component flow view: a **history top bar** (small nodes, cumulative stats, one per role-type and per tool-type that has ever run) and a **main area** (left-to-right, only active + lingering nodes, call-depth columns). Edges in the main area are routed orthogonally via the pathfinding library (`source/web/static/pathfinding.js`, already built and tested). The view is static this step — animation, lifecycle transitions, and flow direction are step 04. Iterated against the step-01 fixture timelines via the playback harness.

## Context

Read [`PLAN.md`](PLAN.md) ("Flow view (default)" — the two-component design), [`02-visual-foundation-tokens-svg-primitives.md`](02-visual-foundation-tokens-svg-primitives.md) (the SVG primitives + tokens this builds on), `source/web/static/pathfinding.js` (the edge-routing library: `routeEdges`, `gridToPixel`, `portPixel`), `source/web/static/fixtures.js` (the mock `{ config, runView, now }` frames), and `source/web/render.ts` (`RunView`, `RoleTreeNode`, `RoleActivity`, `LogEvent` — the real shapes the fixtures match).

### Design: current state only

The graph shows **current state**, not history. Edges are derived from the active call stack and pending response legs, not from the full role tree or the full log. Specifically:

- **Active call stack edges:** the root→active-node chain from `roleTree`. Only the path from the root to the single active node (plus any lingering returns) is shown. If `planner` has finished and `orchestrator` has moved on to `coder`, the `planner` node has no edges — only `You → orchestrator → coder` is visible. The `planner` node's counter and cumulative stats are still in the top bar.
- **Lingering response legs:** when a node finishes (a child role returns via `role_finished`, or a tool result arrives via `tool_result`), it lingers in the main area with a response edge pointing back to its caller until the caller emits a new action (`llm_call`, `tool_call`, or `role_finished`). This makes the "tool → builder" and "agent → caller" response legs visible while the caller hasn't yet acted.
- **"Backwards always means return."** A call always places the new node to the right, even if the target role appeared earlier in the path (e.g., `A → B → C → B` places the second `B` at column 4, not a return edge). The only leftward movement is a response edge.

### Design: every tool is its own node

Tools are not bundled. Each tool appears as its own node — in the main area only when a call to it is in flight (the `tool_call` has happened but the `tool_result` has not, or the `tool_result` has arrived but the caller hasn't yet acted), and in the top bar once it has ever been called. A tool node lingers as a response edge (tool → caller) until the caller acts, same as an agent.

### Design: "You" node

A root "You" is always present in the main area at column 1, the root of every call stack, until the task fully finishes (then it animates to the top bar in step 04; this step just shows it as present). A child "You" can also appear — like any agent node — when an agent asks a question via `ask_human`. The child "You" lingers as a response edge after the user answers, then departs to the top bar when the caller acts (step 04 animation; this step shows the edge).

### Design: layout

The main area is laid out left-to-right by call depth. Column = depth in the active call stack. A role can appear multiple times (once per active invocation). Rows come from interrupts (a new root at column 1 starts a new row). The top bar wraps to multiple rows of small nodes, ordered by first-appearance.

### Design: edge routing

Main-area edges are routed via `routeEdges` from `pathfinding.js`. Nodes occupy cells on a coarse grid; corridors between cells provide lanes for paths. Edges leave the source's right face and enter the target's left face, routed as orthogonal elbow paths that avoid node interiors and never intersect previously routed paths. When multiple edges share a node face, port slots spread outward from the face center (0, +1, -1, +2, -2, …). Self-loops (a role delegating to itself) dip below the node.

## Deliverables

1. **`source/web/static/flow-graph.js`** (new, browser-pure) — `deriveFlowGraph(config, runView)` returns a `FlowGraph` with:
   - **`mainArea`**: `{ nodes, edges, viewBox }` — only active + lingering nodes and their edges. Nodes carry per-invocation stats (this call's time/tokens, status, active flag). Edges are `{ from, to, kind }` where kind is `'call'` (forward, left→right), `'return'` (lingering response, right→left), or `'question'` (ask_human, an agent→You call edge). A node lingers when its most recent event is a return (`role_finished` with a parent, or `tool_result`) and the caller has not yet emitted a new action.
   - **`topBar`**: `{ nodes, rows }` — one small node per role-type and per tool-type (and "You") that has ever run this session, with cumulative stats (total invocations, total time, total tokens). Ordered by first appearance; wrapped into rows.
   - The derivation is pure: given `{ config, runView }`, a deterministic `FlowGraph`. It consumes the real `/api/config` + `/api/runs/:id` shape (extended with the future tiered labels), so step 13 is a data-source swap.
2. **`source/web/flow-graph.test.ts`** (new, in-memory) — cover the derivation against the fixtures:
   - Active call stack: only the root→active-node chain is shown; finished-and-departed nodes have no edges in the main area (verified against the retry fixture's mid-retry frame: only `You → orchestrator → coder` is visible, the first coder's edges are gone).
   - Lingering response legs: a tool_call with no tool_result yet shows the call edge; a role_finished with a parent shows the return edge until the caller acts.
   - Every tool is its own node (not bundled); a tool node appears only when a call to it is in flight.
   - "You" is always the root in column 1; a child "You" appears for ask_human.
   - Top bar: one node per role-type and per tool-type that has ever run, with cumulative stats; ordered by first appearance.
   - "Backwards always means return": a second call to a role that appeared earlier places a new node to the right.
3. **`source/web/static/playback.js`** — replace the step-02 `PrimitivesDemo` with a `FlowView` that renders the two-component view: the top bar (small nodes via a compact `GraphNode` variant or a new `SmallNode` primitive) and the main area (nodes via `GraphNode` at their call-depth positions, edges routed via `routeEdges` and rendered as SVG `<path>` elements). Static only — every edge is `static` (the flow animation is step 04). The playback harness's frame-stepping re-derives the graph each frame.
4. **`source/web/static/styles.css`** — styles for the two-component layout: the top bar strip (wrapping, small nodes), the main area (left-to-right, spacious), edge path styling (static stroke). Theme-aware (light/dark tokens from step 02).
5. **`source/web/server.ts`** — add a `/flow-graph.js` static-asset route (the module lives under `static/`, same as `pathfinding.js` and `fixtures.js`). One `server.test.ts` case.
6. **`docs/security.md`** — note the flow view renders only machine fields and trusted guild labels as SVG `<text>` textContent (role/tool names, counters, per-node stats, "You" label); no agent-authored prose is rendered by the graph. The pathfinding library operates on grid coordinates and renders no text at all.

## Module boundaries

- Web-only, fixture-driven. `flow-graph.js` is browser-pure (no imports), matching the `fixtures.js`/`pathfinding.js`/`svg-primitives.js` convention. `flow-graph.test.ts` imports it from the filesystem. No backend or endpoint changes beyond the additive `/flow-graph.js` asset route.
- The pathfinding library (`pathfinding.js`) is already built and tested (18 tests); this step integrates it into the rendering pipeline. No changes to `pathfinding.js` are expected.
- No new dependencies. SVG is hyperapp vnodes; edges are `<path>` elements from the pathfinding library's grid paths converted to pixel coordinates via `gridToPixel`/`portPixel`.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The main area shows only active + lingering nodes; finished-and-departed nodes have no edges (verified against the retry fixture).
- [ ] Lingering response legs are shown (tool→caller, child→parent) until the caller acts.
- [ ] Every tool is its own node (not bundled); a tool node appears only when a call to it is in flight.
- [ ] "You" is always the root in column 1; a child "You" appears for ask_human.
- [ ] The top bar shows one node per role-type and per tool-type that has ever run, with cumulative stats.
- [ ] "Backwards always means return": a second call to a role places a new node to the right.
- [ ] Edges are routed orthogonally via the pathfinding library (out on the right, in on the left, no intersection, port allocation for cycles).
- [ ] No agent prose is rendered by the graph; only `textContent`-safe machine fields and trusted labels.

## Operator handoff

Scrub through the fixtures in the playback harness. Confirm the two-component view reads well: the main area shows only what's happening now (plus lingering returns), the top bar accumulates history compactly, edges route cleanly without crossing nodes, and every scenario (retry, pending question, self-delegation, deep tree, large guild) presents legibly. Report layout/spacing/routing adjustments.
