# MVC step 04 — Flow view: static layout from `InteractionModel`

## Goal

Render the flow view from an `InteractionModel`: a stack-of-rows layout where the main run (rooted at `You`) sits at the top, each preempting interrupt stack (rooted at an Interrupt instance) sits below it, and the active stack is at the bottom. Each row lays its open call chain left-to-right (call depth), with lingering return legs. A top-bar strip of departed/terminated participants. No animation yet — this step nails the static structure against the model, reusing the project's SVG primitive conventions.

## Context

Read [`PLAN.md`](PLAN.md) ("The single invariant", "Interrupts") and [`01-interaction-model.md`](01-interaction-model.md). The old `flow-view.js` consumed a `FlowModel` (current-state graph) and derived active-path/lingering state itself; the new view consumes `InteractionModel` and projects the open call chains via the model's helpers (`callChainOf`, `stacksOf`, `activeStack`, `observesOf`). It does **not** derive animation or activity — those come straight off the model's `lifecycle`/`activeParticipant`. New primitives live in `mvc/primitives.js` so the old `svg-primitives.js` stays intact for the old demo until cleanup.

## Deliverables

1. **`source/web/static/mvc/primitives.js`** — SVG primitives for the new views, browser-pure, parallel to the old `svg-primitives.js`: a node box (label + sublabel + counter + cost), an edge path between face anchors (call = right→left faces; return = bottom faces so the response leg sits below the forward call), a loopback path for same-column cross-instance calls (sequence view uses this too — shared here), and an `observe` line style (static, no animation hook). Colors read the existing `--svg-*` tokens from `styles.css`.
2. **`source/web/static/mvc/flow-view.js`** — `renderFlowView(h, model, labels, tier, interactions?)`:
   - Projects the model to rows: one row per non-terminated stack (`stacksOf`), active stack last/bottom.
   - Each row's open call chain (`callChainOf`) laid out left-to-right by depth; the stack's root participant (`You` or an Interrupt instance) at the leftmost column.
   - Lingering return legs: a `return` operation whose source has departed the call chain still draws its edge back to the caller until the caller's next action (read off the model's operations, not a separate `lingering` flag).
   - `observe` lines crossing from the active stack up into a paused row, static.
   - Top-bar strip: departed/terminated participants aggregated by `role` (invocation counts, cumulative metrics), one small node per role/tool type that has ever run.
   - Node labels via the step-03 label resolver + the selected tier; node costs from `OperationMetrics`.
   - No `active`/`flowing` classes yet (step 05); this step renders the settled structure.
3. **`source/web/mvc-flow-view.test.ts`** — against inline `InteractionModel`s (and the demo scenarios once 02 lands): row count matches `stacksOf`; the active stack is the bottom row; a retried role appears as two nodes (two instances) not a counter bump on one; a departed participant appears in the top bar; an `observe` line crosses stacks. No `as` casts.
4. **`source/web/static/demo.js`** — render the flow view SVG in place of the debug text view (keep the debug view available behind a toggle for cross-checking during development).

## Module boundaries

- Web-only. New files under `mvc/` + a flat test; the old `flow-view.js` and `flow-view.test.ts` are untouched.
- Reuses `mvc/interaction-model.js` and `mvc/labels.js`; does not import the old `flow-view.js`/`svg-primitives.js`/`fixtures.js`.
- `h` is passed in (hyperapp-free, testable with a fake), mirroring the existing convention.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass; the old demo still runs.
- [ ] Every demo scenario renders the correct static structure (rows, call chains, lingering legs, top bar, observe lines) against the model.
- [ ] The view contains zero references to `FlowModel`, `recentLog`, `deriveFlowAnimation`, or executor event types — it reads only `InteractionModel`.
- [ ] Node/edge visuals read the shared `--svg-*` tokens so light/dark both work.
- [ ] No plan/step references in source; comments explain *why* (the row-per-stack rule, the lingering-leg rule), not *what*.
