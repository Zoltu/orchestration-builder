# MVC step 05 — Flow view: animation + node lifecycle

## Goal

Bring the flow view to life, driven entirely by the model's `lifecycle` and the single invariant. Entering/departing nodes scale/fade in and travel to their top-bar slot; a call/return edge marches while it is `in_flight` **and** its stack is the active stack; paused stacks' lines are frozen solid; the active participant's node pulses. No re-derivation of activity — the model already answered it.

## Context

Read [`04-flow-view-static-layout.md`](04-flow-view-static-layout.md) and [`PLAN.md`](PLAN.md) ("The single invariant both views read"). The old `deriveFlowAnimation` re-derived edge state from the `FlowModel`; here, animation state is a direct read off `Operation.lifecycle` + `activeStack`. The frame-diff lifecycle (entering/departing) is computed by comparing two consecutive `InteractionModel` frames, the same shape as the old `deriveLifecycle` but keyed on participant `id` and operation `id` rather than node identity.

## Deliverables

1. **`source/web/static/mvc/flow-view.js`** — add:
   - Edge animation class: a `call`/`return` edge carries `flowing`/`returning`/`error` (from `lifecycle` + `outcome`) **iff** its stack is the active stack; otherwise `static` (paused). An `observe` line is always `static`.
   - Active-node highlight: the destination of the latest operation in the active stack (via `activeParticipant`) pulses; nodes in paused stacks do not.
   - Frame-diff lifecycle: `deriveLifecycle(previousModel, currentModel)` → entering participant ids and departing participants (with their previous row/column and their top-bar slot destination), both in the shared SVG coordinate space so a departing node travels to its slot. Reuses the old `flow-view.js` travel/shrink/fade CSS keyframes (they are unchanged and already reduced-motion-aware).
   - The CTA / result handling stays a view concern layered on `model.status` (terminal frame), not model state — ported from the old view if needed for the demo, but read off `InteractionModel.status`.
2. **`source/web/static/styles.css`** — only if new classes are needed (e.g. a paused-stack indicator); prefer reusing the existing `.flow-*` and `.graph-edge--*` classes. Any addition is documented with its rationale.
3. **`source/web/mvc-flow-view.test.ts`** — covers: a `call` in the active stack animates while `in_flight` and goes solid on `settled`; a `return` with `outcome: 'error'` carries the error class; an `in_flight` operation in a paused stack renders `static` (frozen); the active participant's node carries the active class; entering/departing lifecycle descriptors are correct across two frames.
4. **`source/web/static/demo.js`** — play frames in sequence so the animation is iterable.

## Module boundaries

- Web-only. Touches only the new `mvc/flow-view.js`, its test, and `demo.js`. The old `flow-view.js` is untouched.
- Animation is CSS-driven off class hooks (existing keyframes); the model carries no animation state.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] Animation strictly follows the single invariant: only the active stack's `in_flight` line marches; paused stacks are frozen; the active participant pulses; `observe` never animates.
- [ ] Frame-to-frame lifecycle (enter/depart/merge) reads correctly across the demo scenarios, including a retry (second instance enters) and an interrupt (new stack row enters).
- [ ] Reduced-motion falls back to static highlights (existing keyframes' `prefers-reduced-motion` rules cover the reused classes).
- [ ] No plan/step references in source.
