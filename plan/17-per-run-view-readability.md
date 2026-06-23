# Step 17 — Per-run view readability

## Goal

Make the per-run view legible to the non-developer target user. Today the recent-log panel renders each event as raw `JSON.stringify(payload)`; a failed run's error is invisible (the summary shows only `result.summary`); `ResultCard.artifacts` are never rendered; and there is no "what is it doing right now" indicator. This step replaces the raw-JSON log with readable event rows, surfaces run errors and artifacts, and adds a current-activity line — all driven by data the API already returns or can return without executor changes.

## Context

Read [`14-multi-run-ui.md`](14-multi-run-ui.md) (the current UI surface and its `textContent`-only security invariant), `source/web/static/app.js` (the `renderLog`/`renderRunSummary`/`renderRoles` functions this step extends), `source/web/render.ts` (`renderRunView`, `deriveRoleActivity`, the `RunView`/`RunSummary` shapes), and `source/executor/types.ts` (`RunMeta` including `error`, `ResultCard` including `artifacts`, `LogEvent`).

The recent-log panel is the operator's main window into what a run is doing. Raw JSON is unreadable for the target user and obscures the signal (which role, which tool, what status). Formatting belongs in `render.ts` as a pure, testable helper rather than in `app.js` (a thin, untested DOM leaf); the API response carries the formatted line so `app.js` only renders `textContent`.

## Deliverables

1. `source/web/render.ts` — add a pure `formatLogEvent(event: LogEvent): string` that turns an event into a one-line human-readable description derived from `event.type` and the well-known payload fields (`role`, `tool`, `status`, `child`, `depth`). Examples: an `llm_call` with `{ role: 'coder' }` → `"coder · llm call"`; a `tool_call` with `{ role: 'coder', tool: 'write_file' }` → `"coder · write_file"`; a `role_finished` with `{ role: 'planner', status: 'success' }` → `"planner · finished (success)"`. Unknown payload shapes fall back to `"<type> · <role>"` and never throw.
2. `source/web/render.ts` — extend `RunView` so each `recentLog` entry carries its readable line alongside the raw event (e.g. `recentLog: { timestamp, type, summary, payload }[]`), produced by `formatLogEvent`. Keep the raw `payload` so `app.js` can offer an expandable detail view via `textContent` (a `JSON.stringify` into `textContent` is safe).
3. `source/web/render.ts` — add `error` to `RunView` (from `RunMeta.error`, `null` while in progress) so failed/needs-clarification runs surface the error `kind` and `message` instead of only `result.summary`.
4. `source/web/render.ts` — add `currentActivity` to `RunView`: the readable line and role of the most recent event (or `null` for an empty log), so the UI can show "now: coder · write_file" at a glance.
5. `source/web/static/app.js` — render the recent log as readable rows (timestamp, type badge, summary line) with the raw payload behind a per-row toggle; render `error` (kind + message) prominently in the run summary when present; render `result.artifacts` (e.g. file paths) as a list in the run summary; render `currentActivity` in the status/role area. All rendering stays `createElement`/`textContent` only — no `innerHTML`.
6. `source/web/render.test.ts` — cover `formatLogEvent` (each known event type, unknown-payload fallback, no-throw), the `recentLog` summary shaping, `error` surfacing (present, absent, in-progress null), and `currentActivity` (derived from last event, null on empty log).
7. `source/web/server.test.ts` — update fixtures so the `/api/runs/:id` view exercises the new `recentLog` summary shape, `error`, and `currentActivity` fields.
8. `source/web/static/styles.css` — minimal styling for the readable log rows, the error block, the artifacts list, and the current-activity line.

## Module boundaries

- `render.ts` holds all formatting/derivation logic as pure, testable helpers; the server is unchanged apart from the response shape it already delegates to `renderRunView`.
- `app.js` is a thin DOM leaf and is not unit-tested (per the testing policy); it renders pre-formatted text from the API and toggles raw-payload detail via `textContent`.
- No executor changes. No new endpoints. `ResultCard.artifacts` and `RunMeta.error` already exist on the persisted artifacts — this step only reads and shapes them.
- If the readable-line shaping reveals that some logged event lacks the `role` field needed for a useful summary, record it and propose folding the logging fix into step 22 (executor role-tree events) rather than expanding this step into the engine.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the extended `render.test.ts` and `server.test.ts`.
- [ ] The recent-log panel shows readable rows (role · action) instead of raw JSON; raw payload is available behind a toggle.
- [ ] A failed run surfaces its error `kind` and `message` in the run summary.
- [ ] `result.artifacts` render in the run summary when present.
- [ ] A current-activity line shows the latest event's role and action for an in-progress run.
- [ ] All rendering uses `createElement`/`textContent` (no `innerHTML`); untrusted content never reaches the DOM as markup.

## End-of-step evaluation

Re-read `app.js` for `innerHTML` absence on every untrusted-content path (log rows, raw-payload detail, error text, artifact paths, current-activity). Confirm `formatLogEvent` never throws on a partial or unexpected payload (the log is append-only and read concurrently with writes, so a malformed final line is the expected failure mode). Confirm the `recentLog` shape change did not silently drop the raw `payload` that the toggle depends on. Confirm `currentActivity` is `null` for an empty log rather than rendering a stale or undefined line.

## Estimated effort

Small to medium — mostly a pure formatter in `render.ts` plus DOM work in `app.js` against data the API already returns. No backend or executor changes.

## Operator handoff

Run the service against a benchmark that produces a multi-role, multi-tool run and exercise the rewritten per-run view in a browser: confirm the log reads as role · action rows, the raw payload toggles open, a failed run shows its error, artifacts list when present, and the current-activity line tracks the latest event as the run progresses. Report any event types that render as an unhelpful fallback; the agent extends `formatLogEvent` in-environment.
