# UI step 06 — Human question modal + "You" node as root

## Goal

Make `ask_human` unmissable via a **per-run-view modal** (covers the main view, not the page — designed for a future multi-run world where the user can switch away and back), and integrate the **"You" (Human) node** into the two-component flow view. A root "You" is always present in the main area at column 1 (the root of every call stack, until the task finishes). A child "You" appears — like any agent node — when an agent asks a question, showing the question arriving; after the user answers, the child "You" lingers as a response edge back to the asking agent, then departs to the top bar when the caller acts. The top bar has a "You" slot with cumulative Q&A stats. Flash + beep (existing) cover the away-from-keyboard case. Iterated against the pending-question fixture.

## Context

Read [`PLAN.md`](PLAN.md) ("Human question = modal", "You node"), [`03-flow-graph-static-layout.md`](03-flow-graph-static-layout.md) (the two-component flow view and the "You" node design), `source/web/static/app.js` (the existing `ask_human` answer form + flash/beep wiring), `source/executor/human-backend.ts` (`PendingQuestion` shape), and `source/web/render.ts` (`deriveQuestionHistory`, `renderPendingQuestions`). The existing answer form is inline in a questions panel; this step promotes it to a modal scoped to the run view and connects it to the "You" node(s) in the flow view.

## Deliverables

1. **`source/web/static/app.js`** — a `QuestionModal` component rendered as an overlay over the run view (not `document.body`-wide) when there are pending questions for the active/selected run. Shows the question (sanitized Markdown via step 27), optional context, and the answer input + submit. The modal names which run is asking (preparation for multi-run). Flash + beep fire as today when a question arrives. In the playback harness, the pending-question fixture exercises the modal without a real backend.
2. **`source/web/static/flow-graph.js`** — extend the flow graph so a child "You" node appears in the main area when an agent asks a question (an `ask_human` call edge from the asking agent to the child "You"), and lingers as a response edge (child "You" → asking agent) after the user answers, until the asking agent emits a new action. The root "You" stays in column 1 throughout. The top bar's "You" slot accumulates the Q&A count. Pure derivation; covered by `flow-graph.test.ts` against the fixture.
3. **`source/web/static/styles.css`** — modal overlay styling: a backdrop over the run view area (not the sidebar), a centered card, theme-aware. Obviously unmissable but not alarming. Focus the answer input on open; decide Escape behavior during implementation (the priority is "can't miss it").
4. **`docs/security.md`** — note the modal renders question text/context as sanitized Markdown; the answer input is trusted operator input sent verbatim.

## Module boundaries

- Web-only, fixture-driven. No backend or endpoint changes (the `/api/questions` + `/api/answer` routes already exist; phase A uses the fixture's pending questions).
- The modal is scoped to the run view by design (per `PLAN.md`), even though only one run is active today — free forward-compatibility.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] A pending `ask_human` (the fixture) opens a modal over the run view that cannot be missed; flash + beep wiring is preserved.
- [ ] The root "You" stays in column 1; a child "You" appears when an agent asks a question and lingers as a response edge after the answer, then departs to the top bar when the caller acts.
- [ ] The child "You" behaves like any other agent node (enters, lingers, departs to the top bar).
- [ ] The modal renders question text/context as sanitized Markdown; the answer is trusted operator input.
- [ ] The modal reads correctly in light and dark.

## Operator handoff

Load the pending-question fixture in the playback harness. Confirm the modal is unmissable, the child "You" node shows the Q&A flow (appears on question, lingers after answer, departs when the caller acts), and answering dismisses the modal. Report modal/styling adjustments.
