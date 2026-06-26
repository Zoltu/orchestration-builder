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

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The full visualization assembles and renders every fixture scenario correctly in both light and dark.
- [ ] The Flow/Sequence toggle, modals, tooltips, product surfaces, and animation all work together against fixtures.
- [ ] The derivation surface is clean (no casts, no duplicated logic, consistent naming).
- [ ] `docs/security.md` confirms the security invariant holds for the full visualization.
- [ ] **Operator signs off on the visualization** — this is the phase-A gate.

## Operator handoff

This step's entire deliverable is the operator review: cycle through every fixture in the playback harness in both themes, exercise the Flow and Sequence views, the question and result modals, the failure surfacing, the tooltips and copy-raw, and the product surfaces. Sign off when the visualization is nailed down. Any remaining adjustments are made here before phase B begins; phase B (12–14) then makes it real against live data.
