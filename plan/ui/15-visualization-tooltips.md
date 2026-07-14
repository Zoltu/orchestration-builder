# UI step 15 — Visualization tooltips (flow + sequence)

## Goal

Wire the inspector (the `tooltip.js` card) onto every node and edge of both run-view surfaces so a non-developer can hover any element and read what it is and what it did. The flow view has carried no hover wiring at all (not in the dev harness, not in the product client after step 14); the sequence view's hover works in the dev harness (`demo.js`'s `wireSequenceInteractions`) but step 14 did not carry it into `app.js`. This step closes both gaps and reconciles the stale pre-MVC tooltip derivation in `tooltip.js` with the live `InteractionModel`, so the inspector reads the same model the views render.

## Context

Read [`PLAN.md`](PLAN.md) ("Tooltips", "Flow view (default)", "Sequence view (debug toggle)"), [`14-hook-up-to-real-backend.md`](14-hook-up-to-real-backend.md) (the product client now renders both views from live `/api/run/flow`), `source/web/static/demo.js` (the dev harness's `openOperationTooltip` / `wireSequenceInteractions` — the working sequence-view hover path this step ports into the product client), `source/web/static/tooltip.js` (the `Tooltip` card component and the **stale** `deriveTooltipForNode` / `deriveTooltipForEdge` — these read a pre-MVC `flowModel.mainArea` shape that no longer exists; this step replaces them with `InteractionModel`-based derivations or removes them), `source/web/static/flow-view.js` (the `data-operation` attributes on edges and `data-participant` / `data-role` / `data-kind` on nodes), `source/web/static/sequence-diagram.js` (`data-operation` on every message group and terminal node), and `docs/security.md` ("Web client rendering pipeline" — the tooltip card is an HTML overlay carrying agent prose only through the sanitized Markdown pipeline).

The flow view's edges carry `data-operation`; its nodes (main-area and top-bar) carry `data-participant` and `data-role`/`data-kind`, not `data-operation`. The sequence view carries `data-operation` on both messages and terminal nodes. The `Tooltip` card and `formatTooltipContent` already render a labeled detail block (pretty-printed JSON for arguments/results, sanitized Markdown for prose, plain text for scalars) — this step feeds it, it does not rebuild it.

## Deliverables

1. **`source/web/static/app.js`** — wire hover (and click, for re-opening the question modal off an `ask_human` row) onto the flow and sequence SVGs rendered by `FlowPanel`, the way `demo.js`'s `wireSequenceInteractions` wires the dev harness. The card is a single HTML overlay mounted under the run view (or `document.body`), repositioned per hover, dismissed when the pointer leaves the SVG. The wiring reads the hovered element's `data-operation` / `data-participant` / `data-role` off the live `state.flowModel` and `state.labelResolver`, so it never re-fetches and never invents content the model does not carry.
2. **`source/web/static/tooltip.js`** — replace the stale `deriveTooltipForNode` / `deriveTooltipForEdge` (pre-MVC, read `flowModel.mainArea`) with `InteractionModel`-based derivations, or remove them and write the derivations inline in a new browser-pure helper the product client and dev harness both import (mirroring how `flow-view.js` is shared). The derivations take a participant id or operation id plus the live model + label resolver and return `{ title, sections }`:
   - **Edge (flow or sequence, by `data-operation`)** — the operation's resolved label as the title and a single `details` section carrying the operation's `details` markdown (the adapter-formatted arguments/result/summary/question). This is exactly `demo.js`'s `openOperationTooltip` path, generalized.
   - **Main-area node (flow, by `data-participant`)** — the participant's resolved label, its role/kind, the completing return's outcome, and the call/return operation's `details` (the delegation task text for a role, the arguments/result for a tool, the question for a human answerer).
   - **Top-bar node (flow, by `data-role`)** — the role's cumulative summary: invocation count, total time, total tokens, and whether any invocation errored (the `projectTopBar` aggregates the flow view already computes).
3. **`source/web/static/demo.js`** — port the product client's wiring back if it diverges, or leave the harness's `openOperationTooltip` as the shared path both consume (decide during implementation; the goal is one inspector derivation, not two). The dev harness stays this step (it is removed in step 16).
4. **`docs/security.md`** — confirm the inspector preserves the security invariant for live (untrusted) data: the operation `details` markdown flows only through the sanitized Markdown pipeline (`markdown-render.js` → `markdown.js` allowlist); participant labels, role names, counts, costs, and statuses are `textContent`; no `details` string is interpolated into an SVG attribute or `innerHTML`.

## Module boundaries

- Web-only. No backend or endpoint changes (the flow model already carries the `details` markdown and the metrics; step 13's adapter formats them). No new dependencies.
- The derivations are pure functions of (model, label resolver, id) — testable in-memory like the view modules. The wiring in `app.js` is the integration shell (event → derivation → card mount), thin and not unit-tested, mirroring the rest of `app.js`.
- If a live-data edge case reveals a derivation gap (a node/edge shape the fixtures did not cover), add a fixture covering it so the derivation stays in-memory-testable; do not patch the derivation around an adapter bug.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] Hovering any flow-view edge opens the inspector with the operation's `details` (arguments/result/summary/question).
- [ ] Hovering any flow-view main-area node opens the inspector with the participant's label, status, and the relevant call/return `details`.
- [ ] Hovering any flow-view top-bar node opens the inspector with the role's cumulative counts/tokens/time and error state.
- [ ] Hovering any sequence-view message or terminal node opens the inspector with the operation's `details`.
- [ ] The inspector follows the pointer, dismisses on `mouseleave` (not `mouseout`), and does not flicker between a message and its terminal node.
- [ ] The security invariant holds: `details` reaches the DOM only through the sanitized Markdown path; all other fields are `textContent`.

## Sequencing

After step 14 (live hookup — the views render from live data, so the inspector has a model to read). Before step 16 (retire legacy + polish — the inspector is part of the visualization the polish pass refines). The deferred streaming step (17) is unrelated and executor-dependent.

## Operator handoff

Hover every kind of element in both views against a real multi-role run (local Ollama) and confirm the card reads correctly: a delegation edge shows the task text; a tool edge shows arguments then the result; a role node shows its status and finish summary; a top-bar slot shows cumulative counts; a sequence message shows its `details`. Confirm the card does not leak markup (no `innerHTML` path), repositions at viewport edges, and dismisses cleanly. Sign-off unblocks the step-16 retire-and-polish pass.

## Closeout (2026-07-12)

In-environment complete: `bun run typecheck` and `bun test source/` green (708 tests). The stale pre-MVC `deriveTooltipForNode` / `deriveTooltipForEdge` (which read a `flowModel.mainArea` shape that no longer exists) are replaced by three InteractionModel-based derivations in `tooltip.js`: `deriveOperationTooltip` (flow call/return edges and sequence messages/terminal nodes, by `data-operation`), `deriveParticipantTooltip` (flow main-area nodes, by `data-participant`), and `deriveRoleTooltip` (flow top-bar slots, by `data-role`). They are pure functions of `(model, label resolver, id)` and are exercised in-memory by `source/web/tooltip.test.ts` against the real seed-guild label resolver. `tooltipStyle` moved into `tooltip.js` as a shared export so the product client and the dev harness place the card identically.

The product client (`app.js`) wires the inspector as a hyperapp-managed overlay — the same pattern the question/result modals follow — rather than an imperative DOM append: `mouseover`/`mouseleave`/`click` on the `.pb-flow` stage set a tooltip descriptor in state, `TooltipCardForRun` renders the `Tooltip` card vnode positioned by `tooltipStyle`, and `mouseleave` (not `mouseout`) dismisses. Returning the same state reference when nothing changed lets hyperapp bail without a re-render, so the frequent `mouseover` events do not churn. The wiring reads the live `state.flowModel` and `state.labelResolver` at render time, so the inspector never re-fetches and never invents content the model does not carry; a stale id self-dismisses (the derivation returns `{ title: '' }` and the render path treats that as "no card"). Clicking an in-flight `ask_human` row re-opens the question modal (the sequence view's re-entry affordance, since it has no flow-view Question button).

The dev harness (`demo.js`) now consumes the same `deriveOperationTooltip` and `tooltipStyle`, so there is one inspector derivation, not two. Its flow view still carries no hover wiring (the harness is removed in step 16, so wiring it was out of scope). `docs/security.md` records that the live inspector preserves the invariant: the resolved label, kind, invocation counts, total time/tokens, and status words are `textContent`, and the only prose a section carries is the operation `details` markdown routed through the shared sanitized pipeline; no `details` string is interpolated into an SVG attribute or `innerHTML`.

Operator visual sign-off (hovering every element kind in both views against a real multi-role local-Ollama run) is the remaining gate.
