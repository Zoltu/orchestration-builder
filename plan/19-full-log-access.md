# Step 19 — Full log access

## Goal

Give the operator access to a run's entire event log, not just the most recent 200 lines, plus a way to export it. Today `GET /api/runs/:id` truncates the log to the last `MAX_LOG_LINES` (200) events and offers no way to page further back or download. For a long run, the early events — often where a problem started — are unreachable through the UI. This step adds a paginated log endpoint and an export action.

## Context

Read [`14-multi-run-ui.md`](14-multi-run-ui.md) (the recent-log panel and the `MAX_LOG_LINES` truncation in `source/web/server.ts`), `source/web/render.ts` (`parseLogEvents`, `renderRunView`'s `maxLogLines` option), `source/web/server.ts` (the `GET /api/runs/:id` handler and `runViewFor`), and `source/executor/persistence.ts` (`createReadRunSnapshotById` — the log is read in full from `log.jsonl`).

The full log is already read from disk by `readRunSnapshotById`; the 200-line cap is a rendering/default applied in `renderRunView`. Pagination is therefore a server/render concern: parse the full log, then slice a page. Export is a client concern: download the full log (or the current page set) as a file.

## Deliverables

1. `source/web/render.ts` — add a pure `paginateLogEvents(events, { offset, limit })` helper returning `{ events, total, offset, limit }`, and a `formatLogAsText(events)` helper that renders the log as plain text (one event per line: timestamp, type, readable summary) for export. Reuse `formatLogEvent` from step 17 if it has landed; otherwise format with `type` + a best-effort payload summary.
2. `source/web/server.ts` — add `GET /api/runs/:id/log` with optional `?offset` and `?limit` query parameters (defaults offset 0, limit 200), returning `{ runId, total, offset, limit, events }` where `events` are the raw `LogEvent`s for that page (the readable summary is added client-side or via `formatLogEvent`). Returns `404` for an unknown run. Keep `GET /api/runs/:id` returning the recent-log view unchanged (backward compatible).
3. `source/web/server.test.ts` — cover `GET /api/runs/:id/log`: default page, explicit offset/limit, offset past the end (empty page, correct total), `404` for an unknown run, and invalid query params (treated as defaults).
4. `source/web/static/app.js` — replace the fixed recent-log panel with a paginated view: show the most recent page, a "Load earlier" button that decrements the offset and prepends older events, and an "Export" button that fetches the full log (large limit) and downloads it as a `.log`/`.txt` file via a `Blob` and object URL. Keep the readable rendering and raw-payload toggle from step 17. All rendering stays `createElement`/`textContent`.
5. `source/web/static/styles.css` — minimal styling for the pagination controls and export button.

## Module boundaries

- `paginateLogEvents` and `formatLogAsText` are pure, testable helpers in `render.ts`.
- The new endpoint is a thin HTTP leaf in `server.ts` that delegates parsing to `render.ts` and paging to the pure helper; it adds no business logic.
- `app.js` is a thin DOM leaf (not unit-tested); the API contract is covered by `server.test.ts`.
- No executor changes; the log is already persisted in full.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the extended `render.test.ts` and `server.test.ts`.
- [ ] `GET /api/runs/:id/log` returns a page of events with correct `total`, `offset`, and `limit`; offset past the end yields an empty page with the correct total.
- [ ] `GET /api/runs/:id` is unchanged (recent-log view still works).
- [ ] The UI shows a page of events, "Load earlier" prepends older events, and "Export" downloads the full log as a text file.
- [ ] All rendering uses `createElement`/`textContent` (no `innerHTML`).

## End-of-step evaluation

Confirm the pagination helper handles an empty log and an offset past the end without returning negative counts or throwing. Confirm "Load earlier" stops offering more once the offset reaches 0. Confirm the export fetch uses a limit large enough to mean "all" (or fetches in pages and concatenates) and that the downloaded filename is derived from the run id (no untrusted content in the filename beyond the run id, which is server-generated). Confirm the new endpoint does not regress the existing `GET /api/runs/:id` route matching (the `/log` suffix must not be swallowed by the `:id` route).

## Estimated effort

Medium — a new endpoint with query parsing, a pure pagination helper and its tests, plus client pagination/export state. No executor changes.

## Operator handoff

Run the service against a benchmark that produces more than 200 log events and confirm: the log panel pages backward via "Load earlier" until the first event, the total count is correct, and "Export" downloads a text file whose contents match the full log. Report any truncation or offset bugs; the agent fixes them in-environment.
