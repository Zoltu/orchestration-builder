# UI step 04 — Flow graph: animation + active-path highlighting

## Goal

Bring the static graph to life with flow animation along the active path and pulsing of the active node, at **turn granularity** (non-streaming). Completed invocations fold into counters; the active path is expanded/highlighted. This is the ambient "what is happening right now" layer over step 03's static layout. Iterated against the step-01 fixture timelines via the playback harness.

## Context

Read [`PLAN.md`](PLAN.md) ("Flow animation along the active path", and the turn-granularity mapping), [`03-flow-graph-static-layout.md`](03-flow-graph-static-layout.md) (the `FlowGraph` state and the `GraphEdge` `state` prop), and `source/web/render.ts` (`LogEvent` types — the events that drive the flow semantics). The turn-level flow mapping, buildable today without executor changes:

- **Agent → agent flow:** from `agent_call`/`role_start` (start) until the child's **first `llm_call`** (first turn done). Then a new flow starts from that child toward its tool or child.
- **Agent → tool flow:** from `tool_call` (start) to `tool_result` (end).
- **Tool → agent return:** on `tool_result`, the flow returns to the calling agent.

Token-level "flow until first byte" is step 15 (deferred, executor-dependent). The playback harness's frame timeline is what makes the animation iterable without a real run — scrubbing frames steps the animation deterministically.

## Deliverables

1. **`source/web/render.ts`** — extend `deriveFlowGraph` (or a focused `deriveFlowAnimation(runView, now)` helper it calls) to compute, from the run view's log, the **current animation state**: which edge is `flowing` (and its direction), which is `returning`, which node is `active`/pulsing, and which edges are `static` (completed). Pure: given the log + `now`, a deterministic animation descriptor. Map the turn-level semantics above to the log events; for a completed run, everything is `static`.
2. **`source/web/render.test.ts`** — cover the animation derivation: an in-progress agent→agent delegation shows the parent→child edge `flowing` until the child's first `llm_call`, then `static`; an in-progress `tool_call` with no `tool_result` yet shows the agent→tool edge `flowing`; a completed run is all `static`. Use the fixture timelines.
3. **`source/web/static/styles.css`** — the CSS animations: `stroke-dasharray` flow for `flowing`/`returning` edges (direction via `animation-direction`), a calm pulse keyframe for the active node, error-red for `error`-state edges/nodes. All theme-aware (light/dark tokens from step 02). Respect `prefers-reduced-motion` (disable flow/pulse, show static active highlight instead).
4. **`source/web/static/app.js`** — the `FlowGraph` view passes the animation descriptor to the primitives so edges/nodes pick up their `state`/`active` classes. The playback harness already steps frames; the animation re-derives per frame. No streaming/partial-update plumbing — the whole graph re-renders from the fresh frame (hyperapp diffs the vnodes).

## Module boundaries

- Web-only, fixture-driven. `render.ts` gains the animation derivation (pure); `styles.css` gains keyframes; `app.js` wires the descriptor through. No backend or endpoint changes.
- No new dependencies. Animation is CSS only.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] An in-progress delegation animates the parent→child edge `flowing` until the child's first `llm_call`, then settles.
- [ ] An in-progress `tool_call` animates the agent→tool edge `flowing`; `tool_result` triggers the `returning` flow to the agent.
- [ ] The active node pulses; completed invocations fold into counters (no lingering pulse).
- [ ] A completed run is entirely static.
- [ ] `prefers-reduced-motion` disables flow/pulse and falls back to a static active highlight.
- [ ] Animations are theme-aware (light and dark both legible).

## Operator handoff

Play the fixture timelines in the playback harness. Confirm the flow direction reads correctly, the active node pulse is calm (not seizure-inducing), and reduced-motion falls back gracefully. Report tempo/intensity adjustments.
