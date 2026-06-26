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

- Web-only, fixture-driven. Reuses the step-08 tooltip and the step-09 scaffold. No `render.ts`, backend, or endpoint changes.
- No new dependencies. Zoom/pan is plain `viewBox` math.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] Hovering/clicking a sequence message opens the friendly-formatted tooltip with copy-raw, identical in behavior to the flow graph.
- [ ] Wheel zooms toward the cursor; drag pans; "jump to active" scrolls to the latest message.
- [ ] Zoom/pan state resets on run/fixture switch.
- [ ] Reads correctly in light and dark across the fixtures.

## Operator handoff

Investigate the multi-role and retry fixtures in Sequence view in the playback harness: zoom/pan, inspect messages, copy-raw. Confirm the debug experience is pragmatic. Report interaction adjustments.
