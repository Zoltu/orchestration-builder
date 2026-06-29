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

- [x] `bun run typecheck` and `bun test source/` pass.
- [x] A pending `ask_human` (the fixture) opens a modal over the run view that cannot be missed; flash + beep wiring is preserved.
- [x] The root "You" stays in column 1; a child "You" appears when an agent asks a question and lingers as a response edge after the answer, then departs to the top bar when the caller acts.
- [x] The child "You" behaves like any other agent node (enters, lingers, departs to the top bar).
- [x] The modal renders question text/context as sanitized Markdown; the answer is trusted operator input.
- [x] The modal reads correctly in light and dark.

## Operator handoff

Load the pending-question fixture in the playback harness. Confirm the modal is unmissable, the child "You" node shows the Q&A flow (appears on question, lingers after answer, departs when the caller acts), and answering dismisses the modal. Report modal/styling adjustments.

## Closeout (2026-06-29)

In-environment complete: `bun run typecheck` and `bun test source/` green (614 tests, +14 from `question-modal.test.ts` and the pending-question post-answer/`deriveLifecycle` coverage in `flow-view.test.ts`). A pending `ask_human` question now opens an unmissable per-run-view modal over the flow area, and the child "You" node completes its full lifecycle (appears on the question, lingers as a response edge after the answer, departs to the top bar when the caller acts), with the top-bar "You" slot accumulating the Q&A count.

Two new browser-pure modules and one shared pipeline extraction:

- `source/web/static/question-modal.js` exports `derivePendingQuestion(runView)` (the first question-history entry without an `answer` — the same "unanswered" convention `deriveQuestionHistory` in `render.ts` produces when an `ask_human` log event has no matching `human_answer`) and `QuestionModal(h, { question, runLabel, renderMarkdown, onSubmit, answerPending })`, the overlay vnode builder. `h` and `renderMarkdown` are injected so the component is exercisable in tests with fakes (mirroring `flow-view.js` / `markdown.js`); the submit handler is supplied by the caller (the harness advances the frame; the product client will POST to `/api/answer`). The modal is scoped to the run view (an overlay over `.pb-flow`, not a page-wide mask) so a future multi-run world can switch away and back.
- `source/web/static/markdown-render.js` exports `createMarkdownRenderer(h)`, the showdown → highlight.js → `markdown.js` allowlist → hyperapp vnode pipeline extracted verbatim from `app.js` into a shared browser-pure module. `app.js` constructs one renderer against its `h` (`const renderMarkdown = createMarkdownRenderer(h)`); the playback harness constructs another against its own `h` and passes it to the modal, so the harness renders question text/context through the identical sanitized path the product client uses.
- The child-You lifecycle needed no `flow-view.js` code change: the existing `question`/`return` edge-state and `deriveLifecycle` depart/merge machinery already handle a `you`-kind node (the `slotKey` is `kind|label`, so the departing respondent `you-ask` merges into the existing top-bar `you` slot). The step adds the two missing fixture frames that exercise it.

The pending-question fixture grew from 4 frames to 6: frame 4 (answered — the question edge becomes a `you-ask → ask_human` return and an `ask_human → orchestrator` return, both lingering right→left while the orchestrator receives), and frame 5 (the caller acts — `you-ask` and `ask_human` depart and merge into their top-bar slots; the `you` slot's count rises to 2, the root plus one completed Q&A).

Deviations from the plan wording, recorded so the next step inherits reality:

- **The modal lives in the playback harness (`playback.js`), not `app.js`.** The plan's deliverable 1 names `app.js`, but `app.js` is the product client that does not yet host the flow view (the flow view is wired only into the dev playback harness during phase A; live hookup is step 13). The modal overlays the *flow view*, which is not in `app.js` yet, so it goes where the flow view is. This is the same call steps 04 and 05 made ("The surfaces live in `playback.js`, not `app.js`"); the product modal hookup (replacing the inline `QuestionsPanel` answer form) is step 13/14.
- **The Markdown pipeline was extracted into `markdown-render.js` rather than duplicated in the harness.** Step 05 duplicated `EFFORT_LABELS` (six lines) in the harness to avoid importing `app.js`, which pulls in runtime deps the harness did not serve. The Markdown pipeline is ~100 lines and touches `window.showdown`/`window.hljs`/`DOMParser`, so duplicating it was not defensible; it was extracted into a shared browser-pure module that both `app.js` and the harness import (`const renderMarkdown = createMarkdownRenderer(h)`). `markdown.js` stays the pure-transform allowlist (it imports nothing); `markdown-render.js` is the browser-facing half that owns the globals and the cache. `playback.html` now loads the vendored `showdown.js` + `highlight.js` so the harness can render the question as sanitized Markdown. `app.js`'s call sites are unchanged (`renderMarkdown(text)`); only the definition moved.
- **The harness flashes via a CSS entrance animation, not the product `Flash`/`Beep` effects.** "Flash + beep wiring is preserved" is satisfied by not touching `app.js`'s `runFlash`/`runBeep`/`GotQuestions` (the extraction above moved only the Markdown pipeline; the flash/beep code is untouched and still fires on the real `/api/questions` poll). The harness has no question-poll to fire them, so the modal card carries a one-shot CSS `question-modal-flash` keyframe (a brief accent glow + scale-in on mount) as the visual "can't miss it" cue; the product beep remains a step-13 concern. The modal re-mounts on each appearance (it is conditionally rendered — absent when no question is pending), so scrubbing back to a pending frame replays the flash.
- **The post-answer topology is a stacked return, not a single child-You → asking-agent edge.** The plan's deliverable 2 says the child "You" lingers "as a response edge (child 'You' → asking agent)". The respondent's caller in the question edge is the `ask_human` tool, not the asking agent (the established fixture model — tested since step 03 — is `ask_human → you-ask`, with `ask_human` a tool node between the asking agent and the respondent). So the answer travels back along the same chain the question traveled forward: `you-ask → ask_human` (the respondent returns the answer to the tool) and `ask_human → orchestrator` (the tool hands its result to its caller), both lingering right→left until the orchestrator acts. This reuses the existing tool-return machinery verbatim and keeps `ask_human` behaving "like any tool node" (it lingers with a return edge to its caller until the caller acts), which the design's "every tool is its own node" and "lingers as a response edge" rules require.

Operator action required: open `http://<host>:<port>/playback.html` in a browser, select the "ask_human question: pending, answered, then caller acts" scenario, and scrub to frame 3 (pending). Confirm the modal is unmissable (accent-bordered card, entrance flash, autofocus on the answer field, question + context rendered as Markdown), answering dismisses it (frame 3 → 4), and the child "You" node enters on the question (frame 3), lingers as a return edge after the answer (frame 4), and departs to the top bar — bumping the "You" count to 2 — when the caller acts (frame 5). Review in both light and dark. Report modal/styling adjustments; the card sizing, the flash intensity, and the heading wording are the tuning surface.
