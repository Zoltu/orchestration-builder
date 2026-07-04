# MVC step 02 — Demo scenarios + demo harness scaffold

## Goal

Rewrite the demo scenarios as `InteractionModel` frame sequences (the rewritten fixtures), under a new non-colliding name, and stand up the new `demo.html` + `demo.js` harness that cycles through them. At the end of this step the harness renders each scenario's model as a debug/text view (the active stack, active participant, open call chains, observes) — enough to iterate scenarios and confirm the model reads correctly before any SVG view lands.

## Context

Read [`PLAN.md`](PLAN.md) ("Methodology: parallel to the current demo") and [`01-interaction-model.md`](01-interaction-model.md) (the model contract). The old `fixtures.js` models scenarios as `RunView` + `recentLog` + hand-authored `FlowModel` frames; that triple-source shape is what we are leaving behind. The new scenarios author `InteractionModel`s directly — operations and participants as first-class data, no event vocabulary, no window reconstruction. The scenarios must cover every case the old fixtures did (single-role, delegation, retry, deep-tree, self-delegation-as-new-instance, completed, pending-question, detected-loop/interrupt) plus new ones the model enables (nested interrupt, observe across stacks, terminated/rewind fates).

## Deliverables

1. **`source/web/static/mvc/scenarios.js`** — the rewritten scenarios as an ordered list, each a `{ id, label, frames: InteractionModel[] }`. Frames advance one operation at a time so animation can be iterated later. Scenarios must include, at minimum:
   - Single-role completion (You → coder → return).
   - Delegation chain (orchestrator → planner → coder → tool → returns unwind).
   - Retry (a role finishes, caller re-delegates → a second coder *instance* appears to the right, not a counter on the first — exercises instance-per-invocation).
   - Deep call tree (≥4 deep).
   - Pending question (a `call` to the `human` participant that stays `in_flight` until the answer frame).
   - Interrupt (detected-loop, honestly modeled): a `call` from an Interrupt instance → loop_detector → tool → `observe` into the paused coder stack → return → the coder stack resumes.
   - Nested interrupt (an interrupt interrupts an interrupt; three stacks briefly coexist).
   - Rewind fate (an interrupt's return is followed by `terminated` returns down to an ancestor, then a fresh `call` from that ancestor).
   - Terminate fate (an interrupt's return is followed by `terminated` returns all the way to the human root; run ends).
   - Error (a `return` with `outcome: 'error'`).
2. **`source/web/mvc-scenarios.test.ts`** — validates every scenario frame against the model contract: every `source`/`destination` references a known `participant.id`; no `call`/`return` has `source === destination`; `observe` source and destination may be in different stacks; at most one `in_flight` operation per stack; `stack` ids are consistent within a call chain. A malformed scenario fails loudly.
3. **`source/web/static/demo.html`** — the new demo entry page (parallel to `playback.html`), loading `demo.js` as a module. Slim chrome: scenario select, frame scrubber, theme toggle, tier toggle (wired in step 03).
4. **`source/web/static/demo.js`** — the new harness: loads `mvc/scenarios.js`, renders the current frame's model as a debug text view (active stack, active participant, open call chains, observes, paused stacks), and advances frames. No SVG view yet — the text view is the iteration surface for the model itself. Imports only `./mvc/*`; touches nothing in `playback.js` or `app.js`.

## Module boundaries

- Web-only. New files only — the old `playback.html`/`playback.js`/`fixtures.js` are untouched and still functional.
- `demo.js` does not import the old `flow-view.js`/`sequence-diagram.js`/`fixtures.js`.
- Scenarios are browser-pure JS (importable by `demo.js` and the TS test).

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass; the old demo still runs.
- [ ] Every old-fixture scenario has a new-model counterpart; the three new interrupt scenarios (nested, rewind, terminate) are present.
- [ ] The scenario shape test catches a deliberately malformed frame (unknown participant id, self `call`, two in-flight ops in one stack).
- [ ] `demo.html` cycles through every scenario and the debug text view reflects the model correctly (active stack/participant, open chains, observes, paused stacks) on each frame.
- [ ] No plan/step references in source; comments explain *why* (why each scenario exists), not *what*.
