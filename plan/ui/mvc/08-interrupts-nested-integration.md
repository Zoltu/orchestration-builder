# MVC step 08 — Interrupts & nested interrupts: stress/integration across both views

## Goal

Prove the interrupt concept end-to-end across both views against the hard scenarios: nested interrupts (an interrupt interrupts an interrupt), `observe` reading into a paused stack, the three fates (resume / rewind / terminate), and mid-flight interruption (a paused stack carrying an `in_flight` operation that must render frozen, not animated). This step iterates the scenarios and fixes rendering gaps in both views; the model is already correct from step 01, so the work is view-side edge cases the simpler scenarios did not exercise.

## Context

Read [`PLAN.md`](PLAN.md) ("Interrupts") and the closeouts of steps 04–07. The interrupt scenarios landed in step 02, but the static + animated views were built and tested mostly against the simpler scenarios. Nested interrupts stress the row-per-stack flow layout (multiple interrupt roots stacking vertically), the `interrupt` column grouping in the sequence view (multiple Interrupt instances in one column), and the active-stack rule when stacks resolve inward. The `observe` cross-stack line and the `terminated` outcome rendering are validated here as first-class concerns, not incidental.

## Deliverables

1. **`source/web/static/mvc/scenarios.js`** — extend the interrupt scenarios if the step-02 versions prove too thin: add a deeper nested-interrupt sequence (three stacks briefly coexisting), a rewind that terminates multiple children before the ancestor's fresh `call`, and a mid-flight interrupt (the paused stack's latest op is `in_flight` when the interrupt lands).
2. **`source/web/static/mvc/flow-view.js`** and **`source/web/static/mvc/sequence-view.js`** — fix rendering gaps surfaced by the hard scenarios. Likely areas: the active-stack row ordering when stacks resolve, the `observe` line routing across non-adjacent rows/columns, the `terminated` outcome's distinct visual (so a kill reads differently from a success/error return), and the frozen-`in_flight` rendering in a paused stack.
3. **`source/web/mvc-flow-view.test.ts`** and **`source/web/mvc-sequence-view.test.ts`** — add assertions for: three coexisting stacks (flow row count = 3; sequence shows the active stack's messages animating, the two paused stacks' `in_flight` lines solid); `observe` crossing into a paused stack; a `terminated` return rendering distinctly; a paused stack's `in_flight` op staying `in_flight` in the model but rendering `static` in the view.
4. **`source/web/static/demo.js`** — ensure the harness lets the operator scrub through the nested-interrupt scenarios frame-by-frame to review the cascade.

## Module boundaries

- Web-only. Touches the new `mvc/` view modules, scenarios, and tests. No model changes (the model already encodes the rules); if a scenario reveals a model gap, surface it rather than patching the view around it.
- No backend, no executor changes.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] Nested interrupts render correctly in both views: each stack is a row (flow) / its messages animate only when active (sequence); resolving an inner stack resumes the outer correctly.
- [ ] `observe` lines route cleanly across stacks in both views and never animate or activate a participant.
- [ ] The three fates read correctly off the operations (resume = next op on the old stack; rewind = `terminated` returns + fresh `call`; terminate = `terminated` returns to root), and `terminated` renders distinctly from success/error.
- [ ] A mid-flight interrupt's paused `in_flight` line is frozen in the view; the model's `lifecycle` is unchanged.
- [ ] No plan/step references in source; any model-rule clarification updates `PLAN.md` and `01-interaction-model.md`, not the view comments.
