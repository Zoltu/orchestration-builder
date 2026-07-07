# UI step 11 — Visualization sign-off + polish (phase A close)

## Goal

Assemble every phase-A piece into one reviewable fixture-driven view, do a polish pass across the whole visualization in both light and dark themes, and reach **operator sign-off on the visualization** before any backend work begins. This is the gate between phase A (visualization against fixtures) and phase B (backend changes + hookup). After this step the visualization is nailed down; steps 12–14 make it real.

## Context

Read [`PLAN.md`](PLAN.md) ("Methodology: fixture-first, backend-last") and the closeouts of steps 03–10. By this point the playback harness renders, against fixtures: the animated two-component flow view (03, 04) with the "now" caption + budget bar + cost strip (05), the question modal + "You" nodes (06), the result modal + CTA + failure surfacing (07), friendly-detail tooltips with copy-raw (08), and the sequence-diagram debug toggle with inspector + zoom/pan (09, 10). This step integrates, polishes, and confirms — it builds no new features.

## Deliverables

1. **`source/web/static/app.js`** — assemble the pieces into the final fixture-driven layout: new-run editor + effort (top, from step 28), sidebar run list (left, from step 28), and the two-component Flow/Sequence centerpiece with the product surfaces and modals. Confirm the playback harness selects any fixture and the whole view reflects it. This is the layout step 14 will keep when it swaps fixtures for live data.
2. **`source/web/static/styles.css`** — final polish pass on the visualization: consistent spacing, the focal hierarchy (two-component flow view, "now" caption, cost strip), light and dark both calibrated, the modal overlays, the tooltips, the sequence view. Re-read against `AGENTS.md` "Formatting" (no reiterative comments, no arbitrary wraps, one blank line between top-level groups). No leftover styles for pieces not yet assembled.
3. **`source/web/static/flow-graph.js`** and **`source/web/static/sequence-diagram.js`** — re-read the phase-A derivations (`deriveFlowGraph`, `deriveFlowAnimation`, `deriveNowCaption`, `deriveSequenceDiagram`) as a set: consistent naming, no duplicated shape logic, no `as` casts, no control-flow-via-catch. Refactor while context is fresh — small refactorings here keep the derivation surface healthy for phase B's live-data swap.
4. **`docs/security.md`** — confirm the full fixture-driven visualization renders untrusted content only via the step-27 sanitized Markdown path (result/error/question/task prose, tooltip prose) and `textContent` (names, counters, costs, timestamps, artifact paths, pretty-printed JSON).
5. **`plan/ui/PLAN.md`** — record the phase-A sign-off (dated) so phase B begins from a known-good visualization.

## Module boundaries

- Web-only, fixture-driven. No backend, no endpoints, no new features. This is integration + polish + sign-off only.
- The dev playback harness remains (removed in step 14 once live data is wired).

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass.
- [x] The full visualization assembles and renders every fixture scenario correctly in both light and dark. *(verified, operator review pending)*
- [x] The Flow/Sequence toggle, modals, tooltips, product surfaces, and animation all work together against fixtures. *(verified, operator review pending)*
- [x] The derivation surface is clean (no casts, no duplicated logic, consistent naming).
- [x] `docs/security.md` confirms the security invariant holds for the full visualization.
- [ ] **Operator signs off on the visualization** — this is the phase-A gate. *(operator review pending)*

## Adaptation from the original plan

The plan as written named pre-MVC artifacts and an `app.js` assembly that the MVC refactor (2026-07-01 design revision) superseded. The step was adapted rather than the code forced to match:

- **The fixture-driven layout is `demo.js`, not `app.js`.** Deliverable 1 asked for `app.js` to assemble the pieces into the final fixture-driven layout. `app.js` is the *product* client — it still renders the legacy panels (run summary, roles, log, questions, config) and does not yet mount the flow/sequence view; wiring the view modules to live data and retiring those panels is phase-B work (steps 13–14), not phase A. The phase-A fixture-driven layout already exists as the dev harness (`source/web/static/demo.html` + `demo.js`), which assembles the two-component flow/sequence centerpiece, the "now" caption + cost strip, the question and result modals, and the tooltip inspector against the `InteractionModel` fixtures. No assembly work remained; this step confirms the harness is the realized layout step 14 will keep when it swaps fixtures for live data.
- **The derivations are `flow-view.js` / `sequence-diagram.js` / `interaction-model.js`, not `flow-graph.js` / `deriveFlowGraph` / `deriveSequenceDiagram`.** Deliverable 3 named the pre-MVC module and function names. The canonical derivations (`deriveLifecycle`, `renderFlowView`, `deriveNowCaption`, `deriveCostStrip`, `activeAskHumanCall` in `flow-view.js`; `renderSequenceView` in `sequence-diagram.js`; the model helpers in `interaction-model.js`) were re-read as a set: no `as` casts (the modules are browser-pure JS), no control-flow-via-catch (the remaining `try/catch` are `JSON.parse` fallbacks for exceptional malformed input — the sanctioned exceptional path), and no duplicated shape logic (the two views are independent leaves over the shared model and import no rendering code from each other). One stale MVC-rename leftover was fixed: two comments in `flow-view.js` described the CTA as "ported from the sibling flow-view.js" — self-referential after the MVC cleanup promoted `mvc/flow-view.js` to the canonical `flow-view.js` — and were rewritten to drop the provenance and keep the rationale.
- **`docs/security.md` was already complete; no edit was needed.** Deliverable 4 asked to confirm the security invariant. The doc already covers every visualization surface: the sanitized-Markdown/`textContent` split (lines 18–31), the flow view (33), the question modal (35), the result modal (37), the tooltip inspector (39), the sequence view and its `details`-markdown inspector (41), and the "now" caption + cost strip (43). The step-10 sequence inspector (an operation's `details` through the shared `tooltip.js` card) is already documented at line 41. Adding a redundant confirmation sentence would restate the existing invariant, so the review confirmed the doc rather than editing it.
- **The CSS polish pass found no debt.** `styles.css` was already calibrated in step 28 and the MVC steps; the step-10 pass added the sequence-view interaction cues (`cursor: help` on inspector targets, the token-driven `:hover` row highlight, `cursor: default` on the scroll container). A re-read found consistent spacing, the focal hierarchy intact, no leftover styles for deleted pieces (no `playback`/`flow-graph`/`pathfinding`/`fixtures` class references survive), and no consecutive blank lines or reiterative comments. No CSS edit was needed for this step.

## Operator handoff

This step's entire deliverable is the operator review: cycle through every fixture in the playback harness in both themes, exercise the Flow and Sequence views, the question and result modals, the failure surfacing, the tooltips, and the product surfaces. Sign off when the visualization is nailed down. Any remaining adjustments are made here before phase B begins; phase B (12–14, 16) then makes it real against live data.

## Closeout (2026-07-04)

Closed with the adaptations above. `bun run typecheck` and `bun test source/` (670 tests) green. The phase-A code-side gate is met; the phase-A sign-off is recorded in `plan/ui/PLAN.md` ("Design revisions" → 2026-07-04). Operator visual sign-off across every scenario in both themes and all three tiers is the remaining gate. Phase B (steps 12–14, 16) begins from this known-good visualization.
