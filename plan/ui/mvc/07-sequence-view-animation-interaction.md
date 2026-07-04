# MVC step 07 — Sequence view: animation + inspector + zoom/pan

## Goal

Animate the sequence view off the single invariant and add the interaction surface: a hover/click inspector that reuses the existing tooltip module to render each operation's `details` markdown, and zoom-to-scroll / pan via the SVG `viewBox`. The active stack's `in_flight` message marches; paused stacks' messages are static; the active participant's terminal node pulses. This completes the debug view.

## Context

Read [`06-sequence-view-static-layout.md`](06-sequence-view-static-layout.md) and [`PLAN.md`](PLAN.md) ("The single invariant"). The old sequence view borrowed the flow view's `deriveFlowAnimation` to color its last message; the new view reads `Operation.lifecycle` + `activeStack` directly, so the same rule that drives the flow view drives this one — for free, with no cross-view coupling. The inspector is a repackaging of each operation's `details` markdown (and the step-03 label tiers), routed through the existing sanitized-Markdown tooltip pipeline.

## Deliverables

1. **`source/web/static/mvc/sequence-view.js`** — add:
   - Message animation: the latest `call`/`return` in the active stack carries `flowing`/`returning`/`error` (off `lifecycle` + `outcome`) **iff** its stack is the active stack; every earlier message is solid; `observe` is always static. A paused stack's `in_flight` message is solid (frozen).
   - Terminal-node highlight: the active participant's node pulses; a `return`'s source node carries the `outcome` color.
   - Per-message `details` markdown attached for the inspector; per-message label via the step-03 resolver.
2. **`source/web/static/demo.js`** — wire hover/click on sequence messages and terminal nodes to the existing `tooltip.js` module (reused unchanged), rendering the `details` markdown through the step-27 sanitized pipeline. Add wheel-zoom-toward-cursor and drag-pan via `viewBox` math, plus a "jump to active" scroll for in-progress runs. Zoom/pan state is local to the sequence view and resets on scenario switch.
3. **`source/web/mvc-sequence-view.test.ts`** — covers: the active stack's `in_flight` message animates and earlier messages are solid; a paused stack's `in_flight` message is solid; the active participant's node carries the active class; a `return`'s source node carries the outcome color; `observe` never animates.
4. **`source/web/static/styles.css`** — minimal additions only if needed (e.g. a zoom/pan cursor cue); reuse the existing `.seq-*` classes where they fit.

## Module boundaries

- Web-only. Touches the new `mvc/sequence-view.js`, its test, `demo.js`, and possibly minor CSS. The old `sequence-diagram.js` is untouched.
- Reuses `tooltip.js`, `markdown-render.js` unchanged. No new dependencies.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] Animation follows the single invariant exactly: only the active stack's `in_flight` message marches; paused stacks are frozen; `observe` never animates; the active participant pulses.
- [ ] Hovering/clicking a message or terminal node opens the tooltip with the `details` markdown, rendered through the sanitized pipeline; the tier toggle swaps the short label.
- [ ] Wheel zooms toward the cursor; drag pans; "jump to active" scrolls to the latest message; state resets on scenario switch.
- [ ] Reads correctly in light and dark. No plan/step references in source.
