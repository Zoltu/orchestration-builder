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

- [ ] `bun run typecheck` and `bun test source/` pass (no source-under-test changes; only static assets change).
- [ ] The run list renders known runs from `GET /api/runs` and updates on poll.
- [ ] The create-run form submits via `POST /api/runs` and is disabled while a run is active.
- [ ] Selecting a run switches the per-run view to it.
- [ ] A failed `fetch` surfaces "server unavailable" instead of leaving `loading…` (step-12 dead-server debt removed).
- [ ] A terminal run's per-run view stops polling; the run list keeps polling.
- [ ] All rendering uses `textContent`/`createElement` (no `innerHTML`).
- [ ] The step-12 tracked-debt row is removed from `plan/README.md` (all three parts now fixed: teardown + `SIGTERM` in step 13, dead-server UX here).

## End-of-step evaluation

Confirm no server or executor code changed (static assets only). Re-read `app.js` for `innerHTML` absence on every untrusted-content path — the run-list entries (task text, status) and the per-run panels (log payloads, summaries, question text) are all untrusted. Confirm the dead-server state cannot wedge the page (the next poll recovers). Confirm the stop-polling-terminal logic does not leak `setInterval` handles (clear the per-run interval when switching runs or when the run goes terminal).

## Estimated effort

Medium — a full client rewrite, but plain JS against a stable API. The work is DOM structure + polling lifecycle + error handling, not logic.

## Operator handoff

Run the service (`bun source/main.ts --serve 8080 --guild guild --workspace-root benchmarks/hello_001`) and exercise the rewritten UI in a browser: submit a task via the form, watch the run list and per-run view update, confirm the submit button disables while the run is active, confirm a second submission is rejected, confirm the page keeps working after the run completes (list the completed run, allow a new submission), confirm selecting a past run shows its view, and confirm the page surfaces "server unavailable" if you stop the server (rather than hanging on `loading…`). Report any UI bugs; the agent fixes them in-environment.
