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

- [x] `bun run typecheck` and `bun test source/` pass, including the extended `render.test.ts` and `server.test.ts`.
- [x] `GET /api/runs/:id/log` returns a page of events with correct `total`, `offset`, and `limit`; offset past the end yields an empty page with the correct total.
- [x] `GET /api/runs/:id` is unchanged (recent-log view still works).
- [x] The UI shows a page of events, "Load earlier" prepends older events, and "Export" downloads the full log as a text file.
- [x] All rendering uses `createElement`/`textContent` (no `innerHTML`).

## End-of-step evaluation

Confirm the pagination helper handles an empty log and an offset past the end without returning negative counts or throwing. Confirm "Load earlier" stops offering more once the offset reaches 0. Confirm the export fetch uses a limit large enough to mean "all" (or fetches in pages and concatenates) and that the downloaded filename is derived from the run id (no untrusted content in the filename beyond the run id, which is server-generated). Confirm the new endpoint does not regress the existing `GET /api/runs/:id` route matching (the `/log` suffix must not be swallowed by the `:id` route).

## Estimated effort

Medium — a new endpoint with query parsing, a pure pagination helper and its tests, plus client pagination/export state. No executor changes.

## Operator handoff

Run the service against a benchmark that produces more than 200 log events and confirm: the log panel pages backward via "Load earlier" until the first event, the total count is correct, and "Export" downloads a text file whose contents match the full log. Report any truncation or offset bugs; the agent fixes them in-environment.

## Closeout (2026-06-24)

Complete. `bun run typecheck` and `bun test source/` both pass (385 tests across 29 files). No executor changes; the log is already persisted in full by `source/executor/persistence.ts`.

Changed files:

- `source/web/render.ts` — added three pure helpers: `toRecentLogEntry` (centralizes the entry shaping that `renderRunView` previously inlined, so the paginated endpoint and the recent-log view derive entries identically), `paginateLogEvents(events, { offset, limit })` returning `{ events, total, offset, limit }`, and `formatLogAsText(events)` rendering one tab-separated line per event (timestamp, type, readable summary) for export. `renderRunView` now calls `toRecentLogEntry` instead of building entries inline. The recent-log view (`GET /api/runs/:id`) is otherwise unchanged.
- `source/web/server.ts` — added `GET /api/runs/:id/log` returning `{ runId, total, offset, limit, events }` where `events` are `RecentLogEntry[]` (summary included via `toRecentLogEntry`, so the client renders rows identically to the recent-log panel without a client-side formatter). Optional `?offset` and `?limit` query params default to 0 and 200; invalid params (non-integer, negative, absent) fall back to defaults via `parseNonNegativeInt`. A `?format=text` variant renders the requested page via `formatLogAsText` with `content-disposition: attachment; filename="<runId>.log"`. Returns 404 for an unknown run. The `/log` suffix is matched before the bare `:id` route so it is not swallowed.
- `source/web/render.test.ts` — added tests for `toRecentLogEntry`, `paginateLogEvents` (first page, later page, partial final page, offset past the end, empty log, limit exceeding count), and `formatLogAsText` (one line per event, empty log, malformed payload).
- `source/web/server.test.ts` — added a `run-long` fixture (250 events) and a `GET /api/runs/:id/log` describe block covering the default page, explicit offset/limit, offset past the end (empty page, correct total), invalid params treated as defaults, 404 for an unknown run, the bare `:id` route not regressing, and `format=text` (content-type, content-disposition, body contents, offset/limit honored, 404 for unknown run). Updated the run-list test for the added fixture.
- `source/web/static/app.js` — replaced the fixed recent-log panel with a paginated view. The panel mirrors the run view's `recentLog` as the most-recent page (live while the run is active and the operator has not paged back), and a "Load earlier" button pages backward: the first click probes `?limit=1` to learn the total, then fetches the contiguous page immediately before the tail's oldest index and prepends it; once paged back, the panel freezes the tail so a loaded historical view is not silently jumped forward. "Load earlier" is hidden once the oldest index reaches 0. An "Export" button fetches `?format=text&offset=0&limit=1000000` and downloads the body as `<runId>.log` via a `Blob` and object URL. All rendering stays `h()`/`textContent`; no `innerHTML`.
- `source/web/static/styles.css` — minimal styling for `.log-controls`, `.log-load-earlier`, and `.log-export`.

Deviations / decisions (authoritative):

- **The JSON log endpoint returns `RecentLogEntry[]` (with summary), not bare `LogEvent[]`.** The plan's deliverable 2 said "events are the raw `LogEvent`s for that page (the readable summary is added client-side or via `formatLogEvent`)." Adding the summary server-side via `toRecentLogEntry` keeps a single formatting source of truth (`formatLogEvent` in the tested `render.ts`) and lets the client render rows identically to the existing recent-log panel without porting the formatter to plain browser JS. This is the "via `formatLogEvent`" branch the plan explicitly permitted. The `?format=text` export still operates on the raw events through `formatLogAsText`.
- **Export uses a server-side `?format=text` response rather than the client assembling text from a large JSON page.** The plan's deliverable 4 sketched export as "fetches the full log (large limit) and downloads it as a `.log`/`.txt` file via a `Blob`." Reusing the server-side `formatLogAsText` (a deliverable-1 pure helper) for the text body avoids duplicating the line-formatting logic in the client; the client still downloads via a `Blob` and object URL with a run-id-derived filename, satisfying the security note (no untrusted content in the filename). The export request uses `limit=1000000`, large enough to mean "all" for any realistic run.
- **The log panel freezes the tail once the operator pages back.** In tail mode the panel mirrors `recentLog` and live-refreshes for active runs (preserving the step-17 live activity). After the first "Load earlier", the panel holds its loaded historical range and stops mirroring `recentLog`, so a frozen historical view is not silently jumped forward by newly appended events; the operator can re-select the run to refresh. This trades automatic tail-append-while-browsing-history for a stable, predictable historical view.
- **The first "Load earlier" probes `?limit=1` before fetching the page.** The endpoint pages from offset 0 (oldest), so to page backward contiguously from the most-recent page the client needs the total. A one-event probe learns it; `limit` for the backward page is then exactly the span up to the tail's oldest index, guaranteeing the prepended page is contiguous (no overlap, no gap). Subsequent "Load earlier" clicks reuse the stored oldest index and need no probe.

### Follow-up (2026-06-24) — operator-reported defects

Operator testing against a 200+ event run surfaced three client defects, all fixed in `app.js`:

- **"Load earlier" rendered at the top of the log.** The controls `<div>` was placed before the `<ol>`, so the button sat above the newest events. Moved after the `<ol>` so it sits at the bottom — newest events stay visible at the top and the button reads as "there is more above this point."
- **Export did nothing; uBlock Origin blocked the download.** The original export fetched the text body and synthesized a programmatic `<a download>` click on a `blob:` URL. uBlock Origin's filter lists treat programmatic `blob:`/`data:` downloads not backed by a direct user-gesture link as drive-by downloads and block them, so nothing happened. Replaced with a plain top-level navigation (`window.location.href = <text endpoint>`) in a dedicated Hyperapp effect (`ExportLogFx`): the server's `Content-Disposition: attachment; filename="<runId>.log"` header turns the navigation into a native file download, which is indistinguishable from any other link the operator follows and is not content-filtered. The filename stays server-derived from the run id (no untrusted content). This also removes the no-op action that returned `undefined`.
- **`/api/runs/undefined` polled every second (404).** The per-run subscription predicate was `selectedRunId !== null`, which is `true` when `selectedRunId` is the value `undefined` (a transient state across selection transitions), so `PollSelectedRun` fired and fetched `/api/runs/${encodeURIComponent(undefined)}` → `/api/runs/undefined` → 404, every tick. Tightened both the subscription predicate and the `PollSelectedRun` / `LoadEarlierLog` / `ExportLog` guards to `typeof state.selectedRunId === 'string' && state.selectedRunId !== ''` so a non-string id never produces a fetch. (This was latent in the step-14 client; the log-endpoint work made it visible.)

End-of-step checks: `bun run typecheck` and `bun test source/` pass (385 tests). `grep -n innerHTML source/web/static/` returns nothing. The `/log` suffix route is matched before the `:id` route (covered by a regression test). `paginateLogEvents` handles an empty log and an offset past the end without negative counts or throws (covered). "Load earlier" hides once the oldest index reaches 0 (`canLoadEarlier` returns false for `offset <= 0` and for a tail shorter than the page size) and now renders at the bottom of the log. The export navigates the browser to the text endpoint, whose `Content-Disposition` drives a native `<runId>.log` download that content blockers do not filter. The per-run subscription and `PollSelectedRun` no longer fire on a non-string `selectedRunId`, eliminating the `/api/runs/undefined` 404 spam.

### Follow-up (2026-06-24) — second operator pass

Operator testing surfaced four more defects, all fixed:

- **Export button placement.** Export now sits at the top of the log panel (a persistent whole-log action) and "Load earlier" is the only control at the bottom (it extends the list downward). The shared `.log-controls` row was split into two standalone buttons.
- **In-progress run showed `—` for Task and Started.** `meta.json` was written only at completion (`executor.ts`), so while a run was in progress `meta` was null and `renderRunView` returned `task: null` / `startTime: null`. `runExecutor` now writes a `running` meta (`status: 'running'`, no `endTime`/`result`) before the entry role begins; it is overwritten by the terminal meta on completion. `isRunMeta` already accepts `running`, so the render/list paths surface the task and start time immediately. The executor's fake persistence now records every `writeMeta` call (the happy-path test asserts both the running start meta and the terminal meta are written). This is an executor change but a small, additive one entirely within `runExecutor`'s existing `writeMeta` seam — no new leaf, no dependency change.
- **Log rows appeared out of timestamp order in the UI.** The server returns events chronologically (verified: both `recentLog` and the `/log` endpoint are strictly ordered for chronological input). The misordering was client-side: log rows were keyed by content (`timestamp|type|summary`), which is not unique — many log events share identical (type, role, tool) and millisecond timestamps can collide within a rapid burst. The vendored hyperapp's keyed reconciliation, on a colliding key, runs `insertBefore` against a stale matching node and leaves the DOM in an order that does not match the array order, surfacing as interleaved timestamps in the panel. Replaced the render key with a positional index (`String(renderIndex)`), which is unique per render and makes the diff patch in place, so the DOM order always matches the array order. The expand/collapse toggle still keys on the content-derived `toggleKey` (a row toggled by content expands the right row even after pagination reindexes).

End-of-step checks (second pass): `bun run typecheck` and `bun test source/` pass (385 tests, 993 expect calls; the executor happy-path test gains the running-start-meta assertions). `grep -rn innerHTML source/web/static/` returns nothing. An in-progress run now returns `status: 'running'` with its `task` and `startTime` populated (verified via a synthetic in-progress meta through `GET /api/runs/:id` and `GET /api/runs`), and `endTime`/`result` are null until completion.

No new technical debt introduced. The step-11/step-17 role-activity and log-richness debt rows in `plan/README.md` are untouched (they are closed by step 22).
