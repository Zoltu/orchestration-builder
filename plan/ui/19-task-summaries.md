# UI step 19 — LLM-generated one-line task summaries

## Goal

Every run gets a one-line, LLM-generated summary shown as its primary label in the History rows and the Watch top bar. Two summaries are produced per run: a **start summary** when the run is accepted (from the task alone) and a **completion summary** that replaces it (from the task, the interrupt history, and the final result — a more accurate statement of what the run actually did). This supersedes truncation as the answer to "history rows must cope with large prompts": the first line of a prompt often does not contain the meat of what was desired.

## Context

The service already holds everything the feature needs, web-side: `serve.ts` builds the `llmCaller`, sees every submission (task text in hand), and observes every completion (`StartRun`/`ResumeRun` settle with the terminal `RunMeta`). The executor stays untouched — summaries are UI plumbing, not agent work, so they are not logged as run events and do not enter the flow model.

Design:

- **Storage** is a plain-text `summary.txt` in the run directory (no JSON schema to validate; absence means "no summary"). The completion write overwrites the start write. If either LLM call fails, the file is simply absent/stale and the UI falls back to the task text — a run never fails over a label.
- **The start summary** fires after a run is accepted (fire-and-forget; the POST response is not blocked). The completion summary fires when the run settles (fresh and resumed runs alike), reading the interrupt history from the run's own `log.jsonl` via the existing `parseLogEvents` + `deriveInterruptHistory` (both pure, already server-side).
- **The summarizer** is testable orchestration (`source/web/summarize.ts`): it receives the `LlmCaller`, a log reader, and a summary writer as injected leaves. A pure helper (`toOneLineSummary`) reduces whatever the model returns to a single bounded line (first non-empty line, stripped of list/heading markers, capped at a word boundary) — the client still treats it as untrusted text and renders it only as `textContent`.
- **Generation parameters**: a fixed tiny request (system prompt demanding ≤15 words, no tools, the model config's own sampling). The summary call does not branch on effort — it is service-level bookkeeping with a constant quality bar.
- **API**: `renderRunSummary` gains a `summary: string | null` field, read from `summary.txt` by `handleListRuns` alongside the meta it already reads per run. The client prefers `summary` over the task first line in History rows and the Watch top bar; everything degrades to the step-18 display when absent.

## Deliverables

1. **`source/executor/persistence.ts`** — two leaves following the existing patterns: `createWriteRunSummary(baseDir)` (creates the run directory if needed, writes `summary.txt`) and `createReadRunSummaryById(baseDir)` (`string | null`; empty/whitespace reads as absent). Export both from `source/executor/index.js`.
2. **`source/web/summarize.ts`** — `createTaskSummarizer(dependencies)` returning `{ summarizeTaskStart(runId, task), summarizeRunCompletion(meta) }`, plus the pure `toOneLineSummary(content)` helper. The completion input assembles task + interrupt history (kind, message, answer/outcome) + result summary + status into a compact briefing. Any non-`success` LLM result produces no write.
3. **`source/web/summarize.test.ts`** — in-memory tests over a fake caller: start summary writes the one-liner; completion summary incorporates interrupts and result; malformed/overlong/multi-line model output is reduced correctly by `toOneLineSummary`; failure results write nothing.
4. **`source/serve.ts`** — wiring: on submission, fire-and-forget `summarizeTaskStart`; attach a settlement hook to the start/resume promises that calls `summarizeRunCompletion(meta)`. A rejected run (fatal path) produces no summary write. The hooks never block or alter the run's own promise.
5. **`source/web/render.ts` + `source/web/request-handler.ts`** — `RunSummary.summary` + `handleListRuns` reads `summary.txt` per run. Update `render.test.ts` / server tests.
6. **`source/web/static/app.js`** — History rows and the Watch top-bar label prefer `summary` over the task first line (fallback unchanged).
7. **`docs/security.md`** — one line: the generated summary is agent prose rendered only as `textContent`. If a doc enumerates the run-directory layout, add `summary.txt` there.
8. Real-LLM smoke test against the local endpoint (per `AGENTS.md` "Local test model"): submit a run, watch `summary.txt` appear at start and be replaced at completion; confirm the UI labels switch.

## Module boundaries

- Web layer + two persistence leaves. The executor runtime is untouched; no new endpoints; the run-list payload gains one additive field.
- The summarizer never throws into the run path: the LLM caller already converts endpoint failures into `LlmCallResult` error kinds, and the summarizer maps any non-success to "no write".

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass.
- [x] A run's start writes `summary.txt` from the task alone; completion overwrites it from task + interrupts + result.
- [x] LLM failure at either point leaves the UI on the task-text fallback; the run itself is unaffected.
- [x] History rows and the Watch top bar prefer the summary; it renders as `textContent` only.
- [x] Smoke test against the local model verifies both writes end-to-end.

## Operator handoff

Browser check on a real run: the History row and top bar show the generated one-liner (start version while running, final version after completion), and the line reads better than a truncated prompt. Sign-off closes the step.

## Closeout (2026-08-02)

In-environment complete: `bun run typecheck` and `bun test source/` green (812 tests, including 10 new summarizer tests). `source/executor/persistence.ts` gained the `createWriteRunSummary`/`createReadRunSummaryById` leaves (`summary.txt`, plain text, absent-reads-as-null), exported via the barrel; `source/web/summarize.ts` holds `createTaskSummarizer` (start summary from the task; completion summary from task + interrupt history via `parseLogEvents`+`deriveInterruptHistory` + result/error) with the one-line reduction kept module-private per the no-export-for-testing rule — the reduction is tested through the public surface. `serve.ts` wires the hooks fire-and-forget (`fireAndForgetSummary` logs failures to the service console; the run promise's rejection branch stays with `runSubmission`'s fatal path). `renderRunSummary(runId, meta, summary)` gained the third parameter (no default, per policy); `handleListRuns` reads `summary.txt` per run; History rows and the Watch top bar prefer `summary` via the shared `runPrimaryLabel` helper. Docs: `docs/security.md` (generated summary is agent prose rendered only as `textContent`), `docs/reference.md` (`GET /api/runs` field), `docs/architecture.md` (layout gains `summary.txt` and the previously-undocumented `state.json`). Smoke test against the local llama-server (throwaway workspace, effort 0): the start summary landed ~7s after submission ("Create hello.txt containing hello world in workspace."), the run completed successfully, and the completion summary replaced it ("The run created hello.txt containing hello world."); `GET /api/runs` serves the field. Operator visual check of the labels in place is the remaining gate.
