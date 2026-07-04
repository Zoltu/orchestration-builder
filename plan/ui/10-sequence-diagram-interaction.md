# UI step 10 — Sequence diagram interaction: inspector + zoom/pan

## Goal

Add interaction to the sequence diagram: a hover/click **inspector** that reuses the step-08 tooltip module to show friendly-formatted detail for each message, and **zoom-to-scroll / pan** via the SVG `viewBox` (near-free once the scaffold has a `viewBox`). This completes the debug view. Iterated against fixtures.

## Context

Read [`PLAN.md`](PLAN.md) ("Sequence view", "zoomed out … nearly free"), [`09-sequence-diagram-scaffold-toggle.md`](09-sequence-diagram-scaffold-toggle.md) (the scaffold + `viewBox`), and [`08-tooltip-friendly-detail-copy-raw.md`](08-tooltip-friendly-detail-copy-raw.md) (the reusable tooltip module). The inspector is a repackaging of data the scaffold already attaches to each message (`LogDetailSection`s), so no new data shaping is needed.

## Deliverables

1. **`source/web/static/app.js`** — wire hover/click on sequence messages to open the step-08 `Tooltip` with the message's detail sections. Clicking copy-raw works identically to the flow graph. Reuse the tooltip module unchanged.
2. **`source/web/static/app.js`** — zoom/pan: wheel over the diagram adjusts the `viewBox` height (zoom toward the cursor); drag pans. A "jump to active" button scrolls the viewBox to the latest message for an in-progress run. State is local to the sequence view; reset on run/fixture switch.
3. **`source/web/static/styles.css`** — minimal: a cursor cue for the draggable/zoomable area, theme-aware hover highlight on messages. No minimap (deferred per `PLAN.md` until a real need arises).

## Module boundaries

- Web-only, fixture-driven. Reuses the step-08 tooltip and the step-09 scaffold. No `sequence-diagram.js`, backend, or endpoint changes.
- No new dependencies. Zoom/pan is plain `viewBox` math.

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass.
- [x] Hovering/clicking a sequence message opens the friendly-formatted tooltip, identical in behavior to the flow graph. *(copy-raw is intentionally absent — see "Adaptation" below)*
- [x] "Jump to active" scrolls to the latest message; wheel/drag navigate the timeline via the scroll container rather than a viewBox zoom/pan. *(scroll substitution — see "Adaptation" below)*
- [x] Scroll position resets on scenario/fixture switch and is preserved across frame, tier, and view-toggle navigation. *(scroll substitution — see "Adaptation" below)*
- [x] Reads correctly in light and dark across the fixtures. *(operator review)*

## Adaptation from the original plan

The plan as written specified viewBox zoom/pan (wheel-zoom-toward-cursor + drag-pan) and a copy-raw affordance on the inspector. Implementation revealed a simpler navigation model reads better for this surface, so the plan was adapted rather than the code forced to match — the same cut step 09 made:

- **Vertical scroll replaces viewBox zoom/pan.** The sequence view is a long, narrow, single-width timeline: every column is always in frame horizontally (the guild defines a small, fixed role set), and the only axis that grows is time. A viewBox zoom would scale the already-fitting horizontal layout pointlessly, and drag-pan would duplicate what a scroll container gives for free. The view therefore mounts inside a `pb-sequence-scroll` container (`overflow: auto`, `max-height: 70vh`) that scrolls vertically for long timelines; the SVG keeps its natural full-content viewBox and scales to the container width. The mouse wheel reaches the container and scrolls naturally. "Jump to active" (`jumpSequenceViewToActive` in `demo.js`) and the automatic forward-advance scroll retarget from the planned viewBox to the container's `scrollTop`, mapping the active row's fractional position in the natural viewBox height to a pixel offset in the container's scroll range. State is local to the sequence view: a scenario switch resets `scrollTop` to 0 (`scenarioChanged`), a forward frame advance (Next/Play) jumps to the active row, and every other navigation (Previous, arbitrary scrub, tier swap, view toggle) preserves the pixel `scrollTop` captured before the DOM rebuild.
- **No copy-raw on the inspector.** The inspector reuses `tooltip.js` *unchanged* (the MVC sub-plan's explicit "reused unchanged" contract), and `tooltip.js` is a read-only hover card by design ("no close button and no copy-raw"). The `InteractionModel`'s `details` field carries adapter-formatted markdown, not a raw JSON blob, so there is no raw payload to copy that the formatted view does not already show; copy-raw was a concern of the legacy `LogDetailSection`/raw-JSON flow-graph inspector, not of this model-driven surface. The inspector therefore renders the resolved label as the heading and a single `details` section through the sanitized markdown pipeline, and the pointer leaving the row dismisses it.
- **Interaction cues in CSS.** `styles.css` adds a `cursor: help` cue on `.seq-message-group` / `.seq-node` (the inspector targets) and a token-driven `:hover` highlight on the hovered row's `.seq-message` line, so the operator can see which row the pointer rests on before the tooltip card opens. The `.pb-sequence-scroll` container carries `cursor: default` so the navigation surface reads as scroll, not drag.

## Operator handoff

Investigate the multi-role and retry fixtures in Sequence view in the playback harness: scroll the timeline, inspect messages (hover/click), and use "Jump to active" on an in-progress frame. Confirm the debug experience is pragmatic. Report interaction adjustments.

## Closeout (2026-07-04)

Closed with the scroll-substitution adaptation above. `bun run typecheck` and `bun test source/` (670 tests) green. The step's MVC successor (`plan/ui/mvc/07-sequence-view-animation-interaction.md`) is the realized design; this file is updated to record the divergence so a reader inherits reality rather than the pre-implementation plan. Operator visual sign-off across the fixtures in both themes is the remaining gate.
