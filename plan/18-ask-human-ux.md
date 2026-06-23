# Step 18 — `ask_human` UX

## Goal

Make the human-in-the-loop surface usable for a 24/7 left-running service. Today a pending `ask_human` question appears only as a quiet panel entry the operator can easily miss, and once answered the question vanishes — there is no history of what was asked and answered within a run. This step adds a question-arrival notification (visible highlight + optional audible alert, with a mute toggle) and a per-run question history that pairs each `ask_human` question with its answer.

## Context

Read [`14-multi-run-ui.md`](14-multi-run-ui.md) (the questions panel and `POST /api/answer` flow), `source/web/static/app.js` (`pollQuestions`, `renderQuestions`, `submitAnswer`), `source/web/render.ts` (`renderPendingQuestions`), `source/executor/human-backend.ts` (the pending-question shape and `submitAnswer`), and `source/executor/types.ts` (`LogEvent`).

The service is designed to run unattended; the operator must notice when the orchestrator needs them. A passive panel update is insufficient. Question history matters because a run may ask several clarifying questions, and reviewing the Q&A is part of reviewing the result — but today only *pending* questions are surfaced, and answered ones leave no trace in the UI.

## Deliverables

1. `source/web/static/app.js` — question-arrival notification: when `pollQuestions` returns a question id not seen since the last empty state, flash the questions panel (a CSS class toggled for a short interval) and play a short Web Audio beep (generated with `AudioContext`, no asset file). Add a mute checkbox in the header; when muted, suppress only the sound (keep the visual flash). Respect the browser's autoplay policy by creating the `AudioContext` on first user interaction. All DOM updates use `createElement`/`textContent`.
2. `source/web/render.ts` — a pure `deriveQuestionHistory(logEvents)` helper that pairs `ask_human` tool-call events with their resolved answers from the log, returning `{ question, context?, answer?, askedAt, answeredAt? }[]` in log order. Pairing is by the `ask_human` call's question id (or question text when no id is logged) matched to the corresponding answer event.
3. `source/executor/human-backend.ts` (extend, if needed) — if the resolved answer is not currently persisted to the log, add a minimal `human_answer` log event (`{ id, answer }`) at answer-submission time so `deriveQuestionHistory` can pair questions to answers for completed runs. This is an additive log event; existing readers ignore unknown event types. If the answer is already recoverable from the existing log, skip this.
4. `source/web/render.ts` — add `questionHistory` to `RunView`, produced by `deriveQuestionHistory`, so the per-run view can render past Q&A alongside pending questions.
5. `source/web/static/app.js` — render `questionHistory` in the questions panel (above pending), showing each question with its answer (or "unanswered"). Pending questions keep their answer form.
6. `source/web/render.test.ts` — cover `deriveQuestionHistory` (single Q&A pair, multiple, an unanswered question, ordering, the no-log empty case) and the `questionHistory` field on `RunView`.
7. `source/web/server.test.ts` — update the run-view fixture to include `ask_human`/`human_answer` events so `/api/runs/:id` exercises `questionHistory`.
8. `source/web/static/styles.css` — styling for the notification flash, the mute toggle, and the history entries.

## Module boundaries

- The notification is client-only (`app.js`); it depends only on the question ids `GET /api/questions` already returns.
- `deriveQuestionHistory` is a pure, testable helper in `render.ts`; `app.js` renders its pre-shaped output.
- The only backend/executor touch is the optional additive `human_answer` log event, needed only if answers are not otherwise recoverable from the log. If that touch is required, keep it to one `appendLog` call in `human-backend.ts`; do not change the `ask_human` tool contract or the pending-question shape.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the extended `render.test.ts` and `server.test.ts`.
- [ ] A new pending question flashes the questions panel and (when not muted) plays a sound; the mute toggle suppresses only the sound.
- [ ] The per-run view shows past `ask_human` questions paired with their answers (or marked unanswered).
- [ ] `deriveQuestionHistory` is covered for single, multiple, unanswered, and empty cases.
- [ ] All rendering uses `createElement`/`textContent` (no `innerHTML`); the Web Audio beep is generated, not a fetched asset.

## End-of-step evaluation

Confirm the notification fires only on a genuinely new question id (not on every poll of an already-shown question), and that it does not fire on the initial page load for a run that already has a pending question (avoid a startup beep). Confirm the mute state persists across polls (a module-level flag is fine; no server state needed). Confirm `deriveQuestionHistory` never throws on a log that has an `ask_human` without a matching answer. If a `human_answer` log event was added, confirm it is additive and existing log-reading tests still pass.

## Estimated effort

Medium — the notification is straightforward client work; the question history requires deciding whether answers are log-recoverable (and a small additive log event if not) plus a pure pairing helper and its tests.

## Operator handoff

Run the service, submit a task that triggers an `ask_human` question, and confirm: the panel flashes and beeps on arrival; the mute toggle silences the beep but keeps the flash; after answering, the question moves into the history list with its answer; selecting a completed run shows its full Q&A history. Report any case where a question is not paired with its answer; the agent fixes the pairing (or adds the `human_answer` event) in-environment.
