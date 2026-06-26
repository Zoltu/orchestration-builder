# UI step 06 — Human question modal + "You" node as root

## Goal

Make `ask_human` unmissable via a **per-run-view modal** (covers the main view, not the page — designed for a future multi-run world where the user can switch away and back), and integrate the **"You" (Human) node** as the graph's root that behaves like any other node: it lights up first (the run begins from the human's question), accumulates a Q&A counter, and shows the question arriving and the answer leaving. Flash + beep (existing) cover the away-from-keyboard case. Iterated against the pending-question fixture.

## Context

Read [`PLAN.md`](PLAN.md) ("Human question = modal", "The 'You' node"), [`03-flow-graph-static-layout.md`](03-flow-graph-static-layout.md) (the Human root node), `source/web/static/app.js` (the existing `ask_human` answer form + flash/beep wiring), `source/executor/human-backend.ts` (`PendingQuestion` shape), and `source/web/render.ts` (`deriveQuestionHistory`, `renderPendingQuestions`). The existing answer form is inline in a questions panel; this step promotes it to a modal scoped to the run view and connects it to the Human node.

## Deliverables

1. **`source/web/static/app.js`** — a `QuestionModal` component rendered as an overlay over the run view (not `document.body`-wide) when there are pending questions for the active/selected run. Shows the question (sanitized Markdown via step 27), optional context, and the answer input + submit. The modal names which run is asking (preparation for multi-run). Flash + beep fire as today when a question arrives. In the playback harness, the pending-question fixture exercises the modal without a real backend.
2. **`source/web/render.ts`** — extend the flow graph so the Human node's state reflects pending questions: an incoming edge (agent → You) while a question is pending, an outgoing edge (You → agent) once answered, and the Q&A counter on the Human node (from `deriveQuestionHistory` length). Pure derivation; covered by `render.test.ts` against the fixture.
3. **`source/web/static/styles.css`** — modal overlay styling: a backdrop over the run view area (not the sidebar), a centered card, theme-aware. Obviously unmissable but not alarming. Focus the answer input on open; decide Escape behavior during implementation (the priority is "can't miss it").
4. **`docs/security.md`** — note the modal renders question text/context as sanitized Markdown; the answer input is trusted operator input sent verbatim.

## Module boundaries

- Web-only, fixture-driven. No backend or endpoint changes (the `/api/questions` + `/api/answer` routes already exist; phase A uses the fixture's pending questions).
- The modal is scoped to the run view by design (per `PLAN.md`), even though only one run is active today — free forward-compatibility.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] A pending `ask_human` (the fixture) opens a modal over the run view that cannot be missed; flash + beep wiring is preserved.
- [ ] The Human node shows the question arriving (incoming edge) and, after answering, the answer leaving (outgoing edge); the Q&A counter accumulates.
- [ ] The Human node behaves like any other node (no special-cased rendering beyond being the root).
- [ ] The modal renders question text/context as sanitized Markdown; the answer is trusted operator input.
- [ ] The modal reads correctly in light and dark.

## Operator handoff

Load the pending-question fixture in the playback harness. Confirm the modal is unmissable, the Human node shows the Q&A flow, and answering dismisses the modal and flows the answer back. Report modal/styling adjustments.
