# MVC step 01 — `InteractionModel`: types + pure derivation helpers

## Goal

Define the shared model both views will read. A browser-pure module carrying the `InteractionModel` types (as JSDoc typedefs) and the pure helpers that derive the shared invariants (active stack, active participant, call chains, paused stacks, fate of a paused stack). No view code yet — this step establishes the contract and the single source of truth for "what is happening right now."

## Context

Read [`PLAN.md`](PLAN.md) ("The model", "The single invariant both views read", "Interrupts"). The whole sub-plan rests on this module being right: every special case the old code accrued exists because the two views answered "is this in flight?" independently. Once one helper answers it for both, the patches dissolve. The model is browser-pure JS (not TS) so the browser view modules can import its runtime helpers; JSDoc typedefs give the TS tests types without a build step, mirroring how the existing `flow-view.js` is consumed by `flow-view.test.ts`.

## Deliverables

1. **`source/web/static/mvc/interaction-model.js`** — JSDoc typedefs for `Participant`, `Operation`, `OperationMetrics`, `InteractionModel` matching the design in `PLAN.md`, plus pure helpers:
   - `activeStack(model)` — the stack id of the latest operation.
   - `activeParticipant(model)` — the destination of the latest `call`/`return` in the active stack (or `null` for a terminal run with no operations). `observe` operations are skipped.
   - `stacksOf(model)` — the ordered list of stacks with at least one open `call` (no matching `return`), oldest first; the active stack is last.
   - `callChainOf(model, stackId)` — the open call chain within a stack: `call`s whose `return` hasn't appeared, in order, for the flow view's active-path projection.
   - `isPaused(model, stackId)` — true when the stack is not the active stack and still has open calls.
   - `fateOf(model, stackId)` — one of `'resuming' | 'rewinding' | 'terminating' | 'terminated' | 'active'`, read off the operations that follow the preempting stack's final `return` (resume = next op on the old stack id; rewind = a run of `terminated` returns then a fresh `call` from an ancestor; terminate = `terminated` returns to the root; terminated = no open calls remain; active = the stack is the active stack). Documented rule, not a state field.
   - `observesOf(model)` — the `observe` operations, for the cross-stack static lines.
2. **`source/web/interaction-model.test.ts`** — covers, against inline minimal `InteractionModel`s (no fixtures yet):
   - The single invariant: at most one operation is `in_flight` in the active stack; the active participant is its destination; `observe` never affects activity.
   - A paused stack's `in_flight` operation stays `in_flight` (the model does not flip it) but its line does not animate (the helper exposes the rule, not the view — tested via `isPaused`).
   - Interrupt spawning a new stack: `activeStack` flips to the new stack; the old stack's calls remain open and `isPaused` returns true.
   - The three fates expressed as operation sequences (resume / rewind via `terminated` returns + fresh `call` / terminate via `terminated` returns to root), asserted via `fateOf`.
   - `observe` crossing stacks: source in the active stack, destination in a paused stack; `observesOf` returns it; it never appears in `callChainOf`.
   - Terminal run: the last operation is a `return` to `human`; `activeParticipant` returns the human; `stacksOf` is empty (no open calls) or carries only completed stacks.

## Module boundaries

- Web-only, no view code, no demo, no backend. The model is a pure data module + helpers.
- Browser-pure JS: imports nothing. JSDoc typedefs provide types to the TS test.
- No `as` casts in the test; construct `InteractionModel` literals directly (the JSDoc types catch shape errors).

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The helpers encode the single invariant and the interrupt rules exactly as specified in `PLAN.md`; every helper is exercised by a test.
- [ ] No reference to the old `FlowModel`, `recentLog`, or any executor event type anywhere in the module.
- [ ] Comments explain *why* (the invariant, the fate rules), never *what*; no plan/step references.
