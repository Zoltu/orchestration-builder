# UI step 04 — Flow graph: node lifecycle + merge + edge flow animation

## Goal

Bring the two-component flow view to life with three kinds of animation: (1) **node lifecycle transitions** — entering, shrinking to the top bar, and merging with an existing top-bar slot; (2) **edge flow animation** — marching-ants on active/lingering edges with directionality (forward calls flow left→right, response legs flow right→left); (3) **active node pulse**. All at **turn granularity** (non-streaming). Iterated against the step-01 fixture timelines via the playback harness.

## Context

Read [`PLAN.md`](PLAN.md) ("Flow view (default)" — flow animation, lingering response legs, merge animation), [`03-flow-graph-static-layout.md`](03-flow-graph-static-layout.md) (the two-component `FlowGraph` state: `mainArea` nodes/edges + `topBar` nodes), and `source/web/render.ts` (`LogEvent` types — the events that drive the flow semantics). The turn-level flow mapping, buildable today without executor changes:

- **Agent → agent forward flow:** from `agent_call`/`role_start` (start) until the child's **first `llm_call`** (first turn done). Then a new flow starts from that child toward its tool or child.
- **Agent → tool forward flow:** from `tool_call` (start) to `tool_result` (end).
- **Tool → agent return flow:** on `tool_result`, the response edge flows right→left back to the calling agent.
- **Agent → agent return flow:** on `role_finished` (child returning to parent), the response edge flows right→left back to the parent, and lingers until the parent emits a new action.

Token-level "flow until first byte" is step 15 (deferred, executor-dependent). The playback harness's frame timeline is what makes the animation iterable without a real run — scrubbing frames steps the animation deterministically.

### Node lifecycle transitions

When the `FlowGraph` derivation changes between frames (the playback harness steps frames, or the live poll refreshes), nodes transition between the main area and the top bar:

- **Entering:** a new node appears in the main area at its assigned call-depth position. A brief scale/fade-in.
- **Shrinking to the top bar:** when a node finishes and its caller has acted (the lingering response leg is over), the node animates from its main-area position and size to its type's top-bar slot, shrinking from the full node size to the small top-bar node size.
- **Merging:** if the node's type already has a slot in the top bar, the departing node moves to the existing slot's position and fades out, and the existing slot's counter increments. If no slot exists yet, the node shrinks into a new slot.

The animation is driven by diffing the current frame's `FlowGraph` against the previous frame's: a node present last frame but only in the top bar this frame is a "departing" node; a node in the main area this frame but not last frame is an "entering" node.

### Edge flow animation

Edges in the main area animate based on their kind and the current turn state:

- **`'call'` edges (forward):** marching-ants `stroke-dasharray` animation flowing left→right. Active while the call is in flight (the child hasn't produced its first `llm_call` yet, or the tool result hasn't arrived yet).
- **`'return'` edges (lingering response):** marching-ants flowing right→left. Active while the response leg is visible (the caller hasn't yet acted).
- **`'question'` edges (ask_human):** flowing toward the "You" child node while the question is pending; flowing back to the asking agent after the answer arrives (as a return edge).
- **Static edges:** none in the main area (all main-area edges are active or lingering by definition). The top bar has no edges.

## Deliverables

1. **`source/web/static/flow-graph.js`** — extend `deriveFlowGraph` (or a focused `deriveFlowAnimation(runView, now)` helper) to compute, from the run view's log, the **current animation state**: which edge is `flowing` (and its direction), which is `returning`, which node is `active`/pulsing. Map the turn-level semantics above to the log events; for a completed run, everything is settled (the main area is empty or shows only the root "You", the top bar holds the full history).
2. **`source/web/flow-graph.test.ts`** — cover the animation derivation: an in-progress agent→agent delegation shows the call edge `flowing` until the child's first `llm_call`, then the flow moves to the child's outgoing edge; an in-progress `tool_call` with no `tool_result` yet shows the call edge `flowing`; a `tool_result` triggers the `returning` flow; a completed run has an empty main area and a full top bar. Use the fixture timelines.
3. **`source/web/static/playback.js`** — the `FlowView` passes the animation descriptor to the primitives so edges pick up their `flowing`/`returning` classes and nodes pick up their `active`/`entering`/`departing` classes. Node lifecycle transitions (entering, shrinking to top bar, merging) are driven by diffing consecutive frames' `FlowGraph` states. The playback harness already steps frames; the animation re-derives per frame. No streaming/partial-update plumbing — the whole graph re-renders from the fresh frame (hyperapp diffs the vnodes).
4. **`source/web/static/styles.css`** — the CSS animations: `stroke-dasharray` flow for `flowing`/`returning` edges (direction via `animation-direction`), a calm pulse keyframe for the active node, scale/fade for entering/departing nodes, error-red for `error`-state edges/nodes. All theme-aware (light/dark tokens from step 02). Respect `prefers-reduced-motion` (disable flow/pulse/transitions, show static active highlight instead).

## Module boundaries

- Web-only, fixture-driven. `flow-graph.js` gains the animation derivation (pure); `playback.js` wires the descriptor through and drives lifecycle transitions by frame-diffing; `styles.css` gains keyframes. No backend or endpoint changes.
- No new dependencies. Animation is CSS only.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] An in-progress delegation animates the call edge `flowing` left→right until the child's first `llm_call`, then the flow moves to the child's outgoing edge.
- [ ] An in-progress `tool_call` animates the call edge `flowing`; `tool_result` triggers the `returning` flow right→left.
- [ ] A finishing node lingers with a return edge, then animates to the top bar (shrinking) when the caller acts; if the type's slot exists, it merges (moves there + fades).
- [ ] A new node entering the main area animates in (scale/fade).
- [ ] The active node pulses; the top bar is always static.
- [ ] A completed run has an empty main area (or only the root "You") and a full top bar.
- [ ] `prefers-reduced-motion` disables flow/pulse/transitions and falls back to a static active highlight.
- [ ] Animations are theme-aware (light and dark both legible).

## Operator handoff

Play the fixture timelines in the playback harness. Confirm the flow direction reads correctly, the node lifecycle transitions (entering, shrinking to top bar, merging) are smooth and clear, the active node pulse is calm (not seizure-inducing), and reduced-motion falls back gracefully. Report tempo/intensity/transition adjustments.
