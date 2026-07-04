# MVC step 06 — Sequence view: static layout from `InteractionModel`

## Goal

Render the sequence view from an `InteractionModel`: one column per role (`human` first, `interrupt` appearing on first use, then roles, then a tools column), each operation as a horizontal message on a vertical time axis, terminal nodes on the target lifeline, same-role cross-instance calls as loopback arrows, and `observe` operations as static cross-stack lines. No animation yet — this step nails the temporal layout against the model, with zero borrowing from the flow view.

## Context

Read [`PLAN.md`](PLAN.md) ("The single invariant") and [`04-flow-view-static-layout.md`](04-flow-view-static-layout.md). The old `sequence-diagram.js` derived its diagram inline from `recentLog` events and borrowed the flow view's animation state via `deriveSequenceActivity` — the source of every special case. The new view consumes `InteractionModel` directly: each operation is already a message, its `lifecycle` is already its animation state, and its `source`/`destination` participants already resolve to columns. No `accumulateRecentLog`, no `filterOrphanToolCalls`, no `buildCallEdgeColumns`/`isRealDelegation`, no `parentOf` machinery — all of that was the adapter's job, done upstream when the model was built.

## Deliverables

1. **`source/web/static/mvc/sequence-view.js`** — `renderSequenceView(h, model, labels, tier, interactions?)`:
   - Columns: group participants by `role` → one column per role. Order: `human`, then `interrupt` (only when an Interrupt participant exists), then roles in first-appearance order, then tools. The `human` column is always present.
   - Messages: lay `operations` top-to-bottom by index. A `call`/`return` draws a horizontal arrow between its source and destination columns, landing on a terminal node on the destination's lifeline. A same-role cross-instance call (source and destination resolve to the same column) renders as the loopback path from `mvc/primitives.js` (out, turn, back on a new line) — no self-message special case in the model.
   - `observe` renders as a static vertical/sideways line between the two columns, never animated, with no terminal-node activation.
   - Terminal nodes carry the operation's `outcome` color (success/error) for returns; `terminated` returns carry a distinct treatment (documented).
   - Column/message labels via the step-03 resolver + tier; `details` markdown carried on each message for the inspector (step 07).
   - No `deriveSequenceActivity` — the active participant and the in-flight line are read directly off the model (wired in step 07's animation).
2. **`source/web/mvc-sequence-view.test.ts`** — against inline models and the demo scenarios: column set matches the participants' roles; `interrupt` column appears only when an interrupt exists; operation count === message count (one row per operation, no dropping); a same-role cross-instance call renders the loopback path; `observe` renders a static line; a `return` to `human` lands on the human column. No `as` casts.
3. **`source/web/static/demo.js`** — render the sequence view behind the Flow/Sequence toggle (parallel to the old demo's toggle).

## Module boundaries

- Web-only. New `mvc/sequence-view.js` + flat test; the old `sequence-diagram.js` and `sequence-diagram.test.ts` are untouched.
- Imports only `mvc/interaction-model.js`, `mvc/labels.js`, `mvc/primitives.js`. Does **not** import `mvc/flow-view.js` or the old `flow-view.js` — the two views are independent leaves over the model.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass; the old demo still runs.
- [ ] One message per operation, in chronological order, across every scenario — no dropped or phantom rows.
- [ ] The `interrupt` column is absent from non-interrupt scenarios and present in interrupt scenarios.
- [ ] Same-role cross-instance calls render as loopbacks; `observe` renders as a static cross-stack line.
- [ ] Zero references to `recentLog`, `deriveSequenceActivity`, `buildCallEdgeColumns`, `isRealDelegation`, `filterOrphanToolCalls`, `accumulateRecentLog`, or executor event types. No plan/step references in source.
