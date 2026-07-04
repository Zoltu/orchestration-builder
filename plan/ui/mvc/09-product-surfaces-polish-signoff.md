# MVC step 09 — Product surfaces + polish + sign-off

## Goal

Port the product surfaces (the "now" caption and the ambient cost strip) to read off `InteractionModel`, do a polish pass across both views in both themes against every scenario, and reach operator sign-off on the refactored visualization. This is the gate before the old demo is deleted: after this step the new `demo.html` is the canonical iteration surface and the old `playback.html` exists only to be removed in step 10.

## Context

Read [`PLAN.md`](PLAN.md) and the closeouts of steps 04–08. The old `flow-view.js` carried `deriveNowCaption` and a cost strip driven by `FlowModel` + `RunView`; the new versions derive off `InteractionModel` (the active participant's friendly description for the caption; per-operation `metrics` summed/latest for the cost strip). The tier toggle (step 03) now also drives the "now" caption's tier. This step builds no new structural feature — it integrates, polishes, and confirms.

## Deliverables

1. **`source/web/static/mvc/flow-view.js`** (or a small co-located helper) — `deriveNowCaption(model, labels, tier)` and a cost-strip derivation off `OperationMetrics`, both pure and tested. The caption names the active participant and the in-flight operation in the selected tier.
2. **`source/web/static/demo.js`** — render the "now" caption under the flow view and the cost strip in the harness chrome, both updating per frame.
3. **`source/web/static/styles.css`** — final polish pass on the new views: consistent spacing, focal hierarchy (flow view primary, "now" caption, cost strip), light and dark both calibrated, the modal/tooltip/sequence surfaces. Re-read against `AGENTS.md` "Formatting" (no reiterative comments, no arbitrary wraps, one blank line between top-level groups).
4. **`docs/security.md`** — confirm the refactored visualization renders untrusted content only via the step-27 sanitized Markdown path (the `details` field, tooltip prose) and `textContent` (identifiers, counters, costs, timestamps). Note that identifiers flow through the label registry (trusted data), while only `details` is per-call runtime content.
5. **`plan/ui/mvc/PLAN.md`** — record the sign-off (dated) so step 10 begins from a known-good refactor.

## Module boundaries

- Web-only. No backend, no new features beyond the two ported product surfaces. Integration + polish + sign-off only.
- The old `playback.html`/`playback.js`/`fixtures.js` remain untouched and functional (removed in step 10).

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The "now" caption and cost strip render correctly across every scenario and update per frame; the tier toggle swaps the caption's tier.
- [ ] Both views read correctly in light and dark across every scenario, including the nested-interrupt and fate scenarios.
- [ ] The derivation surface is clean: no `as` casts, no duplicated shape logic, no executor event types leaking into the views, consistent naming.
- [ ] `docs/security.md` confirms the security invariant holds for the refactored visualization.
- [ ] **Operator signs off on the refactored visualization** — this is the gate before cleanup.

## Operator handoff

Cycle through every scenario in `demo.html` in both themes and both tiers: exercise the flow and sequence views, the interrupt scenarios (nested, rewind, terminate, mid-flight), the observe lines, the "now" caption, the cost strip, the inspector, and zoom/pan. Sign off when the refactor is nailed down; step 10 then deletes the old demo.
