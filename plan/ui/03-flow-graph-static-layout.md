# UI step 03 — Flow graph: static render-only view against a FlowModel

## Goal

Build the two-component flow view as a **render-only client**: a **history top bar** (small nodes, cumulative stats, one per role-type and per tool-type and "You" that has ever run) and a **main area** (left-to-right, only active + lingering nodes, call-depth columns, straight anchor edges). The view consumes a hand-authored `FlowModel` carried on each fixture frame — the exact shape the future `/api/runs/:id/flow` endpoint will return — so the visualization is iterated against the step-01 fixture timelines without any backend work this step. The view is static this step (animation, lifecycle transitions, and flow direction are step 04).

This step **does not** build a client-side derivation (`deriveFlowGraph`) and **does not** wire the pathfinding library into the flow view. The decision to move the model derivation to the backend (so the frontend never reconstructs active-path/lingering/in-flight state from a truncated log) is recorded in [`16-flow-model-backend.md`](16-flow-model-backend.md); this step builds the renderer that step 13 will point at the live endpoint.

## Context

Read [`PLAN.md`](PLAN.md) ("Flow view (default)" — the two-component design), [`02-visual-foundation-tokens-svg-primitives.md`](02-visual-foundation-tokens-svg-primitives.md) (the SVG primitives + tokens this builds on), `source/web/static/svg-primitives.js` (`GraphNode`, `GraphEdge`, `nodeAnchor`, `NODE_WIDTH`, `NODE_HEIGHT` — reused here), `source/web/static/fixtures.js` (the frames, now extended with `flowModel`), and `source/web/render.ts` (`RunView`, `RoleTreeNode`, `RoleActivity` — the shapes the `runView` half of each frame matches).

### Design: the FlowModel contract (the future endpoint shape)

Each fixture frame now carries a `flowModel` shaped exactly like the future `/api/runs/:id/flow` response:

- **`mainArea`**: `{ nodes, edges }` — only active + lingering nodes and their edges. A node is `{ id, kind: 'you'|'role'|'tool', label, column, row, sublabel?, status?, active?, counter?, costTime?, costTokens? }`. An edge is `{ from, to, kind: 'call'|'return'|'question' }`. `column` is call depth (You = 0); `row` is 0 for the single root and increments for interrupt-started rows. `costTime`/`costTokens` are per-invocation accumulators the backend derivation will populate; fixtures fill them with plausible values now so the view exercises them.
- **`topBar`**: `{ nodes }` — one small node per role-type and per tool-type (and "You") that has ever run, with cumulative stats `{ id, kind, label, invocations, totalTime?, totalTokens?, status? }`. Ordered by first appearance; the renderer wraps them into rows.

### Design: current state only

The model is current-state, not history. The main area holds only the active call-stack chain plus lingering response legs (a finished child or in-flight tool whose caller has not yet acted), so it stays calm regardless of run length. "Backwards always means return": a repeated role is a new node at the next column (a forward call edge); the only right-to-left movement is a return edge.

### Design: edges are straight anchor curves (no pathfinding this step)

Main-area edges are straight cubic curves between face anchors: call and question edges leave the source's right face and enter the target's left face (left→right); return edges leave the source's left face and enter the target's right face (right→left). The active path is a 1–5 node chain plus one lingering return leg, so orthogonal no-intersection routing is not needed yet. The pathfinding library stays on disk (built/tested in its own step) for the future sequence diagram and for cycles/interrupts if the simple layout proves limiting; it is not wired into the flow view.

### Design: every tool is its own node; "You" is the root

Each tool appears as its own node — in the main area only when a call to it is in flight, in the top bar once it has ever been called. A root "You" is always present in the main area at column 0; a child "You" appears (like any agent node) when an agent asks a question via `ask_human`, with a `question` edge from the `ask_human` tool to the child "You".

## Deliverables

1. **`source/web/static/flow-view.js`** (new, browser-pure) — `renderFlowView(h, model)` returns the two-component vnode tree: the top bar (a compact `SmallNode` per history entry, wrapped into rows of `TOP_BAR_PER_ROW`) and the main area (a `GraphNode` per node translated to its `(column, row)` pixel position, edges rendered via `GraphEdge` between face anchors). All edges are `static` this step. `h` is passed in (mirroring `svg-primitives.js`) so the vnode shape is testable with a fake. Exports `renderFlowView` and `FLOW_VIEW_CONSTANTS` (the layout/wrapping constants).
2. **`source/web/static/fixtures.js`** — extend each frame to carry a hand-authored `flowModel` for all 13 scenarios, built from new `flowNode`/`flowEdge`/`topBarNode`/`flowModel` helpers that resolve friendly labels from the frame's config. The `frame()` builder extracts `flowModel` so it never leaks into the `runView` builder.
3. **`source/web/flow-view.test.ts`** (new, in-memory) — a `FlowModel` shape guard run over every fixture frame (contract conformance, edge endpoints exist, "You" always at column 0), plus renderer tests with a fake `h`: the two-SVG wrapper, viewBox sizing to laid-out content, column/row→pixel translates, call-edge (right→left face) and return-edge (left→right face) anchor selection, edges-before-nodes paint order, unknown-endpoint edges dropped, top-bar small-node shape and status class, and top-bar row wrapping.
4. **`source/web/static/playback.js`** — replace the step-02 `PrimitivesDemo` with a `FlowView` that renders the current frame's `flowModel` via `renderFlowView`; re-renders each frame.
5. **`source/web/static/styles.css`** — the two-component layout (wrapping top-bar strip, spacious left-to-right main area, static edge stroke) plus `flow-small-node-*` styles (compact box, label, count, success/error/interrupted status hooks), all theme-aware via the existing `--svg-*` tokens.
6. **`source/web/server.ts`** — add a `/flow-view.js` static-asset route; one `server.test.ts` case (mirrors the `svg-primitives.js` precedent).
7. **`docs/security.md`** — note the flow view renders only machine fields and trusted guild labels as SVG `<text>` `textContent`; no agent-authored prose reaches the SVG; edges are straight curves with no text.

## Module boundaries

- Web-only, fixture-driven. `flow-view.js` is browser-pure and imports only its sibling `svg-primitives.js` (also browser-pure), matching the `fixtures.js`/`svg-primitives.js` convention. `flow-view.test.ts` imports it from the filesystem. No backend or endpoint changes beyond the additive `/flow-view.js` asset route.
- No client-side derivation this step: the model is hand-authored in fixtures, so `flow-view.js` is a thin, testable renderer. The server-side derivation that produces the same `FlowModel` from the full log is step 16 (deferred).
- The pathfinding library (`pathfinding.js`) stays built and tested but is **not** wired into the flow view this step.
- No new dependencies. SVG is hyperapp vnodes; edges are `<path>` elements from `GraphEdge`.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The main area shows only active + lingering nodes; finished-and-departed nodes have no edges (verified against the retry fixture: mid-retry shows only `You → orchestrator → coder`, the first coder's edges are gone).
- [ ] Lingering response legs are shown (tool→caller, child→parent) until the caller acts.
- [ ] Every tool is its own node (not bundled); a tool node appears only when a call to it is in flight.
- [ ] "You" is always the root in column 0; a child "You" appears for `ask_human` with a `question` edge.
- [ ] The top bar shows one node per role-type and per tool-type (and "You") that has ever run, with cumulative stats, wrapped into rows.
- [ ] "Backwards always means return": a second call to a role places a new node to the right.
- [ ] No agent prose is rendered by the graph; only `textContent`-safe machine fields and trusted labels.

## Operator handoff

Scrub through the fixtures in the playback harness. Confirm the two-component view reads well: the main area shows only what's happening now (plus lingering returns), the top bar accumulates history compactly, edges route cleanly, and every scenario (retry, pending question, self-delegation, deep tree, large guild, interrupt) presents legibly. Report layout/spacing/routing adjustments.
