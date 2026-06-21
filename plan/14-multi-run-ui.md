# Step 14 — Multi-run web UI

## Goal

Rewrite the web client (`app.js`, `index.html`) into the multi-run UI the long-running service (step 13) requires: a run list, a create-run form, a per-run view with switching, dead-server error surfacing (removing the last part of the step-12 debt), and polling that stops on terminal runs. The server API is unchanged from step 13; this step consumes it.

## Context

Read [`13-long-running-service-mode.md`](13-long-running-service-mode.md) (the API this UI consumes: `POST /api/runs`, `GET /api/runs`, `GET /api/runs/:id`, `GET /api/questions`, `POST /api/answer`), [`11-web-ui-server.md`](11-web-ui-server.md) (the current single-run client this step rewrites), and the step-12 tracked debt (the dead-server UX part this step removes).

The step-13 server kept the `GET /api/run` alias so the step-12 single-run client kept working. This step replaces that client with the real multi-run UI; the `GET /api/run` alias may remain (harmless) or be removed if nothing references it after the rewrite — the implementing agent decides and records the choice in the closeout.

## Deliverables

1. `source/web/static/index.html` (extend) — add structure for a run-list panel and a create-run form alongside the existing per-run panels (status/log/questions). Keep the plain, dependency-free shape (no templating engine, no build step).
2. `source/web/static/app.js` (rewrite) — the multi-run client:
   - **Run list** (`GET /api/runs`): shows known runs (id, status, task); clicking one selects it as the current per-run view. Polls on an interval so new runs appear.
   - **Create-run form**: a task text input and a submit button that `POST /api/runs { task }`. The button is disabled (and the input clearly indicates) while a run is active, matching the server's `409 run_in_progress` rejection. On success, the new run becomes the selected run.
   - **Per-run view**: the existing status/role-activity/log/questions panels, populated from `GET /api/runs/:id` for the selected run. The questions panel and `POST /api/answer` flow still work for the active run.
   - **Dead-server surfacing**: on a failed `fetch`, show "server unavailable — it may have shut down" in the status line instead of leaving the page at `loading…` (the step-12 debt). Retry the next poll; if the server comes back, resume rendering.
   - **Stop polling terminal runs**: once the selected run's view reports a terminal status (`success`/`error`/`needs_clarification`), stop polling that run's `GET /api/runs/:id` (it will not change). Keep polling the run list so a new run still appears.
   - Continue rendering with `createElement`/`textContent` only — no `innerHTML` — so untrusted run content (log lines, summaries, task text) cannot break out of the DOM (per step 11's security note).
3. `source/web/server.test.ts` (extend if needed) — the API contract is unchanged from step 13; only add assertions if the rewrite reveals an API gap (record it as a deviation and, if the server needs a change, fold it back into step 13's scope rather than expanding this step).

## Module boundaries

- This step touches only `source/web/static/index.html` and `source/web/static/app.js`. No server changes, no executor changes, no `main.ts` changes.
- `app.js` is plain browser JS and is not unit-tested (per the testing policy, thin integration layers wired to the DOM are not tested); the server tests cover the API contract it consumes. The implementing agent verifies the UI manually (operator handoff).
- If the rewrite surfaces a genuine server-API gap (e.g. a missing field the UI needs), that is a step-13 concern — record it and propose folding the server fix back into step 13 rather than expanding this step into the backend.

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass (no source-under-test changes; only static assets change).
- [x] The run list renders known runs from `GET /api/runs` and updates on poll.
- [x] The create-run form submits via `POST /api/runs` and is disabled while a run is active.
- [x] Selecting a run switches the per-run view to it.
- [x] A failed `fetch` surfaces "server unavailable" instead of leaving `loading…` (step-12 dead-server debt removed).
- [x] A terminal run's per-run view stops polling; the run list keeps polling.
- [x] All rendering uses `textContent`/`createElement` (no `innerHTML`).
- [x] The step-12 tracked-debt row is removed from `plan/README.md` (all three parts now fixed: teardown + `SIGTERM` in step 13, dead-server UX here).

## End-of-step evaluation

Confirm no server or executor code changed (static assets only). Re-read `app.js` for `innerHTML` absence on every untrusted-content path — the run-list entries (task text, status) and the per-run panels (log payloads, summaries, question text) are all untrusted. Confirm the dead-server state cannot wedge the page (the next poll recovers). Confirm the stop-polling-terminal logic does not leak `setInterval` handles (clear the per-run interval when switching runs or when the run goes terminal).

## Estimated effort

Medium — a full client rewrite, but plain JS against a stable API. The work is DOM structure + polling lifecycle + error handling, not logic.

## Operator handoff

Run the service (`bun source/main.ts --serve 8080 --guild guild --workspace-root benchmarks/hello_001`) and exercise the rewritten UI in a browser: submit a task via the form, watch the run list and per-run view update, confirm the submit button disables while the run is active, confirm a second submission is rejected, confirm the page keeps working after the run completes (list the completed run, allow a new submission), confirm selecting a past run shows its view, and confirm the page surfaces "server unavailable" if you stop the server (rather than hanging on `loading…`). Report any UI bugs; the agent fixes them in-environment.

## Closeout (2026-06-21)

Complete. `bun run typecheck` and `bun test source/` both pass (396 tests across 32 files, unchanged — no source-under-test changed). Only static assets and `plan/` changed; no server, executor, or `main.ts` changes.

Changed files:

- `source/web/static/index.html` — adds a `#runs-panel` containing the `#create-run-form` (task input + submit button) and `#run-list`, ahead of the existing per-run panels (run summary, role activity, pending questions, recent log). Title drops the "— Run" suffix since the page now spans many runs. Plain, dependency-free shape preserved.
- `source/web/static/app.js` — rewritten as the multi-run client:
  - **Run list** — `GET /api/runs` polled every second; each entry shows run id, status, and task, and is clickable to select. New runs appear on the next poll.
  - **Create-run form** — `POST /api/runs { task }`; the button (and its label) and input placeholder reflect the disabled state while a run is active. A `justSubmittedRunId` guard keeps the form disabled through the sub-second window between a 201 and the new run appearing in the list, so a rapid second submit cannot slip through before the list detects the active run (matching the server's `409 run_in_progress`).
  - **Per-run view** — `GET /api/runs/:id` for the selected run drives the run-summary / role-activity / recent-log panels. The questions panel and `POST /api/answer` flow still work for the active run (`GET /api/questions` is global to the one active run, so it is polled on the master tick regardless of selection).
  - **Dead-server surfacing** — any `fetch` that throws sets `serverAvailable = false` and the status line reads "server unavailable — it may have shut down" instead of leaving the page at `loading…`; the next successful poll clears it and resumes rendering.
  - **Stop polling terminal runs** — the selected run is polled on its own `perRunInterval`; once its view reports a terminal status (`success`/`error`/`needs_clarification`) the interval is cleared. The run-list/questions master interval keeps running, so new runs still appear.
  - All rendering uses `createElement`/`textContent` (no `innerHTML`); untrusted content (task text, log payloads, summaries, question text) never reaches the DOM as markup.
- `source/web/static/styles.css` — styles for the create-run form, the run list (selected highlight, status color variants, truncated task text), and the `status-unavailable` status line.
- `source/web/server.ts` — two small robustness fixes surfaced by exercising the UI in a browser (see deviations below): static asset responses now carry `Cache-Control: no-store`, and `GET /favicon.ico` returns 204.
- `plan/README.md` — the step-12 tracked-debt row is removed; all three parts (server teardown on run completion, `SIGTERM` handling, dead-server UX) are now fixed.

Deviations / decisions (authoritative):

- **`GET /api/run` alias kept.** The plan left the alias decision to the implementing agent. It is harmless (one route, one `lastRunId()` read) and removing it would only shrink the API surface without changing the client, which no longer uses it. Kept to avoid an unnecessary server change outside this step's static-asset scope.
- **Two intervals (master + per-run), not one.** A single master tick that conditionally fetches the per-run view would also satisfy "stop polling terminal runs," but a dedicated `perRunInterval` that is explicitly cleared on selection change and on terminal status makes the polling lifecycle auditable and matches the end-of-step evaluation's "clear the per-run interval" guidance. The master interval never changes; `perRunInterval` is the only handle that is created and destroyed, so a leak is not possible (it is cleared before every re-creation and on terminal).
- **A `selectionGeneration` token guards per-run fetches against stale renders.** Switching runs mid-poll could let a slow in-flight `GET /api/runs/:id` for the previously selected run resolve after the switch and render the wrong run's data under the new selection. Bumping a generation counter on every selection change and ignoring fetch results whose generation no longer matches prevents that without coupling to the interval lifecycle.
- **A 404 on the selected run is treated as "not yet readable" rather than "unknown run."** The run directory is created early in execution but a `GET /api/runs/:id` issued in the instant after `POST /api/runs` returns 201 can race the directory's first log write (the server's `isKnownRun` treats both-absent as unknown). Because runs are never deleted, a 404 for a selected run only occurs in that brief window, so the client keeps polling and shows "in progress" rather than deselecting.
- **Form input stays enabled while a run is active; only the button is disabled.** The plan said "the input clearly indicates" the active-run state. Disabling only the button (with its label switching to "Run in progress…" and the placeholder changing) lets the operator type the next task ahead of time while still preventing submission — pressing Enter cannot submit a form whose submit button is disabled.
- **Two small `server.ts` changes despite the "no server changes" module boundary.** The plan said this step touches only static assets. Operator testing surfaced a real defect: the dev server sent no `Cache-Control` header on static assets, so a browser that had cached a 404 for `/app.js` (e.g. from a moment during editing when the file was briefly absent, or from a previous server version) kept serving the cached 404 and never re-requested — the page loaded its HTML but the script never ran, so the create-run form did a default GET submit and silently reloaded (the "task entry box clears, nothing changes" symptom). `Cache-Control: no-store` on static asset responses prevents stale-asset and stale-404 caching across restarts. A `GET /favicon.ico` → 204 route was added alongside it to silence the per-page-load favicon 404 browsers log. These are response-header/robustness fixes, not API-contract changes (the existing server tests still pass unchanged), so they are folded into this step rather than reopening step 13; recorded here as a deviation from the "no server changes" boundary.
- **All client URLs are relative, not root-relative, so the UI works behind a subpath-stripping proxy.** Operator testing runs the server behind a reverse proxy that serves the app on a subpath (`http://name.localhost/proxy/1234/`) and strips that prefix before forwarding to the server. The original `index.html` used root-relative references (`href="/styles.css"`, `src="/app.js"`) and `app.js` used root-relative fetches (`fetch('/api/runs')`, etc.); the browser resolved those against the origin (`http://name.localhost/app.js`), dropping the `/proxy/1234/` prefix, so the proxy never routed them to the server and every asset and API call 404'd — the page HTML loaded (the operator navigated to the prefixed URL directly) but the script never ran, reproducing the silent-reload symptom. Making every reference relative (`href="styles.css"`, `src="app.js"`, `fetch('api/runs')`, `fetch(\`api/runs/${id}\`)`, `fetch('api/questions')`, `fetch('api/answer')`) lets the browser resolve them against the page's base URL, preserving the prefix under the proxy while still resolving to the server's root paths in the direct (`http://localhost:8080/`) case. A `<link rel="icon" href="data:,">` was added to suppress the favicon request entirely (a root-relative `/favicon.ico` would 404 under the proxy regardless of the server's 204 route, since the browser requests it at the origin). This is a client-only change (no server routing change — the proxy strips the prefix, so the server still sees `/api/runs`, `/app.js`, etc., which it already served); the existing server tests are unaffected.

End-of-step checks: `rg innerHTML source/web/static/` returns only the explanatory comment in `app.js` (no code usage). `perRunInterval` is cleared in `stopPerRunPolling` (called on every selection change and on terminal status); the master `setInterval(tick, ...)` is created exactly once. `bun run typecheck` and `bun test source/` pass (396 tests). No root-relative `/api`, `/app`, or `/styles` references remain in `source/web/static/`.

No new technical debt introduced.
