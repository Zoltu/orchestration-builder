# UI step 09 — Sequence diagram view (debug toggle): scaffold + toggle

## Goal

Add the **Sequence** view as a debug toggle alongside the Flow view: an SVG sequence diagram with one column per role plus a "tools" column, messages as horizontal lines on a vertical time axis. This step delivers the scaffold — columns, time axis, message lines, and the toggle — with static rendering against fixtures. Interaction (hover inspector, zoom/pan) is step 10.

## Context

Read [`PLAN.md`](PLAN.md) ("Sequence view (debug toggle)"), [`02-visual-foundation-tokens-svg-primitives.md`](02-visual-foundation-tokens-svg-primitives.md) (the SVG primitives + `viewBox` foundation), and `source/web/render.ts` (`parseLogEvents`, `formatLogEvent`, the full `LogEvent` taxonomy). The sequence diagram is a temporal layout: each event is a horizontal message from its role's column to a target column (a child role for `agent_call`/`role_start`, the tools column for `tool_call`/`tool_result`, the human column for `ask_human`/`human_answer`). The vertical position is the event's timestamp order.

## Deliverables

1. **`source/web/render.ts`** — add `deriveSequenceDiagram(config, runView)`, a pure function producing a `SequenceDiagram`: columns (Human + each role + a tools column, ordered Human → entry → workers → side → tools, with friendly labels), and messages (one per log event, with from-column, to-column, vertical position by timestamp order, and the event's `LogDetailSection`s for step-10 inspection). Pure; covered by `render.test.ts` against the fixtures.
2. **`source/web/render.test.ts`** — cover `deriveSequenceDiagram`: column set from config; message ordering by timestamp; `agent_call`/`role_start` → child column; `tool_call`/`tool_result` → tools column; `ask_human`/`human_answer` → Human column; completed vs in-progress.
3. **`source/web/static/app.js`** — a `SequenceView` component rendering the columns as vertical lifelines and messages as horizontal lines (with arrowheads for direction), inside an SVG with a `viewBox` sized to the diagram. A **view toggle** (Flow / Sequence) in the run-view header switches the centerpiece; Flow remains the default. Static render this step. Wired into the playback harness so the operator scrubs fixtures in both views.
4. **`source/web/static/styles.css`** — sequence diagram styling: lifelines, message arrows, column headers, theme-aware. The toggle control is clearly a debug affordance (not the product surface).

## Module boundaries

- Web-only, fixture-driven. `render.ts` gains a new pure derivation; `app.js` gains the view + toggle. No backend or endpoint changes.
- The hover inspector and zoom/pan are deliberately deferred to step 10 so this step stays session-sized (sequence diagrams are fiddly to lay out; isolating the scaffold from the interaction is the right cut).

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The toggle switches between Flow (default) and Sequence.
- [ ] Columns are Human + roles + tools, ordered, with friendly labels.
- [ ] Messages are horizontal lines ordered by timestamp, arrowed by direction, routed to the correct target column.
- [ ] The SVG uses a `viewBox` (so step-10 zoom/pan is near-free).
- [ ] Reads correctly in light and dark across the fixtures.

## Operator handoff

Toggle to Sequence on the multi-role and retry fixtures in the playback harness. Confirm columns/messages read correctly and the layout isn't cramped for a realistic event count. Report layout adjustments.
