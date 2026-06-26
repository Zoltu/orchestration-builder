# UI step 15 (deferred, executor-dependent) — `llm_call_start` / streaming for token-level flow

## Goal

Upgrade the flow animation from **turn granularity** (shipped in step 04: a call edge flows until the child's first `llm_call`) to **token granularity** (a call edge flows until the child's first *byte*), by adding a streaming or turn-start event from the executor. This is the enhancement that makes the "flow towards the receiver until it starts responding" effect exact. It is **not sequenced** until the executor unfreezes (main-plan step 30, `run_shell`).

## Context

Read [`PLAN.md`](PLAN.md) ("Flow animation … token-level … step 15"), [`04-flow-graph-animation.md`](04-flow-graph-animation.md) (the turn-level animation this enhances), `source/executor/llm.ts` (the LLM caller — today non-streaming, logs `llm_call` only after the full response), and `source/executor/types.ts` (`LogEvent`). Today there is no "turn started" event; the executor logs `llm_call` with the complete response. To animate at token granularity we need either a streaming response or a new `llm_call_start` event logged when the request is dispatched, plus partial-token events for the "first byte" moment.

## Why this is deferred

The executor is frozen for main-plan steps 25–29. Step 30 (`run_shell`) unfreezes it. Token-level flow is a polish enhancement, not a product blocker — turn-level flow (step 04) is already a calm, informative animation. Sequencing this before the executor unfreezes would block the whole UI sub-plan on an unrelated executor step. Step 04 is designed so this step slots in cleanly: the animation derivation maps events to edge states; adding `llm_call_start`/token events is an extension of that mapping, not a rewrite.

## Deliverables (when sequenced)

1. **Executor** — emit an `llm_call_start` event (and, if streaming is added, partial-token events) so the UI can mark a turn as in-flight before the first `llm_call` completes. Decide streaming-vs-start-event during implementation; a start-event-only approach is the smaller change and still enables "flow until first turn *begins*," with token-level reserved for true streaming.
2. **`source/web/static/flow-graph.js`** — extend the step-04 animation derivation to consume the new event(s): the call edge flows from `agent_call`/`role_start` until `llm_call_start` (turn begun) rather than until the first `llm_call` (turn done); with streaming, until the first token event.
3. **`source/web/static/app.js` / `styles.css`** — if streaming, add the thinking-vs-responding-vs-tool-calling node state cues (per `PLAN.md`) keyed on whether the last received byte was reasoning/content/a tool call, and a live token counter on the active node.
4. **`source/web/flow-graph.test.ts`** — cover the new event mapping. Add a fixture covering the new event(s) so the animation is testable in-memory.

## Module boundaries

- This is the **only** step in the UI sub-plan that touches the executor runtime. It is gated on the main-plan executor unfreeze (step 30) and is sequenced after it.
- The web-only steps (01–14) do not depend on this step and ship without it.

## Acceptance criteria (when sequenced)

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The call edge flows until the child's turn *begins* (start event) or first token (streaming), not until the turn completes.
- [ ] With streaming, the active node shows thinking/responding/tool-calling cues and a live token counter.
- [ ] Turn-level behavior (step 04) remains correct when the new events are absent (backward compatible with existing logs).

## Operator handoff

Watch a streaming run and confirm the flow tracks the first byte, the node state cues are accurate, and the token counter advances. Report tempo/cue adjustments.

## Status

**Deferred.** Not started until the executor unfreezes (main-plan step 30). Recorded here so the design's streaming-awareness is not lost; the web-only sub-plan (01–14) is complete without it.
